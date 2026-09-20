import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/main.js";
import { createInitialMockState, createMockTransport } from "../src/mock-transport.js";
import { renderApp } from "../src/render.js";
import { ROOM_COORDINATE_SPACE, validateFrontendSnapshot } from "../src/contracts.js";
import { displayModeForPhase, GAME_ACTIONS, SETUP_PHASES, UI_DISPLAY_MODES } from "../src/state.js";

async function approvedTransport(now = 1_000) {
  const transport = createMockTransport({ now: () => now });
  await transport.command(GAME_ACTIONS.START_HOST);
  await transport.command(GAME_ACTIONS.SCAN_ROOM);
  await transport.command(GAME_ACTIONS.APPROVE_LAYOUT);
  return transport;
}

function countStations(stations, kind) {
  return stations.filter((station) => station.kind === kind).length;
}

async function assertCommandUnchanged(transport, command) {
  const before = transport.snapshot();
  await transport.command(command);
  assert.deepEqual(transport.snapshot(), before);
}

test("renders the approved setup flow with the aligned physical layout", async () => {
  const transport = await approvedTransport();
  const state = transport.snapshot();
  const html = renderApp(state, 1_000);

  assert.match(html, /data-display-mode="setup"/);
  assert.match(html, /Your burger kitchen/);
  assert.match(html, /Place the stations/);
  assert.match(html, /data-player="p1"/);
  assert.match(html, /data-player="p2"/);
  assert.doesNotMatch(html, /class="stations-panel/);
  assert.doesNotMatch(html, /4 geese waiting/);

  assert.equal(countStations(state.floorPlan.stations, "ingredient"), 4);
  assert.equal(countStations(state.floorPlan.stations, "chop"), 2);
  assert.equal(countStations(state.floorPlan.stations, "stove"), 2);
  assert.equal(countStations(state.floorPlan.stations, "delivery"), 1);
  assert.equal(countStations(state.stations, "chop"), 2);
  assert.equal(countStations(state.stations, "stove"), 2);
  assert.equal(state.burgerLevel.placementInstructions.length, 9);
  assert.equal(state.burgerLevel.placementInstructions.filter((item) => item.id.endsWith("-source")).length, 4);
  assert.equal(state.burgerLevel.placementInstructions.filter((item) => item.id.startsWith("chop")).length, 2);
  assert.equal(state.burgerLevel.placementInstructions.filter((item) => item.id.startsWith("stove")).length, 2);
  const planIds = state.floorPlan.stations.map((station) => station.id).sort();
  const placementIds = state.burgerLevel.placementInstructions.map((item) => item.id).sort();
  const runtimeIds = state.stations.map((station) => station.id).sort();
  assert.deepEqual(placementIds, planIds);
  assert.deepEqual(runtimeIds, ["chop1", "chop2", "stove1", "stove2"]);
  assert.equal(new Set(planIds).size, planIds.length);
  assert.doesNotMatch(JSON.stringify(state), /chop3/i);
});

test("renders gameplay as a framed room board with live activity state", async () => {
  const transport = await approvedTransport();
  await transport.command(GAME_ACTIONS.START_GAME);
  const state = transport.snapshot();
  state.floorPlan.stations[0].x = 2;
  const html = renderApp(state, 1_000);

  assert.match(html, /data-display-mode="gameplay"/);
  assert.match(html, /BURGER/);
  assert.match(html, /CHEESE/);
  assert.match(html, /LETTUCE/);
  assert.match(html, /STOVE 1/);
  assert.match(html, /STOVE 2/);
  assert.match(html, /CHOP 2/);
  assert.match(html, /02:00/);
  assert.match(html, /class="game-board panel\s/);
  assert.match(html, /class="board-score"/);
  assert.match(html, /LIVE ACTIVITY/);
  assert.equal((html.match(/class="board-notification /g) || []).length, 2);
  assert.equal((html.match(/data-node-id="39:26"/g) || []).length, 4);
  assert.match(html, /data-order-count="4"/);
  assert.match(html, /id="hud-title-order-1"[^>]*>CHEESE BURGER/);
  assert.match(html, /data-ingredient-slot="1"/);
  assert.match(html, /data-node-id="20:2"/);
  assert.match(html, /class="game-board-score"/);
  assert.match(html, /class="game-board-timer"/);
  assert.match(html, /style="left:[^;]+%;top:[^;]+%;width:[^;]+%;height:[^;]+%" data-station="cheese-source"/);
  assert.ok(html.indexOf('class="game-board panel') < html.indexOf('data-node-id="20:2"'));
  assert.ok(html.indexOf('data-node-id="39:26"') < html.indexOf('class="game-board-score"'));
  assert.ok(html.indexOf('class="game-board-score"') < html.indexOf('data-node-id="20:2"'));
  assert.doesNotMatch(html, /BURGER LEVEL PLACEMENT/);
  assert.doesNotMatch(html, /Game Display/);
  assert.doesNotMatch(html, /BURGER GAME RUNNING/);
  assert.doesNotMatch(html, /TRACKING DEGRADED/);
  assert.doesNotMatch(html, /id="stations-title"/);
  assert.doesNotMatch(html, /footer-note/);
});

test("keeps the room mirror geometry aligned to its normalized display bounds", () => {
  const state = createInitialMockState(1_000);
  const verticalWalls = state.floorPlan.walls.filter((wall) => wall.width < 10);
  const bottomWall = state.floorPlan.walls.find((wall) => wall.y > 0);

  assert.equal(state.floorPlan.width, 100);
  assert.equal(state.floorPlan.height, 68);
  assert.ok(verticalWalls.every((wall) => wall.y === 0 && wall.height === 100));
  assert.ok(Math.abs((bottomWall.y + bottomWall.height) - 100) < 0.001);
  assert.equal(validateFrontendSnapshot(state).valid, true);
});

test("marks old or missing player tracking and stale worker health", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.players[1].tracking.lastSeenAt = 0;
  delete state.players[0].position;
  state.health.workers[1].lastSeenAt = 0;

  const html = renderApp(state, 7_000);

  assert.match(html, /data-player="p1" data-stale="true"/);
  assert.match(html, /P1[\s\S]*TRACKING LOST/);
  assert.doesNotMatch(html, /data-player="p1"[^>]*style="left:0%;top:0%;/);
  assert.match(html, /data-player="p2" data-stale="true"/);
  assert.match(html, /P2[\s\S]*TRACKING STALE/);
  assert.doesNotMatch(html, /TRACKING DEGRADED/);
  assert.doesNotMatch(html, /LOCAL SYSTEM HEALTH/);
});

test("host commands follow start, scan, approval, burger placement, and round lifecycle", async () => {
  let now = 10_000;
  const transport = createMockTransport({ now: () => now });

  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.IDLE);
  const idleHtml = renderApp(transport.snapshot(), now);
  assert.match(idleHtml, /disabled[^>]*data-command="RESCAN"/);
  await transport.command(GAME_ACTIONS.RESCAN);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.IDLE);

  await transport.command(GAME_ACTIONS.START_HOST);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.SCANNING);
  await transport.command(GAME_ACTIONS.SCAN_ROOM);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.LAYOUT_PROPOSED);
  assert.equal(transport.snapshot().floorPlan.accepted, false);
  await transport.command(GAME_ACTIONS.RESCAN);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.SCANNING);
  await transport.command(GAME_ACTIONS.SCAN_ROOM);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.LAYOUT_PROPOSED);

  await transport.command(GAME_ACTIONS.APPROVE_LAYOUT);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.BURGER_PLACEMENT);
  assert.equal(transport.snapshot().floorPlan.accepted, true);
  assert.equal(transport.snapshot().burgerLevel.status, "placement-ready");
  const placementHtml = renderApp(transport.snapshot(), now);
  assert.match(placementHtml, /data-command="START_GAME"(?! disabled)/);

  now += 1_000;
  await transport.command(GAME_ACTIONS.START_GAME);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.RUNNING);
  assert.equal(transport.snapshot().clock.status, "running");
  assert.equal(transport.snapshot().clock.remainingSeconds, 120);

  await transport.command(GAME_ACTIONS.END_GAME);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.ENDED);
  assert.equal(transport.snapshot().clock.status, "ended");

  await transport.command(GAME_ACTIONS.RESET_GAME);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.IDLE);
  assert.equal(transport.snapshot().floorPlan.accepted, false);
});

