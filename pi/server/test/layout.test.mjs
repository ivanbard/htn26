import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../server.mjs";
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

async function withRuntime(fetchImpl, callback) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "htn26-layout-"));
  const runtime = await createRuntime({ dataDir, env: { OPENAI_API_KEY: "test-key" }, fetchImpl, now: () => 10_000 });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  try { return await callback(`http://127.0.0.1:${address.port}`, runtime); }
  finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
}

async function formPhotos(base, count = 3) {
  const form = new FormData();
  for (let index = 0; index < count; index += 1) form.append("photos", new Blob([`photo-${index}`], { type: "image/jpeg" }), `room-${index}.jpg`);
  return fetch(`${base}/api/layout/generate`, { method: "POST", body: form, headers: { accept: "application/json" } });
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
  });
});

test("generation failure is generic and does not expose provider errors", async () => {
  await withRuntime(async () => responseFor({ error: { message: "secret upstream details" } }, false, 500), async (base) => {
    const response = await formPhotos(base, 3);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: "Room layout generation is unavailable. Try again." });
    assert.doesNotMatch(JSON.stringify(body), /secret|OpenAI|upstream/i);
  });
});
