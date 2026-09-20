import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/main.js";
import { createInitialMockState, createMockTransport } from "../src/mock-transport.js";
import { renderApp } from "../src/render.js";
import { createHttpTransport } from "../src/transport.js";
import { ROOM_COORDINATE_SPACE, validateFrontendSnapshot } from "../src/contracts.js";
import { normalizeServerSnapshot } from "../src/server-snapshot.js";
import {
  isWalkablePosition,
  pathsHaveAgentConflict,
  planPlayerPaths,
  playerPlansAreCollisionSafe,
  projectPointIntoWalkableRoom,
  routePlayerPath,
  separatePlayerPositions,
} from "../src/room-layout.js";
import { plateableIngredientKeys } from "../src/food-rules.js";
import {
  createStandardRoomPlan,
  hasStationTileCollisions,
  stationTileKey,
} from "../src/room-grid.js";
import { displayModeForPhase, GAME_ACTIONS, SETUP_PHASES, UI_DISPLAY_MODES } from "../src/state.js";
import { createInitialProjectionState } from "../../pi/server/src/projection.mjs";

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
  assert.match(html, /class="app-shell is-setup"/);
  assert.match(html, /Your burger kitchen/);
  assert.match(html, /Place the stations/);
  assert.match(html, /data-player="p1"/);
  assert.match(html, /data-player="p2"/);
  assert.doesNotMatch(html, /class="stations-panel/);
  assert.doesNotMatch(html, /4 geese waiting/);
  // The onboarding hero banner was removed so the setup flow fits one screen.
  assert.doesNotMatch(html, /WATERLOO GOOSE KITCHEN/i);
  assert.doesNotMatch(html, /Set up the burger level/);
  assert.doesNotMatch(html, /Kitchen connected/);
  assert.doesNotMatch(html, /class="setup-hero"/);

  assert.equal(countStations(state.floorPlan.stations, "ingredient"), 4);
  assert.equal(countStations(state.floorPlan.stations, "chop"), 2);
  assert.equal(countStations(state.floorPlan.stations, "stove"), 2);
  assert.equal(countStations(state.floorPlan.stations, "delivery"), 1);
  assert.equal(countStations(state.floorPlan.stations, "assembly"), 1);
  assert.equal(countStations(state.stations, "chop"), 2);
  assert.equal(countStations(state.stations, "stove"), 2);
  assert.equal(state.burgerLevel.placementInstructions.length, 10);
  assert.equal(state.burgerLevel.placementInstructions.filter((item) => item.id.endsWith("-source")).length, 4);
  assert.equal(state.burgerLevel.placementInstructions.filter((item) => item.id.startsWith("chop")).length, 2);
  assert.equal(state.burgerLevel.placementInstructions.filter((item) => item.id.startsWith("stove")).length, 2);
  const planIds = state.floorPlan.stations.map((station) => station.id).sort();
  const placementIds = state.burgerLevel.placementInstructions.map((item) => item.id).sort();
  const runtimeIds = state.stations.map((station) => station.id).sort();
  assert.deepEqual(placementIds, planIds);
  assert.deepEqual(runtimeIds, ["assembly", "chop1", "chop2", "stove1", "stove2"]);
  assert.equal(new Set(planIds).size, planIds.length);
  assert.doesNotMatch(JSON.stringify(state), /chop3/i);
});

test("uses the fixed standard room unless the plan explicitly depends on an image", () => {
  const state = createInitialMockState(1_000);

  assert.equal(state.floorPlan.layoutFromImage, false);
  assert.equal(state.floorPlan.width, 100);
  assert.equal(state.floorPlan.height, 100);
  assert.equal(new Set(state.floorPlan.stations.map(({ width, height }) => `${width}x${height}`)).size, 1);
  assert.equal(validateFrontendSnapshot(state).valid, true);
});