test("rejects setup commands in invalid phases without changing authoritative state", async () => {
  const transport = createMockTransport({ now: () => 10_000 });

  for (const command of [
    GAME_ACTIONS.RESCAN,
    GAME_ACTIONS.SCAN_ROOM,
    GAME_ACTIONS.APPROVE_LAYOUT,
    GAME_ACTIONS.START_GAME,
    GAME_ACTIONS.END_GAME,
  ]) {
    await assertCommandUnchanged(transport, command);
  }

  await transport.command(GAME_ACTIONS.START_HOST);
  for (const command of [GAME_ACTIONS.APPROVE_LAYOUT, GAME_ACTIONS.START_GAME, GAME_ACTIONS.END_GAME]) {
    await assertCommandUnchanged(transport, command);
  }

  await transport.command(GAME_ACTIONS.SCAN_ROOM);
  await assertCommandUnchanged(transport, GAME_ACTIONS.SCAN_ROOM);
  await transport.command(GAME_ACTIONS.APPROVE_LAYOUT);
  for (const command of [GAME_ACTIONS.SCAN_ROOM, GAME_ACTIONS.APPROVE_LAYOUT, GAME_ACTIONS.END_GAME]) {
    await assertCommandUnchanged(transport, command);
  }

  await transport.command(GAME_ACTIONS.START_GAME);
  for (const command of [
    GAME_ACTIONS.START_HOST,
    GAME_ACTIONS.SCAN_ROOM,
    GAME_ACTIONS.APPROVE_LAYOUT,
    GAME_ACTIONS.RESCAN,
    GAME_ACTIONS.START_GAME,
  ]) {
    await assertCommandUnchanged(transport, command);
  }
  await transport.command(GAME_ACTIONS.END_GAME);
  for (const command of [
    GAME_ACTIONS.SCAN_ROOM,
    GAME_ACTIONS.APPROVE_LAYOUT,
    GAME_ACTIONS.RESCAN,
    GAME_ACTIONS.START_GAME,
    GAME_ACTIONS.END_GAME,
  ]) {
    await assertCommandUnchanged(transport, command);
  }
});

