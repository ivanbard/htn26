import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../server.mjs";
import { ServerProjection } from "../src/projection.mjs";
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

async function slowMultipartPhotos(base, { count = 3, delayMs = 20, preprocessMs = 0 } = {}) {
  const boundary = "----WebKitFormBoundaryAbCdEf123456";
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    sections.push(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="room-${index}.jpg"\r\nContent-Type: image/jpeg\r\n\r\nphoto-${index}\r\n`);
  }
  sections.push(`--${boundary}--\r\n`);
  const body = Buffer.from(sections.join(""));
  const split = Math.floor(body.length / 2);
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL("/api/layout/generate", base), {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": body.length,
        "x-htn26-photo-preprocess-ms": String(preprocessMs),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.write(body.subarray(0, split));
    setTimeout(() => request.end(body.subarray(split)), delayMs);
  });
}

function connectSse(base) {
  let buffer = "";
  const states = [];
  const waiters = [];
  let resolveConnected;
  let rejectConnected;
  const connected = new Promise((resolve, reject) => { resolveConnected = resolve; rejectConnected = reject; });
  const request = httpRequest(new URL("/api/events", base), { headers: { accept: "text/event-stream" } }, (response) => {
    if (response.statusCode !== 200) {
      rejectConnected(new Error(`SSE connection failed (${response.statusCode})`));
      return;
    }
    resolveConnected();
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      buffer += chunk;
      let separator;
      while ((separator = buffer.match(/\r?\n\r?\n/))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = frame.split(/\r?\n/).find((line) => line.startsWith("data: "));
        if (!data) continue;
        const state = JSON.parse(data.slice(6));
        const waiter = waiters.shift();
        if (waiter) waiter(state);
        else states.push(state);
      }
    });
  });
  request.on("error", (error) => rejectConnected(error));
  request.end();
  return {
    connected,
    nextState() { return states.length ? Promise.resolve(states.shift()) : new Promise((resolve) => waiters.push(resolve)); },
    close() { request.destroy(); },
  };
}

test("keeps schema version stable and revision monotonic across reset and snapshots", async () => {
  await withRuntime(async () => responseFor({ output_text: JSON.stringify(candidate()) }), async (_base, runtime) => {
    const initial = runtime.projection.snapshot();
    runtime.projection.command("START_HOST");
    const started = runtime.projection.snapshot();
    runtime.projection.command("RESET_GAME");
    const reset = runtime.projection.snapshot();
    runtime.projection.applyAuthoritativeSnapshot({ ...reset, revision: 0 }, 20_000);
    const adopted = runtime.projection.snapshot();
    assert.ok(initial.revision < started.revision);
    assert.ok(started.revision < reset.revision);
    assert.ok(reset.revision < adopted.revision);
    assert.ok([initial, started, reset, adopted].every((snapshot) => snapshot.version === 2));
  });
});

test("successful phone generation publishes the canonical proposal and photos over SSE", async () => {
  await withRuntime(async () => responseFor({ output_text: JSON.stringify(candidate()) }), async (base) => {
    const stream = connectSse(base);
    try {
      await stream.connected;
      const initial = await stream.nextState();
      assert.equal(initial.setup.phase, "idle");
      const response = await formPhotos(base, 4);
      assert.equal(response.status, 200);
      const update = await stream.nextState();
      assert.equal(update.setup.phase, "layout-proposed");
      assert.equal(update.setup.photoCount, 4);
      assert.equal(update.photos.length, 4);
      assert.equal(update.floorPlan.photoCount, 4);
      assert.equal(update.floorPlan.layoutFromImage, true);
      assert.equal(update.proposedRoomLayout.stations.length, 4);
    } finally {
      stream.close();
    }
  });
});

test("desktop generation reuses stored photos without duplicating the canonical batch", async () => {
  await withRuntime(async () => responseFor({ output_text: JSON.stringify(candidate()) }), async (base, runtime) => {
    for (let index = 0; index < 4; index += 1) {
      const upload = await fetch(`${base}/api/photos`, {
        method: "POST",
        headers: { "content-type": "image/jpeg", "x-photo-name": `room-${index}.jpg` },
        body: Buffer.from(`photo-${index}`),
      });
      assert.equal(upload.status, 201);
    }
    const response = await fetch(`${base}/api/layout/generate`, { method: "POST", headers: { accept: "application/json" } });
    assert.equal(response.status, 200);
    const state = runtime.projection.snapshot();
    assert.equal(state.photos.length, 4);
    assert.equal((await fetch(`${base}/api/photos`).then((value) => value.json())).count, 4);
  });
});

test("replaces the proposed layout without discarding the approved layout", () => {
  const instance = new ServerProjection({ now: () => 1_000 });
  const first = candidate();
  instance.proposeRoomLayout(first, 1_000);
  instance.approveFloorplan(true, 1_000);
  const active = instance.snapshot().roomLayout;
  const second = structuredClone(first);
  second.playArea.center = { x: 0.4, y: 0.6 };
  instance.proposeRoomLayout(second, 2_000);
  const proposed = instance.snapshot();
  assert.deepEqual(proposed.roomLayout, active);
  assert.deepEqual(proposed.proposedRoomLayout.playArea.center, { x: 0.4, y: 0.6 });
  assert.equal(proposed.floorPlan.accepted, false);
  assert.throws(() => instance.command("START_GAME"), /approve the floorplan/);
  instance.approveFloorplan(true, 2_000);
  assert.deepEqual(instance.snapshot().roomLayout.playArea.center, { x: 0.4, y: 0.6 });
});

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
  const generated = candidate();
  generated.stations[0] = {
    ...generated.stations[0],
    center: { x: 0.95, y: 0.5 },
    width: 0.2,
    height: 0.05,
    rotationDeg: 90,
  };
  generated.stations[1] = { ...generated.stations[0] };
  await withRuntime(async (_url, options) => {
    calls += 1;
    request = JSON.parse(options.body);
    return responseFor({ output_text: JSON.stringify(generated) });
  }, async (base, runtime) => {
    const previousStations = runtime.projection.snapshot().stations;
    const response = await formPhotos(base, 5);
    const layout = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(layout).sort(), ["objects", "playArea", "presentationArea", "stations"]);
    assert.equal(layout.stations.length, 4);
    assert.deepEqual(layout.stations.map(({ type }) => type), REQUIRED_STATION_TYPES);
    assert.deepEqual(validateRoomLayout(layout), []);
    assert.equal(calls, 1);
    assert.equal(request.model, "gpt-5.6-luna");
    assert.equal(request.reasoning.effort, "low");
    assert.equal(request.input.length, 1);
    assert.equal(request.input[0].content.length, 5);
    assert.ok(request.input[0].content.every((image) => image.type === "input_image" && image.detail === "low"));
    assert.equal(request.tools, undefined);
    assert.equal(request.text.format.type, "json_schema");
    assert.equal(request.text.format.strict, true);
    const proposedState = runtime.projection.snapshot();
    assert.equal(proposedState.photos.length, 5);
    assert.equal(proposedState.setup.photoCount, 5);
    assert.equal(proposedState.roomLayout, null);
    assert.equal(proposedState.proposedRoomLayout.stations.length, 4);
    assert.equal(proposedState.proposedRoomLayout.stations[0].rotationDeg, 90);
    assert.equal(proposedState.proposedRoomLayout.stations[0].width, 0.2);
    assert.equal(proposedState.proposedRoomLayout.stations[0].height, 0.05);
    assert.equal(proposedState.setup.phase, "layout-proposed");
    assert.equal(proposedState.burgerLevel.status, "not-generated");
    assert.deepEqual(proposedState.stations, previousStations);
    assert.throws(() => runtime.projection.command("START_GAME"), /approve the floorplan/);
    const scan = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "SCAN_ROOM" }),
    });
    assert.equal(scan.status, 400);
    assert.match((await scan.json()).error, /layout\/generate/);
    assert.equal(runtime.projection.snapshot().proposedRoomLayout.stations.length, 4);
    assert.equal(await fetch(`${base}/api/layout`).then((active) => active.json()), null);
    const floorPlan = proposedState.floorPlan;
    assert.equal(floorPlan.accepted, false);
    assert.equal(floorPlan.photoCount, 5);
    assert.equal(floorPlan.layoutFromImage, true);
    assert.equal(floorPlan.coordinateSpace, "normalized-percent");
    assert.equal(floorPlan.units, "percent");
    assert.equal(floorPlan.width, 100);
    assert.equal(floorPlan.height, 100);
    assert.ok(Math.abs(floorPlan.stations[0].x - 92.5) < Number.EPSILON * 100);
    assert.ok(Math.abs(floorPlan.stations[0].width - 5) < Number.EPSILON * 100);
    assert.equal(floorPlan.stations[0].rotationDeg, 0);
    assert.ok(floorPlan.stations.every((station) => station.x + station.width <= 100));
    assert.ok(floorPlan.stations.every((station) => station.y + station.height <= 100));

    const approvalResponse = await fetch(`${base}/api/floorplan/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    const approvedState = await approvalResponse.json();
    assert.equal(approvalResponse.status, 200);
    assert.equal(approvedState.floorPlan.accepted, true);
    assert.equal(approvedState.setup.phase, "burger-placement");
    assert.equal(approvedState.burgerLevel.status, "placement-ready");
    assert.equal(approvedState.proposedRoomLayout, null);
    assert.deepEqual(approvedState.roomLayout, layout);
    assert.equal(approvedState.stations.length, 4);
    assert.deepEqual(await fetch(`${base}/api/layout`).then((active) => active.json()), layout);
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
    assert.deepEqual(runtime.projection.snapshot().photos, []);
    assert.equal(runtime.projection.snapshot().floorPlan.photoCount, 0);

    const successfulResponse = await formPhotos(base, 5, { "x-htn26-photo-preprocess-ms": "21" });
    assert.equal(successfulResponse.status, 200);
    await successfulResponse.json();

    const legacyResponse = await fetch(`${base}/api/photos`);
    const legacyPhotos = await legacyResponse.json();
    assert.equal(legacyResponse.headers.get("deprecation"), "true");
    assert.equal(legacyPhotos.count, 5);
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

test("preserves mixed-case multipart boundaries and endpoint-wide timing", async () => {
  let attempts = 0;
  await withRuntime(async () => {
    attempts += 1;
    return attempts === 1
      ? responseFor({ output_text: JSON.stringify(candidate()) })
      : responseFor({ error: { message: "provider detail" } }, false, 500);
  }, async (base, runtime) => {
    const create = runtime.layoutSubmissionStore.create.bind(runtime.layoutSubmissionStore);
    runtime.layoutSubmissionStore.create = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return create(...args);
    };
    const finish = runtime.layoutSubmissionStore.finish.bind(runtime.layoutSubmissionStore);
    runtime.layoutSubmissionStore.finish = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return finish(...args);
    };

    const success = await slowMultipartPhotos(base, { preprocessMs: 11 });
    const failure = await slowMultipartPhotos(base, { preprocessMs: 7 });
    assert.equal(success.status, 200);
    assert.deepEqual(Object.keys(success.body).sort(), ["objects", "playArea", "presentationArea", "stations"]);
    assert.equal(failure.status, 503);
    assert.deepEqual(failure.body, { error: "Room layout generation is unavailable. Try again." });
    assert.equal(attempts, 2);

    const audit = await fetch(`${base}/api/layout/submissions`).then((response) => response.json());
    assert.deepEqual(audit.submissions.map(({ status }) => status), ["success", "failure"]);
    assert.ok(audit.submissions[0].metrics.totalMs >= 51);
    assert.ok(audit.submissions[1].metrics.totalMs >= 47);
    assert.equal(JSON.parse(success.headers["x-htn26-layout-metrics"]).totalMs, audit.submissions[0].metrics.totalMs);
    assert.equal(JSON.parse(failure.headers["x-htn26-layout-metrics"]).totalMs, audit.submissions[1].metrics.totalMs);
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

test("includes response body consumption in request timing", async () => {
  let attempts = 0;
  await withRuntime(async () => {
    attempts += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (attempts === 2) throw new Error("body read failed");
        return { output_text: JSON.stringify(candidate()) };
      },
    };
  }, async (base) => {
    const success = await formPhotos(base, 3);
    const failure = await formPhotos(base, 3);
    assert.equal(success.status, 200);
    assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), { error: "Room layout generation is unavailable. Try again." });
    const audit = await fetch(`${base}/api/layout/submissions`).then((response) => response.json());
    assert.deepEqual(audit.submissions.map(({ status }) => status), ["success", "failure"]);
    assert.ok(audit.submissions[0].metrics.requestMs >= 15);
    assert.ok(audit.submissions[1].metrics.requestMs >= 15);
    assert.equal(audit.submissions[1].metrics.validationMs, null);
  });
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