test("generates appliances from one collision-safe tile matrix", () => {
  const plan = createStandardRoomPlan();
  const stations = plan.stations;
  const keys = stations.map(stationTileKey);

  assert.deepEqual({ columns: plan.grid.columns, rows: plan.grid.rows }, { columns: 22, rows: 11 });
  assert.equal(plan.grid.cells.length, 11);
  assert.equal(plan.grid.cells.every((row) => row.length === 22), true);
  assert.equal(hasStationTileCollisions(stations), false);
  assert.equal(new Set(stations.map(({ width, height }) => `${width}x${height}`)).size, 1);
  assert.equal(new Set(stations.map(({ display }) => `${display.width}x${display.height}`)).size, 1);
  assert.ok(stations.every((station) => station.display.width >= station.width * 1.99));
  assert.ok(stations.every((station) => station.display.height >= station.height * 1.99));
  assert.equal(new Set(keys).size, stations.length);
  stations.forEach((station) => {
    const cell = plan.grid.cells[station.grid.row][station.grid.column];
    assert.equal(cell.stationId, station.id);
    assert.equal(station.grid.columnSpan, 1);
    assert.equal(station.grid.rowSpan, 1);
  });
  assert.ok(plan.walls.some((wall) => wall.id === "pantry-counter"));
  assert.ok(plan.walls.some((wall) => wall.id === "assembly-counter"));
  assert.equal(plan.walls.some((wall) => wall.id === "central-island"), false);
  // Every appliance's 2x2 art sits exactly on a counter that is as thick as it
  // is, so no art overhangs the blue counters.
  const counters = plan.walls.filter((wall) => wall.id.endsWith("-counter"));
  const close = (left, right) => Math.abs(left - right) < 0.001;
  stations.forEach((station) => {
    const counter = counters.find((wall) => station.display.x >= wall.x - 0.001
      && station.display.x + station.display.width <= wall.x + wall.width + 0.001
      && station.display.y >= wall.y - 0.001
      && station.display.y + station.display.height <= wall.y + wall.height + 0.001);
    assert.ok(counter, `${station.id} art overhangs its counter`);
    assert.ok(close(counter.height, station.display.height), `${station.id} counter is not as thick as its art`);
  });
});

test("only canonical processed food states render as plateable ingredients", () => {
  assert.deepEqual(
    plateableIngredientKeys(["BUN", "COOKED MEAT", "CHOPPED CHEESE", "SHREDDED LETTUCE"]),
    ["BUN", "MEAT", "CHEESE", "LETTUCE"],
  );
  assert.deepEqual(
    plateableIngredientKeys(["RAW MEAT", "CHEESE", "LETTUCE", "BURNT MEAT"]),
    [],
  );
});

test("ships every room and team asset used by the board", () => {
  for (const asset of [
    "chef-player.svg",
    "chef-player-red.svg",
    "chef-player-blue.svg",
    "chef-player-with-plate.svg",
    "chef-player-with-plate-red.svg",
    "chef-player-with-plate-blue.svg",
    "player-plate.svg",
    "floor-tile.svg",
    "hazard-warning.svg",
    "chop-knife.png",
    "game-room-background.png",
  ]) {
    assert.equal(fs.existsSync(new URL(`../assets/${asset}`, import.meta.url)), true, asset);
  }
});

test("keeps player targets inside the room and routes them around barrier walls", () => {
  const walls = [
    { x: 42, y: 28, width: 16, height: 44, blocksMovement: true },
  ];
  const safeEdge = projectPointIntoWalkableRoom({ x: -20, y: 130 }, walls, { x: 10, y: 10 });
  const safeBarrier = projectPointIntoWalkableRoom({ x: 50, y: 50 }, walls, { x: 10, y: 10 });
  const path = routePlayerPath({ x: 22, y: 50 }, { x: 78, y: 50 }, walls);

  assert.deepEqual(safeEdge, { x: 11, y: 89 });
  assert.equal(isWalkablePosition(safeBarrier, walls), true);
  assert.ok(path.length >= 3);
  assert.ok(path.every((point) => isWalkablePosition(point, walls)));
});

test("routes the default scan animation across the open room with sprite clearance", () => {
  const state = createInitialMockState(1_000);
  const path = routePlayerPath({ x: 20, y: 58 }, { x: 68, y: 58 }, state.floorPlan.walls);

  assert.ok(path.length >= 2);
  assert.ok(path.every((point) => isWalkablePosition(point, state.floorPlan.walls)));
  path.slice(1).forEach((point, index) => {
    const from = path[index];
    for (let step = 0; step <= 20; step += 1) {
      const progress = step / 20;
      assert.equal(isWalkablePosition({
        x: from.x + ((point.x - from.x) * progress),
        y: from.y + ((point.y - from.y) * progress),
      }, state.floorPlan.walls), true);
    }
  });
});