test("reset returns to the idle authoritative state from every setup phase", async () => {
  for (const phase of Object.values(SETUP_PHASES)) {
    const initialState = createInitialMockState(1_000);
    initialState.setup.phase = phase;
    initialState.floorPlan.accepted = [SETUP_PHASES.BURGER_PLACEMENT, SETUP_PHASES.LAYOUT_ACCEPTED, SETUP_PHASES.RUNNING].includes(phase);
    const transport = createMockTransport({ initialState, now: () => 9_000 });

    await transport.command(GAME_ACTIONS.RESET_GAME);
    const state = transport.snapshot();
    assert.equal(state.setup.phase, SETUP_PHASES.IDLE);
    assert.equal(state.floorPlan.accepted, false);
    assert.equal(state.score.value, 0);
    assert.equal(state.score.delivered, 0);
    assert.equal(state.clock.status, "ready");
    assert.equal(state.clock.remainingSeconds, 112);
    assert.equal(state.order.status, "active");
  }
});

test("start game resets the authoritative clock, order, and score", async () => {
  const initialState = createInitialMockState(1_000);
  initialState.setup.phase = SETUP_PHASES.BURGER_PLACEMENT;
  initialState.floorPlan.accepted = true;
  initialState.burgerLevel.status = "placement-ready";
  initialState.score = { value: 250, delivered: 2 };
  initialState.clock = { status: "ended", remainingSeconds: 3, totalSeconds: 120 };
  initialState.order = { ...initialState.order, status: "completed", remainingSeconds: 3 };
  initialState.orders = initialState.orders.map((order) => ({ ...order, status: "completed", remainingSeconds: 3 }));
  const transport = createMockTransport({ initialState, now: () => 5_000 });

  await transport.command(GAME_ACTIONS.START_GAME);
  const state = transport.snapshot();

  assert.equal(state.setup.phase, SETUP_PHASES.RUNNING);
  assert.deepEqual(state.score, { value: 0, delivered: 0 });
  assert.equal(state.clock.status, "running");
  assert.equal(state.clock.remainingSeconds, state.clock.totalSeconds);
  assert.equal(state.order.status, "active");
  assert.equal(state.order.remainingSeconds, state.order.totalSeconds);
  assert.ok(state.orders.every((order) => order.status === "active"));
  assert.ok(state.orders.every((order) => order.remainingSeconds === order.totalSeconds));
  assert.equal(state.serving.lastEvent, null);
});

