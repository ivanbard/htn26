import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../server.mjs";
import { LayoutSubmissionStore } from "../src/layout-submission-store.mjs";
import {
  REQUIRED_STATION_TYPES,
  sanitizeRoomLayout,
  sanitizeRotatedRect,
  validateRoomLayout,
} from "../src/layout-schema.mjs";

function candidate() {
  return {
    presentationArea: { center: { x: 0.5, y: 0.08 }, width: 0.7, height: 0.12, rotationDeg: 180 },
    objects: [{ id: "desk-1", type: "teaching_desk", usableSurface: true, center: { x: 0.5, y: 0.3 }, width: 0.2, height: 0.1, rotationDeg: 12 }],
    playArea: { center: { x: 0.5, y: 0.6 }, width: 0.8, height: 0.6, rotationDeg: 0 },
    stations: REQUIRED_STATION_TYPES.map((type, index) => ({ type, supportObjectId: "desk-1", center: { x: 0.2 + index * 0.2, y: 0.8 }, width: 0.1, height: 0.08, rotationDeg: 0 })),
  };
}

function responseFor(value, ok = true, status = 200) {
  return { ok, status, async json() { return value; } };
}

async function withRuntime(fetchImpl, callback, env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "htn26-layout-"));
  const runtime = await createRuntime({ dataDir, env: { OPENAI_API_KEY: "test-key", ...env }, fetchImpl, now: () => 10_000 });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  try { return await callback(`http://127.0.0.1:${address.port}`, runtime); }
  finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
}

async function formPhotos(base, count = 3, headers = {}) {
  const form = new FormData();
  for (let index = 0; index < count; index += 1) form.append("photos", new Blob([`photo-${index}`], { type: "image/jpeg" }), `room-${index}.jpg`);
  return fetch(`${base}/api/layout/generate`, { method: "POST", body: form, headers: { accept: "application/json", ...headers } });
}

test("sanitizes rotated geometry, boundaries, and normalized rotation", () => {
  const rect = sanitizeRotatedRect({ center: { x: 5, y: -2 }, width: 4, height: 3, rotationDeg: -45 });
  assert.equal(rect.rotationDeg, 135);
  assert.ok(rect.width <= 1 && rect.height <= 1);
  const radians = rect.rotationDeg * Math.PI / 180;
  const extentX = (Math.abs(Math.cos(radians)) * rect.width + Math.abs(Math.sin(radians)) * rect.height) / 2;
  const extentY = (Math.abs(Math.sin(radians)) * rect.width + Math.abs(Math.cos(radians)) * rect.height) / 2;
  assert.ok(rect.center.x >= extentX && rect.center.x <= 1 - extentX);
  assert.ok(rect.center.y >= extentY && rect.center.y <= 1 - extentY);
  assert.ok(rect.center.x - extentX >= 0 && rect.center.x + extentX <= 1);
  assert.ok(rect.center.y - extentY >= 0 && rect.center.y + extentY <= 1);
});

test("keeps exactly four unique station types and cleans invalid support objects", () => {
  const raw = candidate();
  raw.objects.push({ ...raw.objects[0], id: "desk-1" });
  raw.stations[0].supportObjectId = "missing";
  raw.stations[1].supportObjectId = "desk-1";
  raw.stations.push({ type: "stove", supportObjectId: "desk-1" });
  const layout = sanitizeRoomLayout(raw);
  assert.deepEqual(Object.keys(layout).sort(), ["objects", "playArea", "presentationArea", "stations"]);
  assert.deepEqual(layout.stations.map((station) => station.type), REQUIRED_STATION_TYPES);
  assert.equal(layout.objects.length, 1);
  assert.equal(layout.stations[0].supportObjectId, null);
  assert.equal(layout.stations[1].supportObjectId, "desk-1");
  assert.deepEqual(validateRoomLayout(layout), []);
});

test("sends all photos in one Responses request and returns the exact layout contract", async () => {
  let calls = 0;
  let request;
  await withRuntime(async (_url, options) => {
    calls += 1;
    request = JSON.parse(options.body);
    return responseFor({ output_text: JSON.stringify(candidate()) });
  }, async (base, runtime) => {
    const response = await formPhotos(base, 5);
    const layout = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(layout).sort(), ["objects", "playArea", "presentationArea", "stations"]);
    assert.equal(layout.stations.length, 4);
    assert.equal(calls, 1);
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.reasoning.effort, "low");
    assert.equal(request.input.length, 1);
    assert.equal(request.input[0].content.length, 5);
    assert.ok(request.input[0].content.every((image) => image.type === "input_image" && image.detail === "low"));
    assert.equal(request.tools, undefined);
    assert.equal(request.text.format.type, "json_schema");
    assert.equal(request.text.format.strict, true);
    assert.equal(runtime.projection.snapshot().roomLayout.stations.length, 4);
    assert.equal(runtime.projection.snapshot().floorPlan.photoCount, 5);
  });
});