test("gives players who scan the same station stable, non-overlapping display slots", () => {
  const players = [
    { id: "p1", position: { x: 20, y: 20 } },
    { id: "p2", position: { x: 20, y: 20 } },
    { id: "p3", position: { x: 20, y: 20 } },
  ];
  const positioned = separatePlayerPositions(players, []);

  assert.equal(positioned.length, 3);
  assert.equal(new Set(positioned.map(({ position }) => `${position.x},${position.y}`)).size, 3);
  assert.ok(positioned.every(({ position }) => isWalkablePosition(position, [])));
});

test("plans simultaneous chef movement with barrier-safe alternate lanes", () => {
  const state = createInitialMockState(1_000);
  const plans = planPlayerPaths([
    { id: "p1", position: { x: 20, y: 58 }, targetPosition: { x: 80, y: 58 } },
    { id: "p2", position: { x: 80, y: 58 }, targetPosition: { x: 20, y: 58 } },
    // With two-tile counters the open lane is only ~23 units tall, so a third
    // chef cannot cross between the two swapping chefs; it works the far side.
    { id: "p3", position: { x: 12, y: 50 }, targetPosition: { x: 30, y: 50 } },
  ], state.floorPlan.walls);

  assert.equal(plans.size, 3);
  assert.equal(playerPlansAreCollisionSafe(plans), true);
  plans.forEach((plan) => {
    assert.ok(plan.path.length >= 2);
    assert.equal(plan.path.every((point) => isWalkablePosition(point, state.floorPlan.walls)), true);
    assert.equal(plan.reachedTarget, true);
  });
  assert.equal(pathsHaveAgentConflict(plans.get("p1").path, plans.get("p2").path), false);
});

test("uses an alternate arc when two chefs would exchange positions", () => {
  const walls = [];
  const plans = planPlayerPaths([
    { id: "p1", position: { x: 20, y: 50 }, targetPosition: { x: 80, y: 50 } },
    { id: "p2", position: { x: 80, y: 50 }, targetPosition: { x: 20, y: 50 } },
  ], walls);

  assert.equal(plans.size, 2);
  assert.equal(playerPlansAreCollisionSafe(plans), true);
  assert.ok(plans.get("p2").path.length >= 3);
  assert.ok([...plans.values()].every((plan) => plan.path.every((point) => isWalkablePosition(point, walls))));
});

test("handles duplicate targets, stale positions, and an impossible barrier without throwing", () => {
  const state = createInitialMockState(1_000);
  const duplicateTargetPlans = planPlayerPaths([
    { id: "p1", position: { x: 20, y: 30 }, targetPosition: { x: 50, y: 50 } },
    { id: "p2", position: { x: 80, y: 30 }, targetPosition: { x: 50, y: 50 } },
    { id: "p3", position: { x: 50, y: 80 }, targetPosition: { x: 50, y: 50 } },
  ], state.floorPlan.walls);
  const endpoints = [...duplicateTargetPlans.values()].map((plan) => plan.path.at(-1));
  assert.equal(new Set(endpoints.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)).size, 3);
  assert.equal(playerPlansAreCollisionSafe(duplicateTargetPlans), true);

  const impossibleWalls = [{ x: 0, y: 0, width: 100, height: 100, blocksMovement: true }];
  const blocked = planPlayerPaths([{ id: "p1", position: { x: 50, y: 50 }, targetPosition: { x: 80, y: 80 } }], impossibleWalls);
  assert.equal(blocked.size, 1);
  assert.equal(blocked.get("p1").reachedTarget, false);
});