test("delivery is accepted only during a running active round", async () => {
  const transport = await approvedTransport(1_000);

  await assertCommandUnchanged(transport, GAME_ACTIONS.DELIVERY_SUCCESS);
  await assertCommandUnchanged(transport, GAME_ACTIONS.DELIVERY_FAILURE);

  await transport.command(GAME_ACTIONS.START_GAME);
  await transport.command(GAME_ACTIONS.END_GAME);
  await assertCommandUnchanged(transport, GAME_ACTIONS.DELIVERY_SUCCESS);
  await assertCommandUnchanged(transport, GAME_ACTIONS.DELIVERY_FAILURE);
});

test("successful delivery changes score and only the targeted order once", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.START_GAME);
  await transport.command({ type: GAME_ACTIONS.DELIVERY_SUCCESS, orderId: "order-1" });
  const served = transport.snapshot();

  assert.deepEqual(served.score, { value: 20, delivered: 1 });
  assert.equal(served.orders[0].status, "completed");
  assert.ok(served.orders.slice(1).every((order) => order.status === "active"));
  assert.equal(served.order.id, "order-2");
  assert.equal(served.serving.lastEvent.status, "success");

  await assertCommandUnchanged(transport, { type: GAME_ACTIONS.DELIVERY_SUCCESS, orderId: "order-1" });
  assert.deepEqual(transport.snapshot().score, { value: 20, delivered: 1 });
});

test("failed delivery does not score or complete the order", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.START_GAME);
  await transport.command(GAME_ACTIONS.DELIVERY_FAILURE);
  const state = transport.snapshot();

  assert.deepEqual(state.score, { value: 0, delivered: 0 });
  assert.equal(state.order.status, "active");
  assert.equal(state.serving.lastEvent.status, "failure");
});

test("unknown commands do not mutate state", async () => {
  const transport = await approvedTransport(1_000);
  const before = transport.snapshot();

  await transport.command("UNKNOWN_COMMAND");
  assert.deepEqual(transport.snapshot(), before);
  await transport.command({ type: "NOT_A_REAL_COMMAND", payload: { score: 999 } });
  assert.deepEqual(transport.snapshot(), before);
});

test("setup flow reaches gameplay and results display modes", async () => {
  const transport = createMockTransport({ now: () => 1_000 });

  assert.equal(displayModeForPhase(transport.snapshot().setup.phase), UI_DISPLAY_MODES.SETUP);
  await transport.command(GAME_ACTIONS.START_HOST);
  await transport.command(GAME_ACTIONS.SCAN_ROOM);
  await transport.command(GAME_ACTIONS.APPROVE_LAYOUT);
  assert.equal(displayModeForPhase(transport.snapshot().setup.phase), UI_DISPLAY_MODES.SETUP);

  await transport.command(GAME_ACTIONS.START_GAME);
  assert.equal(displayModeForPhase(transport.snapshot().setup.phase), UI_DISPLAY_MODES.GAMEPLAY);
  const gameplay = renderApp(transport.snapshot(), 1_000);
  assert.match(gameplay, /data-display-mode="gameplay"/);
  assert.doesNotMatch(gameplay, /BURGER GAME RUNNING/);
  assert.doesNotMatch(gameplay, /Game Display/);

  await transport.command(GAME_ACTIONS.END_GAME);
  assert.equal(displayModeForPhase(transport.snapshot().setup.phase), UI_DISPLAY_MODES.RESULTS);
  assert.match(renderApp(transport.snapshot(), 1_000), /GAME ENDED/);
});

test("renders serving success and score update from the authoritative snapshot", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.START_GAME);
  await transport.command(GAME_ACTIONS.DELIVERY_SUCCESS);
  const state = transport.snapshot();

  assert.equal(state.score.value, 20);
  assert.equal(state.orders[0].status, "completed");
  const html = renderApp(state, 2_000);
  assert.match(html, /BURGER SERVED/);
  assert.match(html, /\+20/);
  assert.match(html, /data-node-id="31:25"/);
  assert.match(html, /score-coin-counter\.png/);
  assert.match(html, /notification-success/);
});

test("renders rejected burger without changing score", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.START_GAME);
  await transport.command(GAME_ACTIONS.DELIVERY_FAILURE);
  const state = transport.snapshot();

  assert.equal(state.score.value, 0);
  assert.equal(state.order.status, "active");
  const html = renderApp(state, 2_000);
  assert.match(html, /WRONG BURGER/);
  assert.match(html, /CHECK ORDER/);
  assert.match(html, /notification-failure/);
});

