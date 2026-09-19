import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSerialStreamAdapter, parseGatewayRxLine } from "../src/protocol.mjs";
import { LocalFloorplanProvider } from "../src/provider.mjs";
import { BURGER_RECIPES, ServerProjection } from "../src/projection.mjs";
import { createRuntime } from "../server.mjs";
import { openSerialDevice } from "../src/serial-device.mjs";

const MAC = "AA:BB:CC:DD:EE:01";

async function withRuntime(callback) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "htn26-server-"));
  const runtime = await createRuntime({ dataDir, env: {}, now: () => Date.now() });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  try { return await callback(`http://127.0.0.1:${address.port}`); }
  finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
}

async function post(base, route, body, headers = { "content-type": "application/json" }) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { response, data: await response.json() };
}

async function approveAndStart(base) {
  for (let index = 0; index < 3; index += 1) {
    const upload = await post(base, "/api/photos", Buffer.from(`JPEG-FIXTURE-${index}`), { "content-type": "image/jpeg", "x-photo-name": `room-${index}.jpg` });
    assert.equal(upload.response.status, 201);
  }
  const host = await post(base, "/api/command", { type: "START_HOST" });
  assert.equal(host.response.status, 200);
  const scan = await post(base, "/api/command", { type: "SCAN_ROOM" });
  assert.equal(scan.response.status, 200);
  assert.equal(scan.data.setup.phase, "layout-proposed");
  const review = await post(base, "/api/floorplan/review", {});
  assert.equal(review.response.status, 200);
  assert.equal(review.data.floorPlan.stations.length, 4);
  const approval = await post(base, "/api/floorplan/approve", { approved: true });
  assert.equal(approval.response.status, 200);
  const started = await post(base, "/api/command", { type: "START_GAME" });
  assert.equal(started.response.status, 200);
  return started.data;
}

test("fixture parser accepts noisy and chunk-framed gateway records", async () => {
  const fixture = await readFile(new URL("./fixtures/gateway-events.ndjson", import.meta.url));
  const records = [];
  const adapter = createSerialStreamAdapter({ onRecord: (record) => records.push(record) });
  for (let offset = 0; offset < fixture.length; offset += 7) adapter.push(fixture.subarray(offset, offset + 7));
  adapter.flush();
  assert.equal(records.length, 6);
  assert.equal(records[0].kind, "gateway-status");
  assert.equal(records[1].intent.value, "START");
  assert.equal(records[2].intent.senderMac, MAC.replace("01", "02"));
  assert.equal(adapter.stats().malformed, 1);
  const fixedPlayer = parseGatewayRxLine("debug HTN26|RX|AA:BB:CC:DD:EE:02|-46|OC1|000043|E|P2:PU:R");
  assert.equal(fixedPlayer.ok, true);
  assert.equal(fixedPlayer.intent.value, "P2:PU:R");
  assert.equal(parseGatewayRxLine("debug HTN26|RX|bad|-1|OC1|1|H|START").ok, false);
});

test("configurable serial-device adapter opens a fixture stream", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "htn26-serial-"));
  const devicePath = path.join(directory, "usb-serial.fixture");
  await writeFile(devicePath, "driver noise HTN26|GW|UP|2|0\n");
  let device;
  const record = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { device?.close(); reject(new Error("serial fixture did not produce a record")); }, 1_000);
    timeout.unref();
    device = openSerialDevice(devicePath, { onRecord: (value) => { clearTimeout(timeout); device.close(); resolve(value); }, onError: reject });
  });
  assert.equal(record.kind, "gateway-status");
  assert.equal(record.status.packetCount, 2);
  await rm(directory, { recursive: true, force: true });
});

test("projection keeps four recipes, validates submissions, and computes gold/tips", async () => {
  assert.deepEqual(BURGER_RECIPES.map((recipe) => recipe.id), ["PLAIN_MEAT", "CHEESEBURGER", "LETTUCE_MEAT", "CHEESE_LETTUCE_MEAT"]);
  assert.ok(BURGER_RECIPES.every((recipe) => recipe.components.includes("MEAT")));
  let now = 1_000;
  const projection = new ServerProjection({ provider: new LocalFloorplanProvider({ now: () => now }), now: () => now, orderIntervalMinSeconds: 8, orderIntervalMaxSeconds: 8, random: () => 0 });
  await projection.proposeFloorplan({ photos: [{ id: "fixture" }] }, now);
  projection.approveFloorplan(true, now);
  projection.command("START_GAME", {}, now);
  const wrong = projection.ingestBadgeEvent({ senderMac: MAC, sequence: 1, type: "B", value: "SUBMIT:CHEESEBURGER" }, now);
  assert.equal(wrong.accepted, true);
  assert.equal(projection.snapshot(now).submissions[0].status, "failure");
  assert.equal(projection.snapshot(now).gold.total, 0);
  const correct = projection.ingestBadgeEvent({ senderMac: MAC, sequence: 2, type: "B", value: "SUBMIT:PLAIN_MEAT" }, now);
  assert.equal(correct.accepted, true);
  const state = projection.snapshot(now);
  assert.equal(state.submissions[1].status, "success");
  assert.equal(state.gold.total, 100);
  assert.ok(state.tips.total > 0);
  assert.ok(state.activeOrders.length >= 1);
  assert.ok(state.activeOrders[0].patience.segments === 3);
});

test("HTTP upload, review, approval, serial projection, and browser reads work", async () => {
  await withRuntime(async (base) => {
    const initial = await fetch(`${base}/api/state`).then((response) => response.json());
    assert.equal(initial.players.length, 3);
    const state = await approveAndStart(base);
    assert.equal(state.setup.phase, "running");
    assert.equal(state.floorPlan.room.widthMeters, 10);
    assert.equal(state.floorPlan.stations.length, 4);
    const serial = await post(base, "/api/serial", { line: `noise HTN26|RX|${MAC}|-40|OC1|99|N|ING:MEAT` });
    assert.equal(serial.response.status, 200);
    assert.equal(serial.data.result.ok, true);
    assert.equal(serial.data.state.players[0].heldItem, "MEAT");
    const orders = await fetch(`${base}/api/orders`).then((response) => response.json());
    assert.ok(Array.isArray(orders.orders));
    assert.ok(orders.order.patience);
    const gold = await fetch(`${base}/api/gold`).then((response) => response.json());
    const tips = await fetch(`${base}/api/tips`).then((response) => response.json());
    const timer = await fetch(`${base}/api/timer`).then((response) => response.json());
    const players = await fetch(`${base}/api/players`).then((response) => response.json());
    const submissions = await fetch(`${base}/api/submissions`).then((response) => response.json());
    assert.equal(typeof gold.total, "number");
    assert.equal(typeof tips.total, "number");
    assert.equal(timer.status, "running");
    assert.equal(players.players.length, 3);
    assert.deepEqual(submissions.submissions, []);
  });
});