test("adapts the Pi server projection at the HTTP boundary", async () => {
  const serverSnapshot = createInitialProjectionState(1_000);
  const normalized = normalizeServerSnapshot(serverSnapshot);

  assert.equal(normalized.version, 2);
  assert.equal(normalized.floorPlan.coordinateSpace, ROOM_COORDINATE_SPACE);
  assert.equal(normalized.floorPlan.units, "percent");
  assert.equal(validateFrontendSnapshot(normalized).valid, true);
  assert.deepEqual(normalized.players.map((player) => player.color), ["red", "blue", "green"]);
  assert.deepEqual(normalized.floorPlan.stations.map((station) => station.assetKey), ["PANTRY", "FRIDGE", "CHOP", "STOVE"]);
  assert.equal(new Set(normalized.floorPlan.stations.map((station) => `${station.display.width}x${station.display.height}`)).size, 1);

  const fetchCalls = [];
  let eventSource;
  class FakeEventSource {
    constructor(url) { this.url = url; this.onmessage = null; this.listeners = new Map(); this.closed = false; eventSource = this; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() { this.closed = true; }
  }
  const transport = createHttpTransport({
    baseUrl: "http://127.0.0.1:8787/",
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, json: async () => serverSnapshot };
    },
    eventSourceFactory: FakeEventSource,
  });
  let received;
  const cleanup = await transport.connect((snapshot) => { received = snapshot; });
  assert.equal(received.version, 2);
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:8787/api/state");
  eventSource.listeners.get("state")({ data: JSON.stringify({ ...serverSnapshot, setup: { ...serverSnapshot.setup, phase: "running" } }) });
  assert.equal(received.setup.phase, "running");
  const commandResult = await transport.command({ type: "START_HOST" });
  assert.equal(commandResult.version, 2);
  cleanup();
});

