import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSerialStreamAdapter, parseCanonicalLine, parseGatewayRxLine, parseGatewaySerialLine } from "../src/protocol.mjs";
import { browserDocument } from "../src/http.mjs";
import { LocalFloorplanProvider } from "../src/provider.mjs";
import { BURGER_RECIPES, GAME_TIMINGS, MONEY_RULES, ServerProjection } from "../src/projection.mjs";
import { createRuntime, startupGuide } from "../server.mjs";
import { openSerialDevice } from "../src/serial-device.mjs";

const MAC = "AA:BB:CC:DD:EE:01";

async function withRuntime(callback, { now = () => Date.now() } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "htn26-server-"));
  const runtime = await createRuntime({ dataDir, env: {}, now });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  try { return await callback(`http://127.0.0.1:${address.port}`, runtime); }
  finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
}

function readyOtherPlayers(projection, submitterId, now) {
  for (const playerId of ["p1", "p2", "p3"]) {
    if (playerId !== submitterId) projection.ingestPlayerAction({ playerId, action: "READY" }, now);
  }
}

function submitWithTeam(projection, playerId, plate, now) {
  readyOtherPlayers(projection, playerId, now);
  return projection.ingestSubmission({ playerId, plate }, now);
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

test("canonical protocol covers host, gateway, player actions, and submissions while legacy frames remain valid", () => {
  const records = [
    parseCanonicalLine("log HTN26|1|HOST|START|120|3"),
    parseCanonicalLine("HTN26|1|HOST|END"),
    parseCanonicalLine("HTN26|1|HOST|RESET"),
    parseCanonicalLine("HTN26|1|GATEWAY|UP|12|1"),
    parseCanonicalLine("HTN26|1|PLAYER|1|PICKUP|RAW_MEAT"),
    parseCanonicalLine("HTN26|1|PLAYER|1|PLATE|BM--"),
    parseCanonicalLine("HTN26|1|PLAYER|1|CHOP|START"),
    parseCanonicalLine("HTN26|1|PLAYER|1|CHOP|DONE|CHOPPED_MEAT"),
    parseCanonicalLine("HTN26|1|PLAYER|1|CHOP|FAIL"),
    parseCanonicalLine("HTN26|1|PLAYER|1|STOVE|LEFT|PLACE"),
    parseCanonicalLine("HTN26|1|PLAYER|1|STOVE|RIGHT|TAKE"),
    parseCanonicalLine("HTN26|1|PLAYER|1|STOVE|LEFT|STATUS|WARNING"),
    parseCanonicalLine("HTN26|1|PLAYER|1|DROP"),
    parseCanonicalLine("HTN26|1|PLAYER|1|LEAVE"),
    parseCanonicalLine("HTN26|1|PLAYER|1|TRANSFER|2"),
    parseCanonicalLine("HTN26|1|PLAYER|1|READY"),
    parseCanonicalLine("HTN26|1|SUBMIT|1|BM--"),
  ];
  assert.ok(records.every((record) => record.ok), records.map((record) => record.error).join(", "));
  assert.equal(records[0].kind, "host-control");
  assert.equal(records[3].kind, "gateway-status");
  assert.equal(records[4].kind, "player-action");
  assert.equal(records.at(-1).kind, "submission");
  assert.equal(parseCanonicalLine("HTN26|2|HOST|START").ok, false);
  assert.equal(parseCanonicalLine("HTN26|1|PLAYER|4|DROP").ok, false);

  assert.equal(parseGatewaySerialLine("noise HTN26|GW|DOWN|4|2").kind, "gateway-status");
  assert.equal(parseGatewaySerialLine("noise HTN26|GAME|START_GAME|120|3").kind, "host-control");
  assert.equal(parseGatewaySerialLine("noise HTN26|GAME|GAME_END|3").control, "END");
  assert.equal(parseGatewaySerialLine(`noise HTN26|RX|${MAC}|-44|OC1|7|E|P2:PU:R`).kind, "badge-event");
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
  assert.equal(projection.snapshot(now).timer.totalSeconds, 240);
  assert.equal(projection.snapshot(now).timer.remainingSeconds, 240);
  projection.ingestPlayerAction({ playerId: "p1", action: "PLATE", plate: "BMLC" }, now);
  readyOtherPlayers(projection, "p1", now);
  const wrong = projection.ingestBadgeEvent({ senderMac: MAC, sequence: 1, type: "B", value: "SUBMIT:CHEESE_LETTUCE_MEAT" }, now);
  assert.equal(wrong.accepted, true);
  assert.equal(projection.snapshot(now).submissions[0].status, "failure");
  assert.equal(projection.snapshot(now).gold.total, 0);
  projection.ingestPlayerAction({ playerId: "p1", action: "PLATE", plate: "BM--" }, now);
  readyOtherPlayers(projection, "p1", now);
  const correct = projection.ingestBadgeEvent({ senderMac: MAC, sequence: 2, type: "B", value: "SUBMIT:PLAIN_MEAT" }, now);
  assert.equal(correct.accepted, true);
  const state = projection.snapshot(now);
  assert.equal(state.submissions[1].status, "success");
  assert.equal(state.gold.total, 100);
  assert.ok(state.tips.total > 0);
  assert.ok(state.activeOrders.length >= 1);
  assert.equal(state.activeOrders[0].patience.segments, 3);
});

test("round timer ends cleanly and resets held, order, and station state", () => {
  let now = 10_000;
  const projection = new ServerProjection({ now: () => now, roundSeconds: 3, orderIntervalSeconds: 20, orderPatienceSeconds: 20, random: () => 0 });
  projection.ingestHostControl({ control: "START", durationSeconds: 3 }, now);
  projection.ingestPlayerAction({ playerId: "p1", action: "PICKUP", item: "BUN" }, now);
  assert.equal(projection.snapshot(now).timer.remainingSeconds, 3);
  now += 2_000;
  assert.equal(projection.snapshot(now).timer.remainingSeconds, 1);
  now += 1_000;
  const ended = projection.snapshot(now);
  assert.equal(ended.timer.status, "ended");
  assert.equal(ended.timer.remainingSeconds, 0);
  assert.equal(ended.activeOrders.length, 0);
  assert.equal(ended.orders[0].status, "cancelled");
  assert.equal(ended.players[0].heldItem, "EMPTY");
  assert.ok(ended.stations.every((station) => station.status === "idle"));
});

test("orders spawn naturally, traverse patience 3/2/1/0, and expiration makes net money negative", () => {
  let now = 20_000;
  const projection = new ServerProjection({
    now: () => now,
    roundSeconds: 60,
    orderIntervalSeconds: 4,
    orderPatienceSeconds: 12,
    maxActiveOrders: 3,
    random: () => 0,
  });
  projection.ingestHostControl({ control: "START", durationSeconds: 60 }, now);
  assert.equal(projection.snapshot(now).orders[0].patienceState, 3);
  now += 4_000;
  let state = projection.snapshot(now);
  assert.equal(state.orders[0].patienceState, 2);
  assert.equal(state.orders.length, 2, "a second order should appear without a command");
  now += 4_000;
  state = projection.snapshot(now);
  assert.equal(state.orders[0].patienceState, 1);
  now += 4_000;
  state = projection.snapshot(now);
  assert.equal(state.orders[0].status, "expired");
  assert.equal(state.orders[0].patienceState, 0);
  assert.equal(state.orders[0].penalty, MONEY_RULES.expiredOrderPenalty);
  assert.equal(state.money.net, -MONEY_RULES.expiredOrderPenalty);
  assert.ok(state.eventHistory.some((event) => event.type === "order-expired"));
});

test("wrong submission loses money while an early correct plate earns gold and a positive tip", () => {
  const now = 30_000;
  const projection = new ServerProjection({ now: () => now, orderIntervalSeconds: 30, orderPatienceSeconds: 30, random: () => 0 });
  projection.ingestHostControl({ control: "START", durationSeconds: 120 }, now);
  projection.ingestPlayerAction({ playerId: "p1", action: "PLATE", plate: "BMLC" }, now);
  submitWithTeam(projection, "p1", "BMLC", now);
  let state = projection.snapshot(now);
  assert.equal(state.submissions[0].status, "failure");
  assert.equal(state.money.net, -MONEY_RULES.wrongOrderPenalty);

  projection.ingestPlayerAction({ playerId: "p1", action: "PLATE", plate: "BM--" }, now);
  submitWithTeam(projection, "p1", "BM--", now);
  state = projection.snapshot(now);
  assert.equal(state.submissions[1].status, "success");
  assert.equal(state.gold.total, 100);
  assert.ok(state.tips.total > 0);
  assert.ok(state.money.net > 0);
  assert.equal(state.players[0].heldItem, "EMPTY", "submission consumes the plate");
});

test("server owns chopping, two-stove cooking phases, and player plate inventory", () => {
  let now = 40_000;
  const projection = new ServerProjection({ now: () => now, orderIntervalSeconds: 30, orderPatienceSeconds: 30, random: () => 0 });
  projection.ingestHostControl({ control: "START", durationSeconds: 120 }, now);
  projection.ingestPlayerAction({ playerId: "p1", action: "PICKUP", item: "RAW_MEAT" }, now);
  projection.ingestPlayerAction({ playerId: "p1", action: "CHOP", phase: "START" }, now);
  const early = projection.ingestPlayerAction({ playerId: "p1", action: "CHOP", phase: "DONE", item: "CHOPPED_MEAT" }, now);
  assert.equal(early.accepted, false);
  assert.equal(projection.snapshot(now).players[0].heldItem, "RAW_MEAT");
  assert.equal(projection.snapshot(now).players[0].processing.type, "chop");
  now += GAME_TIMINGS.chopSeconds * 1_000;
  assert.equal(projection.snapshot(now).players[0].heldItem, "CHOPPED_MEAT");
  projection.ingestPlayerAction({ playerId: "p1", action: "STOVE", side: "LEFT", operation: "PLACE" }, now);
  now += GAME_TIMINGS.cookSeconds * 1_000;
  assert.equal(projection.snapshot(now).stations.find((station) => station.id === "stove-left").status, "done");
  now += GAME_TIMINGS.doneSeconds * 1_000;
  assert.equal(projection.snapshot(now).stations.find((station) => station.id === "stove-left").status, "warning");
  now += GAME_TIMINGS.warningSeconds * 1_000;
  assert.equal(projection.snapshot(now).stations.find((station) => station.id === "stove-left").status, "burnt");

  projection.ingestPlayerAction({ playerId: "p2", action: "PICKUP", item: "BUN" }, now);
  projection.ingestPlayerAction({ playerId: "p2", action: "PLATE", plate: "NEW" }, now);
  const player = projection.snapshot(now).players[1];
  assert.equal(player.hasPlate, true);
  assert.deepEqual(player.inventory, ["BUN"]);
});

test("action-inferred station occupancy allows groups and returns players to center after the hold delay", () => {
  let now = 45_000;
  const projection = new ServerProjection({ now: () => now, locationHoldSeconds: 2, orderPatienceSeconds: 30, random: () => 0 });
  projection.ingestHostControl({ control: "START", durationSeconds: 120 }, now);
  projection.ingestPlayerAction({ playerId: "p1", action: "PICKUP", item: "BUN" }, now);
  projection.ingestPlayerAction({ playerId: "p2", action: "PICKUP", item: "BUN" }, now);
  let state = projection.snapshot(now);
  assert.deepEqual(state.players.slice(0, 2).map((player) => player.currentStation), ["pantry", "pantry"]);
  assert.ok(state.players[0].simulatedLocation.returnAt);

  now += 1_999;
  assert.deepEqual(projection.snapshot(now).players.slice(0, 2).map((player) => player.currentStation), ["pantry", "pantry"]);
  now += 1;
  state = projection.snapshot(now);
  assert.deepEqual(state.players.slice(0, 2).map((player) => player.currentStation), ["center", "center"]);

  projection.ingestPlayerAction({ playerId: "p1", action: "PLATE", plate: "BM--" }, now);
  submitWithTeam(projection, "p1", "BM--", now);
  assert.equal(projection.snapshot(now).players[0].currentStation, "serving");
});

test("submissions require authoritative inventory, matching assertions, and three fresh players", () => {
  let now = 47_000;
  const projection = new ServerProjection({ now: () => now, roundSeconds: 20, orderPatienceSeconds: 30, random: () => 0 });
  projection.ingestHostControl({ control: "START", durationSeconds: 20 }, now);

  readyOtherPlayers(projection, "p1", now);
  let result = projection.ingestSubmission({ playerId: "p1", plate: "BM--" }, now);
  assert.equal(result.accepted, false);
  assert.match(result.detail, /authoritative server plate/);
  assert.deepEqual(projection.snapshot(now).submissions, []);

  projection.ingestPlayerAction({ playerId: "p1", action: "PLATE", plate: "BM--" }, now);
  now += 501;
  result = projection.ingestSubmission({ playerId: "p1", plate: "BM--" }, now);
  assert.equal(result.accepted, true);
  assert.equal(result.pending, true);
  assert.match(result.detail, /waiting for/);
  assert.equal(projection.snapshot(now).players[0].hasPlate, true);
  projection.ingestPlayerAction({ playerId: "p2", action: "READY" }, now);
  assert.deepEqual(projection.snapshot(now).submissions, []);
  projection.ingestPlayerAction({ playerId: "p3", action: "READY" }, now);
  assert.equal(projection.snapshot(now).submissions[0].status, "success");
  assert.ok(projection.snapshot(now).players.every((player) => player.heldItem === "EMPTY"));

  projection.ingestPlayerAction({ playerId: "p1", action: "PLATE", plate: "BM-C" }, now);
  readyOtherPlayers(projection, "p1", now);
  const moneyBeforeMismatch = projection.snapshot(now).money.net;
  result = projection.ingestSubmission({ playerId: "p1", plate: "BMLC" }, now);
  assert.equal(result.accepted, false);
  assert.match(result.detail, /assertion/);
  assert.equal(projection.snapshot(now).money.net, moneyBeforeMismatch);
  assert.equal(projection.snapshot(now).players[0].hasPlate, true);

  const moneyBeforeCorrect = projection.snapshot(now).money.net;
  result = submitWithTeam(projection, "p1", "BM-C", now);
  assert.equal(result.accepted, true);
  assert.equal(result.submission.status, "success");
  assert.ok(projection.snapshot(now).money.net > moneyBeforeCorrect);
  assert.ok(projection.snapshot(now).players.every((player) => player.heldItem === "EMPTY"));

  projection.ingestPlayerAction({ playerId: "p1", action: "PLATE", plate: "B---" }, now);
  readyOtherPlayers(projection, "p1", now);
  now += 20_000;
  const moneyBefore = projection.snapshot(now).money.net;
  result = projection.ingestSubmission({ playerId: "p1", plate: "B---" }, now);
  assert.equal(result.accepted, false);
  assert.equal(result.ignored, true);
  assert.equal(projection.snapshot(now).submissions.length, 2);
  assert.equal(projection.snapshot(now).money.net, moneyBefore);
});

test("legacy fixed-player actions update the encoded player rather than arrival order", () => {
  const now = 50_000;
  const projection = new ServerProjection({ now: () => now, random: () => 0 });
  projection.ingestHostControl({ control: "START", durationSeconds: 120 }, now);
  const result = projection.ingestBadgeEvent({ senderMac: MAC, sequence: 42, type: "E", value: "P2:PU:R" }, now);
  assert.equal(result.accepted, true);
  assert.equal(projection.snapshot(now).players[1].heldItem, "RAW_MEAT");
  assert.equal(projection.snapshot(now).players[0].heldItem, "EMPTY");
});

test("native GAME and complete E event path is parsed and projected by the laptop runtime", async () => {
  let now = 55_000;
  await withRuntime(async (_base, runtime) => {
    const ingest = (line) => {
      const record = runtime.serialAdapter.ingest(line);
      assert.equal(record.ok, true, record.error);
      return runtime.projection.snapshot(now);
    };
    let sequence = 100_000;
    const event = (player, action) => ingest(`native HTN26|RX|AA:BB:CC:DD:EE:0${player}|-45|OC1|${sequence++}|E|P${player}:${action}`);

    let state = ingest("native HTN26|GW|UP|0|0");
    assert.equal(state.health.gateway.status, "healthy");
    state = ingest("native HTN26|GAME|START_GAME|240|3");
    assert.equal(state.timer.status, "running");
    assert.equal(state.timer.totalSeconds, 240);

    state = event(1, "PU:R");
    assert.equal(state.players[0].heldItem, "RAW_MEAT");
    event(1, "CH:S");
    state = event(1, "CH:D:M");
    assert.equal(state.players[0].heldItem, "RAW_MEAT");
    assert.equal(state.eventHistory.at(-1).type, "rejected-action");
    now += GAME_TIMINGS.chopSeconds * 1_000;
    assert.equal(runtime.projection.snapshot(now).players[0].heldItem, "CHOPPED_MEAT");

    state = event(1, "ST:L:P");
    assert.equal(state.stations.find((station) => station.id === "stove-left").status, "cooking");
    now += GAME_TIMINGS.cookSeconds * 1_000;
    state = event(1, "ST:L:C:DONE");
    assert.equal(state.stations.find((station) => station.id === "stove-left").status, "done");
    state = event(1, "ST:L:T");
    assert.equal(state.players[0].heldItem, "COOKED_MEAT");
    state = event(1, "PL:NEW");
    assert.deepEqual(state.players[0].plate, ["MEAT"]);
    state = event(1, "PU:B");
    assert.deepEqual(state.players[0].plate, ["MEAT", "BUN"]);

    state = event(1, "SUB:BM--");
    assert.deepEqual(state.submissions, []);
    state = event(2, "READY");
    assert.deepEqual(state.submissions, []);
    state = event(3, "READY");
    assert.equal(state.submissions[0].status, "success");
    assert.ok(state.tips.total > 0);

    for (const [code, expected] of [["M", "CHOPPED_MEAT"], ["X", "BURNT_MEAT"], ["L", "LETTUCE"], ["C", "CHEESE"]]) {
      state = event(3, `PU:${code}`);
      assert.equal(state.players[2].heldItem, expected);
      state = event(3, `DROP:H${code}`);
      assert.equal(state.players[2].heldItem, "EMPTY");
    }

    event(1, "PU:Q");
    event(1, "CH:S");
    state = event(1, "CH:F");
    assert.equal(state.players[0].heldItem, "RAW_LETTUCE");
    state = event(1, "DROP:HQ");
    assert.equal(state.players[0].heldItem, "EMPTY");

    event(1, "PL:B---");
    event(2, "PU:K");
    event(1, "X:PB---");
    state = event(2, "X:HK");
    assert.equal(state.players[0].heldItem, "RAW_CHEESE");
    assert.deepEqual(state.players[1].plate, ["BUN"]);
    state = event(3, "ST:R:C:EMPTY");
    assert.equal(state.players[2].actionState, "checked stove 2: idle");
    event(3, "PU:M");
    event(3, "ST:R:P");
    now += (GAME_TIMINGS.cookSeconds + GAME_TIMINGS.doneSeconds + GAME_TIMINGS.warningSeconds) * 1_000;
    state = event(3, "ST:R:X");
    assert.equal(state.players[2].heldItem, "BURNT_MEAT");

    state = ingest("native HTN26|GAME|GAME_END|3");
    assert.equal(state.timer.status, "ended");
    assert.ok(state.players.every((player) => player.heldItem === "EMPTY"));
  }, { now: () => now });
});

test("legacy tip frames remain parseable but cannot change server money", () => {
  const now = 60_000;
  const projection = new ServerProjection({ now: () => now, random: () => 0 });
  projection.ingestHostControl({ control: "START", durationSeconds: 120 }, now);
  const result = projection.ingestBadgeEvent({ senderMac: MAC, sequence: 7, type: "B", value: "TIP:9999" }, now);
  assert.equal(result.accepted, false);
  assert.equal(result.ignored, true);
  assert.equal(projection.snapshot(now).tips.total, 0);
  assert.equal(projection.snapshot(now).money.net, 0);
  assert.equal(projection.snapshot(now).eventHistory.at(-1).type, "legacy-tip-ignored");
});

test("HTTP upload, review, approval, serial projection, and browser reads work", async () => {
  await withRuntime(async (base) => {
    const initial = await fetch(`${base}/api/state`).then((response) => response.json());
    assert.equal(initial.players.length, 3);
    assert.equal(initial.timer.totalSeconds, 240);
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

test("plain browser view and diagnostic endpoint use the same canonical state", async () => {
  const html = browserDocument();
  assert.match(html, /Orders \/ new orders/);
  assert.match(html, /Round and timer/);
  assert.match(html, /Players and actions/);
  for (const heading of ["Pantry", "Fridge", "Cutting Board", "Stove 1", "Stove 2", "Serving", "Center \/ default"]) assert.match(html, new RegExp(heading));
  assert.match(html, /temporary server inferences from actions/);
  assert.match(html, /Net money/);
  assert.match(html, /HTN26\|1\|HOST\|START\|240\|3/);
  assert.doesNotMatch(html, /<style\b|stylesheet/i);

  const guide = startupGuide("http://127.0.0.1:8787");
  for (const route of ["/api/timer", "/api/orders", "/api/players", "/api/submissions", "/api/money"]) assert.match(guide, new RegExp(route));
  assert.match(guide, /HTN26\|1\|PLAYER\|2\|READY/);
  assert.match(guide, /HTN26\|1\|PLAYER\|3\|READY/);
  assert.match(guide, /HTN26\|1\|SUBMIT\|1\|BM--/);

  await withRuntime(async (base) => {
    const page = await fetch(`${base}/`).then((response) => response.text());
    assert.equal(page, html);
    let injected = await post(base, "/api/serial", { line: "HTN26|1|HOST|START|240|3" });
    assert.equal(injected.data.result.ok, true);
    assert.equal(injected.data.state.timer.status, "running");
    injected = await post(base, "/api/serial", { line: "HTN26|1|PLAYER|1|PLATE|BM--" });
    assert.deepEqual(injected.data.state.players[0].plate, ["BUN", "MEAT"]);
    await post(base, "/api/serial", { line: "HTN26|1|PLAYER|2|READY" });
    await post(base, "/api/serial", { line: "HTN26|1|PLAYER|3|READY" });
    injected = await post(base, "/api/serial", { line: "HTN26|1|SUBMIT|1|BM--" });
    assert.equal(injected.data.state.submissions[0].status, "success");
    const money = await fetch(`${base}/api/money`).then((response) => response.json());
    assert.equal(money.gold, 100);
    assert.ok(money.tips > 0);
    const state = await fetch(`${base}/api/state`).then((response) => response.json());
    assert.deepEqual(state.money, money);
  });
});