test("retains isolated audit submissions across failure and retry", async () => {
  let attempts = 0;
  await withRuntime(async () => {
    attempts += 1;
    return attempts === 1
      ? responseFor({ error: { message: "secret upstream details" } }, false, 500)
      : responseFor({ output_text: JSON.stringify(candidate()) });
  }, async (base, runtime) => {
    const failedResponse = await formPhotos(base, 5, { "x-htn26-photo-preprocess-ms": "42" });
    const failedBody = await failedResponse.json();
    assert.equal(failedResponse.status, 503);
    assert.deepEqual(failedBody, { error: "Room layout generation is unavailable. Try again." });
    assert.doesNotMatch(JSON.stringify(failedBody), /secret|OpenAI|upstream/i);

    const successfulResponse = await formPhotos(base, 5, { "x-htn26-photo-preprocess-ms": "21" });
    assert.equal(successfulResponse.status, 200);
    await successfulResponse.json();

    const legacyResponse = await fetch(`${base}/api/photos`);
    const legacyPhotos = await legacyResponse.json();
    assert.equal(legacyResponse.headers.get("deprecation"), "true");
    assert.equal(legacyPhotos.count, 0);
    const audit = await fetch(`${base}/api/layout/submissions`).then((response) => response.json());
    assert.equal(audit.submissions.length, 2);
    assert.deepEqual(audit.submissions.map(({ status }) => status), ["failure", "success"]);
    assert.deepEqual(audit.submissions.map(({ photoCount }) => photoCount), [5, 5]);
    assert.notEqual(audit.submissions[0].requestId, audit.submissions[1].requestId);
    assert.equal(failedResponse.headers.get("x-htn26-layout-request-id"), audit.submissions[0].requestId);
    assert.equal(successfulResponse.headers.get("x-htn26-layout-audit-folder"), audit.submissions[1].folder);
    assert.equal(audit.submissions[0].metrics.preprocessMs, 42);
    assert.equal(audit.submissions[1].metrics.preprocessMs, 21);
    assert.ok(audit.submissions[0].metrics.totalMs >= 42);
    assert.ok(audit.submissions[1].metrics.totalMs >= 21);
    assert.equal(audit.submissions[0].metrics.validationMs, null);
    assert.doesNotMatch(failedResponse.headers.get("server-timing"), /validation/);
    assert.deepEqual(Object.keys(audit.submissions[0].metrics).sort(), ["preprocessMs", "requestMs", "totalMs", "validationMs"]);
    assert.deepEqual(audit.submissions[0].failure, { code: "generation_unavailable" });
    assert.equal(audit.submissions[1].failure, null);
    assert.doesNotMatch(JSON.stringify(audit), /secret upstream details|test-key/i);

    for (const submission of audit.submissions) {
      const persisted = JSON.parse(await readFile(path.join(runtime.directory, submission.folder, "metadata.json"), "utf8"));
      assert.equal(persisted.requestId, submission.requestId);
      assert.equal(persisted.photos.length, 5);
      assert.equal(persisted.status, submission.status);
    }
  });
});

test("times out an unavailable provider with a safe audited failure", async () => {
  await withRuntime((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), async (base) => {
    const response = await formPhotos(base, 3, { "x-htn26-photo-preprocess-ms": "7" });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: "Room layout generation is unavailable. Try again." });
    const audit = await fetch(`${base}/api/layout/submissions`).then((value) => value.json());
    assert.equal(audit.submissions[0].status, "failure");
    assert.equal(audit.submissions[0].metrics.preprocessMs, 7);
    assert.ok(audit.submissions[0].metrics.requestMs >= 1);
    assert.equal(audit.submissions[0].metrics.validationMs, null);
    assert.ok(audit.submissions[0].metrics.totalMs >= 8);
  }, { OPENAI_LAYOUT_TIMEOUT_MS: "5" });
});

test("reconciles interrupted and corrupt audit submissions on restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "htn26-layout-recovery-"));
  try {
    const firstStore = new LayoutSubmissionStore({ directory: dataDir, now: () => 10_000 });
    await firstStore.init();
    const uploads = Array.from({ length: 3 }, (_, index) => ({
      bytes: Buffer.from(`photo-${index}`),
      filename: `room-${index}.jpg`,
      mime: "image/jpeg",
    }));
    const interrupted = await firstStore.create(uploads, { preprocessMs: 12 });

    const restartedStore = new LayoutSubmissionStore({ directory: dataDir, now: () => 20_000 });
    await restartedStore.init();
    assert.equal(restartedStore.list()[0].status, "failure");
    assert.deepEqual(restartedStore.list()[0].failure, { code: "generation_interrupted" });
    assert.equal(restartedStore.list()[0].metrics.preprocessMs, 12);

    await writeFile(path.join(dataDir, interrupted.folder, "metadata.json"), "{incomplete");
    const recoveredStore = new LayoutSubmissionStore({ directory: dataDir, now: () => 30_000 });
    await recoveredStore.init();
    const recovered = recoveredStore.list()[0];
    assert.equal(recovered.status, "failure");
    assert.equal(recovered.photoCount, 3);
    assert.deepEqual(recovered.failure, { code: "generation_interrupted" });
    assert.deepEqual(recovered.metrics, { preprocessMs: null, requestMs: null, validationMs: null, totalMs: null });
    const metadata = JSON.parse(await readFile(path.join(dataDir, recovered.folder, "metadata.json"), "utf8"));
    assert.equal(metadata.status, "failure");
    assert.equal(metadata.photos.length, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