test("renders gameplay as a framed room board with state shown on each station", async () => {
  const transport = await approvedTransport();
  await transport.command(GAME_ACTIONS.START_GAME);
  const state = transport.snapshot();
  state.floorPlan.stations[0].x = 2;
  state.players[1] = {
    ...state.players[1],
    heldItem: "RAW_MEAT",
    inventory: ["RAW_MEAT"],
    actionState: "chopping",
    location: "cutting-board",
    position: { x: 23.5, y: 74.25 },
  };
  state.submissions = [{ id: "submission-1", playerId: "p1", status: "failure", message: "WRONG BURGER", penalty: -25, points: -25 }];
  const html = renderApp(state, 1_000);

  assert.match(html, /data-display-mode="gameplay"/);
  assert.match(html, /BURGER/);
  assert.match(html, /CHEESE/);
  assert.match(html, /LETTUCE/);
  assert.match(html, /STOVE 1/);
  assert.match(html, /STOVE 2/);
  assert.match(html, /CHOP 2/);
  assert.match(html, /04:00/);
  assert.match(html, /class="game-board panel\s/);
  assert.match(html, /class="board-score"/);
  assert.doesNotMatch(html, /LIVE ACTIVITY/);
  assert.doesNotMatch(html, /class="board-notification /);
  assert.match(html, /data-station="stove1"[^>]*>[\s\S]*?data-station-content="MEAT"/);
  assert.match(html, /data-station="stove2"[^>]*>[\s\S]*?data-station-content="EMPTY"/);
  assert.match(html, /data-station="chop1"[^>]*>[\s\S]*?data-station-content="LETTUCE"/);
  assert.match(html, /data-station="chop2"[^>]*>[\s\S]*?data-station-content="CHEESE"/);
  assert.match(html, /data-station="buns-source"[^>]*>[\s\S]*?data-station-content="BUN"/);
  assert.equal((html.match(/data-node-id="39:26"/g) || []).length, 4);
  assert.match(html, /data-order-count="4"/);
  assert.match(html, /id="hud-title-order-1"[^>]*>PLAIN MEAT BURGER/);
  assert.match(html, /data-ingredient-slot="1"/);
  assert.match(html, /data-node-id="20:2"/);
  assert.match(html, /class="game-board-score"/);
  assert.match(html, /class="game-board-timer"/);
  assert.match(html, /data-layout-source="fixed"/);
  assert.match(html, /data-grid-columns="22" data-grid-rows="11"/);
  assert.match(html, /data-station="cheese-source"[^>]*data-grid-cell="1:1"/);
  assert.doesNotMatch(html, /game-room-background\.png/);
  assert.match(html, /data-barrier="assembly-counter"/);
  assert.match(html, /data-player="p1"[\s\S]*?chef-player-with-plate-red\.svg/);
  assert.match(html, /data-player="p2"[\s\S]*?chef-player-blue\.svg/);
  assert.match(html, /data-player="p3"[\s\S]*?<span class="player-tag">P3<\/span>/);
  assert.equal((html.match(/data-player-path="barrier-safe"/g) || []).length, 3);
  assert.equal((html.match(/class="player-location-info"/g) || []).length, 3);
  assert.doesNotMatch(html, /data-player-card=/);
  assert.match(html, /data-player="p2"[^>]*data-location="cutting-board"[^>]*data-held-item="RAW_MEAT"[^>]*data-action-state="chopping"/);
  assert.match(html, /data-player="p1"[^>]*data-submission-status="failure"/);
  assert.match(html, /PLAYER 2/);
  assert.match(html, /RAW MEAT/);
  assert.match(html, /CHOPPING/);
  assert.match(html, /WRONG BURGER · -25/);
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

test("makes raw, cooking, cooked, and burnt meat states explicit on the station art", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.stations = [
    { id: "stove1", label: "STOVE 1", kind: "stove", status: "cooking", progress: .4, remainingSeconds: 9, item: "RAW MEAT" },
    { id: "stove2", label: "STOVE 2", kind: "stove", status: "burnt", progress: 1, remainingSeconds: 0, item: "BURNT MEAT" },
  ];
  const html = renderApp(state, 1_000);

  assert.match(html, /data-station="stove1"[^>]*>[\s\S]*?data-station-phase="cooking"/);
  assert.match(html, /data-station="stove2"[^>]*>[\s\S]*?data-station-phase="burnt"/);
  assert.match(html, /data-station="stove1"[^>]*>[\s\S]*?COOKING/);
  assert.match(html, /data-station="stove2"[^>]*>[\s\S]*?BURNT/);
  assert.match(html, /data-station="stove1"[^>]*>[\s\S]*?data-cook-progress="40"/);
});

test("renders server-owned station timing and cooking warning state for the projector", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.stations = [
    {
      id: "stove1",
      label: "STOVE 1",
      kind: "stove",
      status: "cooking",
      progress: .9,
      remainingSeconds: 3,
      totalSeconds: 30,
      item: "RAW MEAT",
      warning: true,
      warningMessage: "MEAT IS NEARLY BURNT",
    },
  ];

  const html = renderApp(state, 1_000);

  assert.match(html, /data-station="stove1"[^>]*>[\s\S]*?data-station-warning="true"/);
  assert.match(html, /hazard-warning\.svg/);
  assert.match(html, /class="station-steam"/);
  assert.match(html, /MEAT IS NEARLY BURNT/);
  assert.match(html, /class="station-progress-track"[^>]*data-progress="90"/);
  assert.match(html, /aria-valuemax="100"/);
  assert.match(html, /data-station-item="MEAT"/);
});

test("retains the image-derived room branch behind the layout boolean", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.floorPlan.layoutFromImage = true;
  state.clock.status = "running";

  const html = renderApp(state, 1_000);

  assert.match(html, /data-layout-source="image"/);
  assert.match(html, /game-room-background\.png/);
});

test("shows a dismissible how-it-works explainer only in gameplay mode, open by default", async () => {
  const setupHtml = renderApp((await approvedTransport()).snapshot(), 1_000);
  assert.doesNotMatch(setupHtml, /class="how-it-works"/);

  const transport = await approvedTransport();
  await transport.command(GAME_ACTIONS.START_GAME);
  const gameplayHtml = renderApp(transport.snapshot(), 1_000);
  assert.match(gameplayHtml, /class="how-it-works" role="dialog" aria-label="How this game works"/);
  // Grounded in the real rules: pantry/fridge, cutting board, stove, plate, shake-submit.
  assert.match(gameplayHtml, /pantry/i);
  assert.match(gameplayHtml, /fridge/i);
  assert.match(gameplayHtml, /cutting board/i);
  assert.match(gameplayHtml, /stove/i);
  assert.match(gameplayHtml, /shake/i);
  // useState defaults it open; renderApp is a static-markup snapshot so the
  // click-to-dismiss interaction itself isn't exercised by this harness, but
  // the dismiss control's presence and hook are checked here.
  assert.match(gameplayHtml, /<button type="button" class="how-it-works-dismiss" data-dismiss="how-it-works">/);

  await transport.command(GAME_ACTIONS.END_GAME);
  const resultsHtml = renderApp(transport.snapshot(), 1_000);
  assert.doesNotMatch(resultsHtml, /class="how-it-works"/);
});

test("keeps the room mirror geometry aligned to its normalized display bounds", () => {
  const state = createInitialMockState(1_000);
  const boundaryWalls = state.floorPlan.walls.filter((wall) => wall.id.endsWith("-wall"));
  const assemblyCounter = state.floorPlan.walls.find((wall) => wall.id === "assembly-counter");

  assert.equal(state.floorPlan.width, 100);
  assert.equal(state.floorPlan.height, 100);
  assert.equal(boundaryWalls.length, 4);
  assert.ok(boundaryWalls.every((wall) => wall.blocksMovement === true));
  assert.ok(assemblyCounter.blocksMovement);
  assert.equal(validateFrontendSnapshot(state).valid, true);
});

test("renders only event-inferred player locations", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.players[0].location = "bottom";
  state.players[1].location = "cutting-board";
  state.players[1].position = { x: 23.5, y: 74.25 };
  state.players[2].location = "bump-middle";
  state.players[2].position = { x: 50, y: 58 };

  const html = renderApp(state, 7_000);

  assert.match(html, /data-player="p1" data-location="bottom"[^>]*aria-label="PLAYER 1, event-inferred bottom, holding/);
  assert.match(html, /data-player="p2" data-location="cutting-board"[^>]*aria-label="PLAYER 2, event-inferred cutting-board, holding/);
  assert.match(html, /data-player="p3" data-location="bump-middle"[^>]*aria-label="PLAYER 3, event-inferred bump-middle, holding/);
  assert.doesNotMatch(html, /tracking (?:lost|stale)/i);
  assert.doesNotMatch(html, /TRACKING DEGRADED/);
  assert.doesNotMatch(html, /LOCAL SYSTEM HEALTH/);
});

test("renders collocated bump players side by side at their shared location", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.players[0] = {
    ...state.players[0],
    heldItem: "PLATE",
    inventory: ["BUN"],
    actionState: "transferred",
    location: "bump-middle",
    position: { x: 50, y: 58 },
  };
  state.players[1] = {
    ...state.players[1],
    heldItem: "BUN",
    inventory: ["BUN"],
    actionState: "transferred",
    location: "bump-middle",
    position: { x: 50, y: 58 },
  };

  const html = renderApp(state, 7_000);
  const tags = Object.fromEntries([...html.matchAll(/<article[^>]*data-player="([^"]+)"[^>]*>/g)]
    .map((match) => [match[1], match[0]]));

  assert.match(tags.p1, /style="left:50%;top:58%;--player-visual-offset:[^"]+"/);
  assert.match(tags.p2, /style="left:50%;top:58%;--player-visual-offset:[^"]+"/);
  assert.match(tags.p1, /data-location="bump-middle" data-visual-offset="left"/);
  assert.match(tags.p2, /data-location="bump-middle" data-visual-offset="right"/);
  assert.notEqual(
    tags.p1.match(/--player-visual-offset:([^;"]+)/)[1],
    tags.p2.match(/--player-visual-offset:([^;"]+)/)[1],
  );
  assert.match(html, /PLATE · BUN/);
  assert.equal((html.match(/TRANSFERRED/g) || []).length, 2);
});

test("receives named state events from the laptop server", async () => {
  const initial = createInitialMockState(1_000);
  const updated = structuredClone(initial);
  updated.version += 1;
  updated.players[1].heldItem = "CHOPPED_MEAT";
  updated.players[1].actionState = "chop complete";
  const received = [];

  class FakeEventSource {
    static instance;
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      FakeEventSource.instance = this;
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }

  const transport = createHttpTransport({
    baseUrl: "http://laptop.test",
    fetchImpl: async () => ({ ok: true, async json() { return initial; } }),
    eventSourceFactory: FakeEventSource,
  });
  const cleanup = await transport.connect((state) => received.push(state));

  assert.equal(FakeEventSource.instance.url, "http://laptop.test/api/events");
  assert.deepEqual(received, [initial]);
  FakeEventSource.instance.emit("state", updated);
  assert.deepEqual(received, [initial, updated]);
  cleanup();
  assert.equal(FakeEventSource.instance.closed, true);
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
  assert.equal(transport.snapshot().clock.remainingSeconds, 240);

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
    assert.equal(state.clock.remainingSeconds, 240);
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
  assert.deepEqual(state.gold, { total: 0, earned: 0, lastChange: 0 });
  assert.deepEqual(state.tips, { total: 0, earned: 0, lastChange: 0 });
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

test("successful delivery awards the recipe's gold plus a patience-based tip, matching pi/server's formula", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.START_GAME);
  await transport.command({ type: GAME_ACTIONS.DELIVERY_SUCCESS, orderId: "order-1" });
  const served = transport.snapshot();

  // order-1 is PLAIN_MEAT (gold: 100); START_GAME resets it to full patience
  // (remaining === total), so pi/server's tip formula — max(1, round(gold *
  // 0.1 + ratio * 5)) — gives round(10 + 5) = 15 at a 1.0 ratio.
  assert.deepEqual(served.score, { value: 100, delivered: 1 });
  assert.deepEqual(served.gold, { total: 100, earned: 100, lastChange: 100 });
  assert.deepEqual(served.tips, { total: 15, earned: 15, lastChange: 15 });
  assert.equal(served.orders[0].status, "completed");
  assert.ok(served.orders.slice(1).every((order) => order.status === "active"));
  assert.equal(served.order.id, "order-2");
  assert.equal(served.serving.lastEvent.status, "success");
  assert.equal(served.serving.lastEvent.gold, 100);
  assert.equal(served.serving.lastEvent.tip, 15);
  assert.equal(served.serving.lastEvent.patienceSegments, 3);

  await assertCommandUnchanged(transport, { type: GAME_ACTIONS.DELIVERY_SUCCESS, orderId: "order-1" });
  assert.deepEqual(transport.snapshot().score, { value: 100, delivered: 1 });
});

test("failed delivery applies the documented penalty and does not complete the order", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.START_GAME);
  await transport.command(GAME_ACTIONS.DELIVERY_FAILURE);
  const state = transport.snapshot();

  // README.md: "A failed submission applies a penalty and has no retry."
  assert.deepEqual(state.score, { value: -25, delivered: 0 });
  assert.equal(state.gold.lastChange, 0);
  assert.equal(state.tips.lastChange, 0);
  assert.equal(state.order.status, "active");
  assert.equal(state.serving.lastEvent.status, "failure");
  assert.equal(state.serving.lastEvent.penalty, 25);
  assert.equal(state.serving.lastEvent.points, -25);
  assert.equal(state.submissions.length, 1);
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

test("renders serving success, gold/tip breakdown, and score update from the authoritative snapshot", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.START_GAME);
  await transport.command(GAME_ACTIONS.DELIVERY_SUCCESS);
  const state = transport.snapshot();

  assert.equal(state.score.value, 100);
  assert.equal(state.orders[0].status, "completed");
  const html = renderApp(state, 2_000);
  assert.doesNotMatch(html, /LIVE ACTIVITY/);
  assert.match(html, /data-node-id="31:25"/);
  assert.match(html, /score-coin-counter\.png/);
  // The live delivery toast (age 1s, well inside its 3.2s lifetime) shows
  // the gold/tip breakdown, not just the final score chip.
  assert.match(html, /class="delivery-toast is-success"/);
  assert.match(html, /BURGER SERVED/);
  assert.match(html, /\+100 WATCOINS/);
  assert.match(html, /\+15 TIP/);
});

test("renders a rejected burger's live penalty and updates the score", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.START_GAME);
  await transport.command(GAME_ACTIONS.DELIVERY_FAILURE);
  const state = transport.snapshot();

  assert.equal(state.score.value, -25);
  assert.equal(state.order.status, "active");
  const html = renderApp(state, 2_000);
  assert.doesNotMatch(html, /LIVE ACTIVITY/);
  assert.match(html, /class="delivery-toast is-failure"/);
  assert.match(html, /WRONG BURGER/);
  assert.match(html, /-25 PENALTY/);
  assert.match(html, /data-player="p1"[^>]*data-submission-status="failure"/);
  assert.match(html, /WRONG BURGER · -25/);
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
    const progressValues = [...html.matchAll(/class="hud-order-progress"[^>]*aria-valuenow="(\d+)"/g)].map((match) => Number(match[1]));
    assert.equal(progressValues.length, count);
    assert.ok(progressValues.every((value) => value >= 0 && value <= 100));
  }
});

test("renders readable burger stacks and full-width time remaining rails", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.orders[0] = { ...state.orders[0], remainingSeconds: 60, totalSeconds: 120 };
  state.orders[1] = { ...state.orders[1], remainingSeconds: 29, totalSeconds: 120 };

  const html = renderApp(state, 1_000);

  assert.equal((html.match(/data-burger-preview=/g) || []).length, 4);
  // The preview is one pre-drawn burger icon (not an assembled stack of the
  // individual ingredient PNGs) — the exact required components are listed
  // separately in .hud-ingredient-slots right next to it.
  assert.match(html, /data-order-id="order-1"[\s\S]*class="burger-preview-art" src="\/assets\/order-burger\.png"/);
  assert.match(html, /data-order-id="order-1"[\s\S]*role="progressbar"[\s\S]*aria-valuenow="50"[\s\S]*style="width:50%"/);
  assert.equal((html.match(/class="hud-order-progress"/g) || []).length, 4);
  assert.match(html, /class="hud-order hud-order-compact is-warning"[^>]*data-order-id="order-1"/);
  assert.match(html, /class="hud-order hud-order-compact is-critical"[^>]*data-order-id="order-2"/);
  assert.equal((html.match(/class="hud-order-time-icon"/g) || []).length, 4);
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
  const html = renderApp(null, 1_000, "LAPTOP SERVER UNAVAILABLE — offline");
  assert.match(html, /id="ui-error" class="ui-error" role="alert"/);
  assert.match(html, /LAPTOP SERVER UNAVAILABLE — offline/);
});

test("validates the frontend snapshot and rejects non-normalized room data", () => {
  const state = createInitialMockState(1_000);
  state.version = 42;
  assert.equal(validateFrontendSnapshot(state).valid, true);
  assert.equal(state.floorPlan.coordinateSpace, ROOM_COORDINATE_SPACE);

  const unsupportedSchema = structuredClone(state);
  unsupportedSchema.schemaVersion = 3;
  assert.equal(validateFrontendSnapshot(unsupportedSchema).valid, false);

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

test("renders the laptop server snapshot contract with player event state", () => {
  const state = createInitialProjectionState(1_000);
  state.version = 17;
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.timer.status = "running";
  state.players[1] = {
    ...state.players[1],
    heldItem: "CHOPPED_MEAT",
    inventory: ["CHOPPED_MEAT"],
    actionState: "chop complete",
    location: "cutting-board",
    position: { x: 25, y: 70 },
  };
  state.submissions.push({ id: "submission-1", playerId: "p2", status: "failure", message: "WRONG BURGER", penalty: -25, points: -25 });

  assert.equal(validateFrontendSnapshot(state).valid, true);
  const html = renderApp(state, 1_000);
  assert.doesNotMatch(html, /Authoritative state unavailable/);
  assert.equal((html.match(/class="player-location-info"/g) || []).length, 3);
  assert.doesNotMatch(html, /data-player-card=/);
  assert.match(html, /data-player="p2"[^>]*data-held-item="CHOPPED_MEAT"[^>]*data-action-state="chop complete"[^>]*data-submission-status="failure"/);
  assert.match(html, /aria-label="PLAYER 2, event-inferred cutting-board, holding CHOPPED MEAT, chop complete"/);
  assert.match(html, /CHOPPED MEAT/);
  assert.match(html, /WRONG BURGER · -25/);
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