test("renders one, two, and four active orders with unique accessible headings", () => {
  for (const count of [1, 2, 4]) {
    const state = createInitialMockState(1_000);
    state.setup.phase = SETUP_PHASES.RUNNING;
    state.floorPlan.accepted = true;
    state.clock.status = "running";
    state.orders = state.orders.slice(0, count);
    state.order = { ...state.orders[0] };
    const html = renderApp(state, 1_000);

    assert.match(html, new RegExp(`data-order-count="${count}"`));
    assert.equal((html.match(/data-order-id="order-/g) || []).length, count);
    assert.equal((html.match(/id="hud-title-order-/g) || []).length, count);
    assert.equal((html.match(/aria-label="\d{2}:\d{2} remaining"/g) || []).length, count);
    assert.equal((html.match(/role="progressbar"/g) || []).length, count);
    const progressValues = [...html.matchAll(/aria-valuenow="(\d+)"/g)].map((match) => Number(match[1]));
    assert.equal(progressValues.length, count);
    assert.ok(progressValues.every((value) => value >= 0 && value <= 100));
  }
});

test("falls back to the legacy single order when an orders array is absent", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  delete state.orders;

  const html = renderApp(state, 1_000);
  assert.match(html, /data-order-count="1"/);
  assert.equal((html.match(/data-order-id=/g) || []).length, 1);
  assert.equal(validateFrontendSnapshot(state).valid, true);
});

test("rejects more than four orders and duplicate order ids at the contract boundary", () => {
  const tooMany = createInitialMockState(1_000);
  tooMany.orders.push({ ...tooMany.orders[0], id: "order-5" });
  const tooManyValidation = validateFrontendSnapshot(tooMany);
  assert.equal(tooManyValidation.valid, false);
  assert.match(JSON.stringify(tooManyValidation.errors), /at most 4 active orders/);

  const duplicate = createInitialMockState(1_000);
  duplicate.orders[1] = { ...duplicate.orders[1], id: duplicate.orders[0].id };
  const duplicateValidation = validateFrontendSnapshot(duplicate);
  assert.equal(duplicateValidation.valid, false);
  assert.match(JSON.stringify(duplicateValidation.errors), /duplicate id/);
});

test("allows completed order history alongside at most four active orders", () => {
  const state = createInitialMockState(1_000);
  state.orders.push({ ...state.orders[0], id: "order-history", status: "completed" });
  assert.equal(validateFrontendSnapshot(state).valid, true);
});

test("shows a connection error while waiting for authoritative state", () => {
  const html = renderApp(null, 1_000, "MASTER PI UNAVAILABLE — offline");
  assert.match(html, /id="ui-error" class="ui-error" role="alert"/);
  assert.match(html, /MASTER PI UNAVAILABLE — offline/);
});

test("validates the frontend snapshot and rejects non-normalized room data", () => {
  const state = createInitialMockState(1_000);
  assert.equal(validateFrontendSnapshot(state).valid, true);
  assert.equal(state.floorPlan.coordinateSpace, ROOM_COORDINATE_SPACE);

  const invalid = structuredClone(state);
  invalid.floorPlan.coordinateSpace = "world-meters";
  invalid.floorPlan.stations[0].x = 95;
  invalid.floorPlan.stations[0].width = 20;
  invalid.players[0].position.x = 101;
  const validation = validateFrontendSnapshot(invalid);

  assert.equal(validation.valid, false);
  assert.match(JSON.stringify(validation.errors), /coordinate space/);
  assert.match(JSON.stringify(validation.errors), /normalized to 0-100/);
  assert.match(JSON.stringify(validation.errors), /fit within normalized horizontal bounds/);
  assert.match(JSON.stringify(validation.errors), /players\[0\]\.position\.x/);
  assert.match(renderApp(invalid, 1_000), /Authoritative state unavailable/);
  assert.doesNotMatch(renderApp(invalid, 1_000), /PLAYER 1/);
});

test("cleans up a connection that resolves after app destruction", async () => {
  let resolveConnection;
  let cleanupCount = 0;
  let closeCount = 0;
  const root = {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {},
  };
  const transport = {
    connect() {
      return new Promise((resolve) => { resolveConnection = resolve; });
    },
    close() { closeCount += 1; },
  };

  const app = createApp({ root, transport });
  app.destroy();
  resolveConnection(() => { cleanupCount += 1; });
  await Promise.resolve();

  assert.equal(cleanupCount, 1);
  assert.equal(closeCount, 1);
});
