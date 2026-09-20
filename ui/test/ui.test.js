import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp, isPhotosPath } from "../src/main.js";
import { PhotosPage, uploadRoomPhotos } from "../src/PhotosPage.js";
import viteConfig from "../vite.config.js";
import { advanceMockState, createInitialMockState, createMockTransport } from "../src/mock-transport.js";
import { renderApp } from "../src/render.js";
import { ROOM_COORDINATE_SPACE, validateFrontendSnapshot } from "../src/contracts.js";
import { normalizeServerSnapshot } from "../src/server-snapshot.js";
import { createBrowserTransport, createHttpTransport } from "../src/transport.js";
import {
  isWalkablePosition,
  planPlayerPaths,
  playerPlansAreCollisionSafe,
  projectPointIntoWalkableRoom,
  routePlayerPath,
  separatePlayerPositions,
} from "../src/room-layout.js";
import { plateableIngredientKeys } from "../src/food-rules.js";
import {
  INGREDIENT_KINDS,
  INGREDIENT_SPRITES,
  PLATE_SPRITES,
  ingredientSprite,
  ingredientStage,
  platedStage,
  plateSprite,
} from "../src/ingredient-sprites.js";
import {
  createStandardRoomPlan,
  hasStationTileCollisions,
  stationTileKey,
} from "../src/room-grid.js";
import {
  displayModeForPhase,
  GAME_ACTIONS,
  matchRuntimeStations,
  SETUP_PHASES,
  stationProgressPercent,
  UI_DISPLAY_MODES,
} from "../src/state.js";
import { createInitialProjectionState } from "../../server/src/projection.mjs";

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

test("/photos renders only the minimal mobile upload surface", () => {
  const html = renderToStaticMarkup(React.createElement(PhotosPage));

  assert.equal(isPhotosPath("/photos"), true);
  assert.equal(isPhotosPath("/photos/"), true);
  assert.equal((html.match(/<input/g) || []).length, 1);
  assert.match(html, /type="file"/);
  assert.match(html, /multiple=""/);
  assert.match(html, /Choose 4–5 photos/);
  assert.doesNotMatch(html, /<button|UnderCooked|game-board|player/i);
});

test("photo selection requires 4-5 images and posts one layout generation request", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ presentationArea: {}, objects: [], playArea: {}, stations: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const photos = Array.from({ length: 4 }, (_, index) => new Blob([`photo-${index}`], { type: "image/jpeg" }));

  await assert.rejects(uploadRoomPhotos(photos.slice(0, 3), { fetchImpl }), /Select 4 or 5/);
  assert.equal(calls.length, 0);
  await uploadRoomPhotos(photos, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/layout/generate");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body.getAll("photos").length, 4);
});

test("Vite proxies same-origin API requests to the laptop server", async () => {
  assert.equal(viteConfig.server.proxy["/api"].target, process.env.HTN26_API_PROXY_TARGET || "http://127.0.0.1:8787");
  const calls = [];
  const transport = createBrowserTransport({
    search: "?transport=http",
    injected: null,
    eventSourceFactory: null,
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => createInitialProjectionState(1_000) };
    },
  });

  await transport.command({ type: "START_HOST" });
  assert.deepEqual(calls, ["/api/command"]);
});

test("renders the UnderCooked onboarding start screen before host setup", async () => {
  const transport = createMockTransport({ now: () => 1_000 });
  const onboarding = renderApp(transport.snapshot(), 1_000);

  assert.match(onboarding, /data-onboarding="welcome"/);
  assert.match(onboarding, /UnderCooked/);
  assert.match(onboarding, /order-burger\.png/);
  assert.match(fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8"), /\.onboarding-screen[\s\S]*game-room-background\.png/);
  assert.match(onboarding, /data-command="START_HOST"/);
  assert.doesNotMatch(onboarding, /Sign In To Save Progress/i);
  assert.doesNotMatch(onboarding, /RBC|TradeOff/i);

  await transport.command(GAME_ACTIONS.START_HOST);
  const setup = renderApp(transport.snapshot(), 1_000);
  assert.doesNotMatch(setup, /data-onboarding="welcome"/);
  assert.match(setup, /data-onboarding="players"/);
});

test("renders room upload and server-driven player readiness during scanning", () => {
  const transport = createMockTransport({ now: () => 1_000 });
  const state = structuredClone(transport.snapshot());
  state.setup = { ...state.setup, phase: SETUP_PHASES.SCANNING };
  state.players = state.players.slice(0, 1);

  const html = renderApp(state, 1_000, "", "http");

  assert.match(html, /data-onboarding="players"/);
  assert.match(html, /Room photos/);
  assert.match(html, /disabled="" data-command="SCAN_ROOM"/);
  assert.match(html, /data-player-slot="1" data-player-ready="true"/);
  assert.match(html, /data-player-slot="2" data-player-ready="false"/);
  assert.match(html, /data-player-slot="3" data-player-ready="false"/);
  assert.match(html, /player-readiness-icon[\s\S]*PLAYER 1/);
  assert.match(html, /WAITING FOR PLAYER/);
  assert.doesNotMatch(html, /Add room photos/);
  assert.doesNotMatch(html, /data-photo-input/);
  const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.player-readiness-list[\s\S]*grid-template-columns:\s*repeat\(3/);
  assert.match(styles, /\.player-readiness > p[\s\S]*text-align:\s*center/);

  state.photos = [{ id: "room-1" }, { id: "room-2" }, { id: "room-3" }];
  const readyHtml = renderApp(state, 1_000, "", "http");
  assert.doesNotMatch(readyHtml, /disabled="" data-command="SCAN_ROOM"/);
});

test("renders the approved setup flow with the aligned physical layout", async () => {
  const transport = await approvedTransport();
  const state = transport.snapshot();
  const html = renderApp(state, 1_000);

  assert.match(html, /data-display-mode="setup"/);
  assert.match(html, /class="app-shell is-setup is-tour"/);
  assert.match(html, /data-onboarding="tour"/);
  assert.match(html, /Welcome to [\s\S]*UnderCooked Interactive Tour/);
  assert.match(html, /Start Tour/);
  assert.match(html, /Skip to the Game/);
  assert.match(html, /data-order-count="1"/);
  assert.match(html, /class="hud-timer-value">04:00</);
  assert.match(html, /class="board-score-value">0</);
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
  assert.equal(countStations(state.floorPlan.stations, "delivery"), 0);
  assert.equal(countStations(state.floorPlan.stations, "assembly"), 1);
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

test("maps every plate combination with drawn art to one ready-made sprite", () => {
  for (const path of Object.values(PLATE_SPRITES)) {
    assert.equal(fs.existsSync(new URL(`..${path}`, import.meta.url)), true, path);
  }
  // All 15 non-empty topping combinations resolve except cheese+lettuce, the
  // one without drawn art; it keeps the loose-icon fallback.
  const kinds = ["BUN", "CHEESE", "LETTUCE", "MEAT"];
  for (let mask = 1; mask < 16; mask += 1) {
    const combo = kinds.filter((_, bit) => Boolean(mask & (1 << bit)));
    if (combo.join("+") === "CHEESE+LETTUCE") assert.equal(plateSprite(combo), null);
    else assert.match(plateSprite(combo), /\/plate_[a-z_]+\.png$/);
  }
  assert.match(plateSprite([]), /\/plate\.png$/);
  assert.match(plateSprite(["BUN", "MEAT"]), /plate_bun_meat\.png$/);
  assert.match(plateSprite(["LETTUCE", "BUN"]), /plate_bun_lettuce\.png$/);
});

test("draws a chef's and assembly plate as one ready-made sprite per combination", async () => {
  const transport = await approvedTransport();
  await transport.command(GAME_ACTIONS.START_GAME);
  const html = renderApp(transport.snapshot(), 1_000);

  // p1's plate is bun + cooked meat + shredded lettuce; p3's is bun + cheese.
  assert.match(html, /data-player="p1"[\s\S]*?player-plate-sprite[\s\S]*?plate_bun_meat_lettuce\.png/);
  assert.match(html, /data-player="p3"[\s\S]*?player-plate-sprite[\s\S]*?plate_bun_cheese\.png/);
  // The assembly counter shows the same ready-made plate for its mix.
  assert.match(html, /data-station="assembly"[\s\S]*?plate_bun_meat_lettuce\.png/);
  // With a sprite, the loose icon grid a third item could spill off is gone.
  assert.doesNotMatch(html, /class="player-plate-ingredients/);
});

test("keeps the loose icon grid only for plates without drawn art", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.players = [
    { ...state.players[0], plate: ["CHOPPED CHEESE", "SHREDDED LETTUCE"] },
    { ...state.players[1], plate: [] },
  ];
  const html = renderApp(state, 1_000);

  // cheese+lettuce has no sprite: the empty-plate art plus loose icons show.
  assert.match(html, /data-player="p1"[\s\S]*?data-plate-sprite="base"[\s\S]*?\/plate\.png/);
  assert.match(html, /data-player="p1"[\s\S]*?class="player-plate-ingredients[\s\S]*?cheese_slice\.png[\s\S]*?lettuce_leaf\.png/);
  assert.doesNotMatch(html, /data-player="p1"[\s\S]*?data-plate-sprite="combo"/);
  // An empty plate is just the empty-plate art, with no icons on it.
  assert.match(html, /data-player="p2"[\s\S]*?data-plate-sprite="base"[\s\S]*?\/plate\.png/);
  assert.doesNotMatch(html, /data-player="p2"[\s\S]*?class="player-plate-ingredients/);
});

test("derives the ingredient sprite stage from the authoritative item name", () => {
  assert.equal(ingredientStage("RAW_MEAT"), "raw");
  assert.equal(ingredientStage("CHOPPED_MEAT"), "chopped");
  assert.equal(ingredientStage("COOKED_MEAT"), "cooked");
  assert.equal(ingredientStage("BURNT_MEAT"), "burnt");
  assert.equal(ingredientStage("SHREDDED LETTUCE"), "chopped");
  assert.equal(ingredientStage("SLICED CHEESE"), "chopped");
  // A bare ingredient or an in-progress status carries no stage of its own, so
  // the station's fallback decides.
  assert.equal(ingredientStage("LETTUCE", "chopped"), "chopped");
  assert.equal(ingredientStage("LETTUCE"), "raw");
  assert.equal(ingredientStage("COOKING", "cooked"), "cooked");
  assert.equal(platedStage("MEAT"), "cooked");
  assert.equal(platedStage("CHEESE"), "chopped");
});

test("maps each ingredient kind and stage to its top-down sprite", () => {
  assert.deepEqual(INGREDIENT_KINDS, ["BUN", "MEAT", "CHEESE", "LETTUCE"]);
  const file = (kind, stage) => ingredientSprite(kind, stage).split("/").at(-1);
  assert.equal(file("MEAT", "raw"), "meat_raw.png");
  assert.equal(file("MEAT", "chopped"), "meat_flattened.png");
  assert.equal(file("MEAT", "cooked"), "meat_cooked.png");
  assert.equal(file("MEAT", "burnt"), "meat_burnt.png");
  assert.equal(file("CHEESE", "raw"), "cheese_triangle.png");
  assert.equal(file("CHEESE", "chopped"), "cheese_slice.png");
  assert.equal(file("LETTUCE", "raw"), "lettuce_head.png");
  assert.equal(file("LETTUCE", "chopped"), "lettuce_leaf.png");
  assert.equal(ingredientSprite("PICKLE", "raw"), null);
});

test("resolves plate sprites by ingredient set and ships every sprite file", () => {
  assert.match(plateSprite(["MEAT", "CHEESE"]), /plate_meat_cheese\.png$/);
  assert.match(plateSprite(["LETTUCE", "CHEESE", "MEAT"]), /plate_meat_lettuce_cheese\.png$/);
  assert.match(plateSprite([]), /\/plate\.png$/);
  assert.match(plateSprite(["BUN", "MEAT"]), /plate_bun_meat\.png$/);
  assert.match(plateSprite(["MEAT", "LETTUCE", "CHEESE", "BUN"]), /plate_bun_meat_lettuce_cheese\.png$/);
  assert.equal(plateSprite(["CHEESE", "LETTUCE"]), null);

  const paths = [
    ...Object.values(INGREDIENT_SPRITES).flatMap((stages) => Object.values(stages)),
    ...Object.values(PLATE_SPRITES),
  ];
  for (const path of paths) {
    assert.equal(fs.existsSync(new URL(`..${path}`, import.meta.url)), true, path);
  }
});

test("renders station sprites in the stage the authoritative snapshot implies", async () => {
  const transport = await approvedTransport();
  await transport.command(GAME_ACTIONS.START_GAME);
  const state = transport.snapshot();
  const html = renderApp(state, 1_000);
  const stationHtml = (markup, id) => markup.split('data-station="').find((part) => part.startsWith(`${id}"`)) || "";

  // Source stations (fridge/crate) are self-describing art: no ingredient icon
  // and no name caption on top of them.
  for (const id of ["cheese-source", "meat-source", "lettuce-source", "buns-source"]) {
    assert.doesNotMatch(stationHtml(html, id), /data-ingredient-stage=|room-station-label|station-ingredients/, id);
  }
  assert.match(stationHtml(html, "chop1"), /data-ingredient-stage="chopped"/);
  assert.match(stationHtml(html, "chop2"), /data-ingredient-stage="raw"/);
  assert.match(stationHtml(html, "stove1"), /data-ingredient-stage="chopped"/);

  // The assembly plate (bun, cooked meat, shredded lettuce) is one ready-made sprite.
  const assembly = stationHtml(html, "assembly");
  assert.match(assembly, /data-plate-sprite="combo"/);
  assert.match(assembly, /plate_bun_meat_lettuce\.png/);
  assert.doesNotMatch(assembly, /class="station-ingredients/);

  const burnt = {
    ...state,
    stations: state.stations.map((station) => (station.id === "stove1"
      ? { ...station, status: "burnt", item: "BURNT_MEAT", progress: 1, remainingSeconds: 0 }
      : station)),
  };
  const burntStove = stationHtml(renderApp(burnt, 1_000), "stove1");
  assert.match(burntStove, /data-ingredient-stage="burnt"/);
  assert.match(burntStove, /meat_burnt\.png/);
});

test("ships every room and team asset used by the board", () => {
  for (const asset of [
    "chef-player.svg",
    "chef-player-red.svg",
    "chef-player-blue.svg",
    "chef-player-with-plate-back.svg",
    "chef-player-with-plate-back-red.svg",
    "chef-player-with-plate-back-blue.svg",
    "chef-player-with-plate-front.svg",
    "chef-player-with-plate-front-red.svg",
    "chef-player-with-plate-front-blue.svg",
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
  // The two swapping chefs share the narrow lane between the counters, so the
  // planner hands them time-shifted reservations instead of disjoint paths;
  // temporal safety is what playerPlansAreCollisionSafe asserts above.
  assert.ok([plans.get("p1"), plans.get("p2")].every((plan) => /reservation/.test(plan.strategy)));
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
  const html = renderApp(state, 1_000);

  assert.match(html, /data-display-mode="gameplay"/);
  assert.match(html, /BURGER/);
  assert.match(html, /CHEESE/);
  assert.match(html, /LETTUCE/);
  assert.match(html, /STOVE 1/);
  assert.match(html, /STOVE 2/);
  assert.match(html, /CHOP 2/);
  // 02:00 is the first order's patience; the round clock itself is 04:00.
  assert.match(html, /02:00/);
  assert.match(html, /class="hud-timer-value">04:00</);
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
  // p1 holds a plate: back layer (hands/arms), plate sprite, then the
  // hat/body front layer over it — held like the original art.
  assert.match(html, /data-player="p1"[\s\S]*?chef-player-with-plate-back-red\.svg[\s\S]*?plate_bun_meat_lettuce\.png[\s\S]*?chef-player-with-plate-front-red\.svg/);
  assert.match(html, /data-player="p2"[\s\S]*?chef-player-blue\.svg/);
  assert.match(html, /data-player="p3"[\s\S]*?<span class="player-tag">P3<\/span>/);
  assert.equal((html.match(/data-player-path="barrier-safe"/g) || []).length, 3);
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
  assert.match(html, /data-station="stove1"[^>]*>[\s\S]*?meat_raw\.png/);
  assert.match(html, /data-station="stove2"[^>]*>[\s\S]*?meat_burnt\.png/);
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

test("marks old or missing player tracking and stale worker health", () => {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.players[1].tracking.status = "stale";
  delete state.players[0].position;
  state.health.workers[1].lastSeenAt = 0;

  const html = renderApp(state, 7_000);

  assert.match(html, /data-player="p1" data-stale="true"/);
  assert.match(html, /aria-label="PLAYER 1, location unavailable"/);
  assert.doesNotMatch(html, /data-player="p1"[^>]*style="left:0%;top:0%;/);
  assert.match(html, /data-player="p2" data-stale="true"/);
  assert.match(html, /aria-label="PLAYER 2, last scan is stale"/);
  assert.doesNotMatch(html, />TRACKING (?:LOST|STALE)</);
  assert.doesNotMatch(html, /TRACKING DEGRADED/);
  assert.doesNotMatch(html, /LOCAL SYSTEM HEALTH/);
});

test("host commands follow start, scan, approval, burger placement, and round lifecycle", async () => {
  let now = 10_000;
  const transport = createMockTransport({ now: () => now });

  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.IDLE);
  const idleHtml = renderApp(transport.snapshot(), now);
  assert.match(idleHtml, /data-onboarding="welcome"/);
  assert.match(idleHtml, /data-command="START_HOST"/);
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
  initialState.clock = { status: "ended", remainingSeconds: 3, totalSeconds: 240 };
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

// ---- Loading process: station/order bars and clocks -----------------------

function stationHtml(html, id) {
  const start = html.indexOf(`data-station="${id}"`);
  assert.ok(start >= 0, `station ${id} is rendered`);
  const next = html.indexOf('class="room-station ', start);
  return html.slice(start, next < 0 ? undefined : next);
}

async function runningMockState(now = 1_000) {
  const transport = await approvedTransport(now);
  await transport.command(GAME_ACTIONS.START_GAME);
  return transport.snapshot();
}

test("gives the Pi's stove-left/stove-right/cutting-board runtime stations to the plan's stove and cutting-board tiles", () => {
  const server = createInitialProjectionState(1_000);
  server.setup.phase = "running";
  server.clock.status = "running";
  server.timer.status = "running";
  Object.assign(server.stations.find((station) => station.id === "stove-left"), {
    status: "cooking", item: "CHOPPED_MEAT", progress: 0.4, remainingSeconds: 9,
  });
  Object.assign(server.stations.find((station) => station.id === "stove-right"), {
    status: "burnt", item: "BURNT_MEAT", progress: 1, remainingSeconds: 0,
  });
  Object.assign(server.stations.find((station) => station.id === "cutting-board"), {
    status: "chopping", item: "RAW_LETTUCE", progress: 0.5, remainingSeconds: 2,
  });
  const normalized = normalizeServerSnapshot(server);
  normalized.floorPlan.accepted = true;

  // The server-shaped ids really do differ: plan `stove`, runtime `stove-left`.
  assert.deepEqual(normalized.floorPlan.stations.map((station) => station.id), ["pantry", "fridge", "cutting-board", "stove"]);
  assert.ok(normalized.stations.some((station) => station.id === "stove-left"));
  assert.ok(!normalized.stations.some((station) => station.id === "stove"));

  const matches = matchRuntimeStations(normalized.floorPlan.stations, normalized.stations);
  assert.equal(matches.get("stove").id, "stove-left");
  assert.equal(matches.get("cutting-board").id, "cutting-board");
  assert.equal(matches.get("pantry").id, "pantry");

  const html = renderApp(normalized, 1_000);
  const stove = stationHtml(html, "stove");
  assert.match(stove, /data-station-phase="cooking"/);
  assert.match(stove, /COOKING/);
  assert.match(stove, /class="station-progress-track"[^>]*data-progress="40"/);
  assert.match(stove, /data-remaining-seconds="9"/);
  assert.match(stove, /00:09/);
  assert.match(stove, /data-station-item="MEAT"/);
  assert.match(stationHtml(html, "cutting-board"), /class="station-progress-track"[^>]*data-progress="50"/);

  // A second stove tile takes the next unclaimed stove (burnt), never the first again.
  const twoStoves = matchRuntimeStations(
    [{ id: "stove", kind: "stove" }, { id: "stove-b", kind: "stove" }],
    normalized.stations,
  );
  assert.equal(twoStoves.get("stove").id, "stove-left");
  assert.equal(twoStoves.get("stove-b").id, "stove-right");
  const burnt = normalizeServerSnapshot({ ...server, stations: server.stations.map((station) => station.id === "stove-left" ? { ...station, status: "idle", item: null, progress: 0, remainingSeconds: 0 } : station) });
  const burntMatch = matchRuntimeStations([{ id: "stove", kind: "stove" }], burnt.stations);
  assert.equal(burntMatch.get("stove").id, "stove-left");
});

test("keeps exact station-id matches ahead of the kind fallback so the mock's ids are unchanged", () => {
  const state = createInitialMockState(1_000);
  const matches = matchRuntimeStations(state.floorPlan.stations, state.stations);
  for (const id of ["stove1", "stove2", "chop1", "chop2", "assembly"]) {
    assert.equal(matches.get(id)?.id, id);
  }
  // Exact id wins even when an earlier same-kind tile would otherwise claim it.
  const layout = [{ id: "a", kind: "stove" }, { id: "stove-right", kind: "stove" }];
  const runtime = [{ id: "stove-left", kind: "stove" }, { id: "stove-right", kind: "stove" }];
  const paired = matchRuntimeStations(layout, runtime);
  assert.equal(paired.get("stove-right").id, "stove-right");
  assert.equal(paired.get("a").id, "stove-left");
  // Sources never borrow a station of another id.
  assert.equal(matchRuntimeStations([{ id: "cheese-source", kind: "ingredient" }], [{ id: "pantry", kind: "ingredient" }]).size, 0);
});

test("only busy workstations show a progress bar; sources, assembly, and idle boards never do", async () => {
  const state = await runningMockState();
  state.stations = [
    { id: "stove1", label: "STOVE 1", kind: "stove", status: "cooking", progress: 0.5, remainingSeconds: 8, totalSeconds: 15, item: "RAW MEAT" },
    { id: "stove2", label: "STOVE 2", kind: "stove", status: "idle", progress: 0, remainingSeconds: 0, item: null },
    { id: "chop1", label: "CHOP 1", kind: "chop", status: "idle", progress: 0, remainingSeconds: 0, item: null },
    { id: "chop2", label: "CHOP 2", kind: "chop", status: "chopping", progress: 0.25, remainingSeconds: 2, totalSeconds: 3, item: "CHEESE" },
    { id: "assembly", label: "ASSEMBLY", kind: "assembly", status: "ready", progress: 1, remainingSeconds: 0, item: "PLATE" },
    { id: "cheese-source", label: "CHEESE", kind: "ingredient", status: "source", progress: 0.5, remainingSeconds: 5, totalSeconds: 10, item: "CHEESE" },
  ];
  const html = renderApp(state, 1_000);

  assert.match(stationHtml(html, "stove1"), /class="station-progress-track"[^>]*data-progress="50"/);
  assert.match(stationHtml(html, "chop2"), /class="station-progress-track"[^>]*data-progress="25"/);
  for (const id of ["stove2", "chop1", "assembly", "cheese-source", "buns-source"]) {
    assert.doesNotMatch(stationHtml(html, id), /station-progress-track/, `${id} has no progress bar`);
  }
  // The caption wrapper stays for non-source stations, bar or not.
  assert.match(stationHtml(html, "stove2"), /class="station-caption"/);
  assert.match(stationHtml(html, "assembly"), /class="station-caption"/);

  // A finished chop that still holds its item keeps a full bar; an emptied idle board does not.
  state.stations[2] = { ...state.stations[2], status: "ready", item: "LETTUCE", progress: 1 };
  assert.match(stationHtml(renderApp(state, 1_000), "chop1"), /data-progress="100"/);
});

test("reads station progress as 0..1 fractions, 0..100 percentages, or remaining/total seconds", () => {
  assert.equal(stationProgressPercent({ progress: 0.4 }), 40);
  assert.equal(stationProgressPercent({ progress: 1 }), 100);
  assert.equal(stationProgressPercent({ progress: 0 }), 0);
  assert.equal(stationProgressPercent({ progress: 40 }), 40);
  assert.equal(stationProgressPercent({ progress: 250 }), 100);
  assert.equal(stationProgressPercent({ progress: -1 }), 0);
  // No `progress` (or null): derive from remaining/total, never a fake 0.
  assert.equal(stationProgressPercent({ remainingSeconds: 3, totalSeconds: 12 }), 75);
  assert.equal(stationProgressPercent({ progress: null, remainingSeconds: 6, totalSeconds: 12 }), 50);
  assert.equal(stationProgressPercent({ remainingSeconds: 5, durationSeconds: 10 }), 50);
  assert.equal(stationProgressPercent({ remainingSeconds: 0, totalSeconds: 12 }), 100);
  assert.equal(stationProgressPercent({}), 0);
  assert.equal(stationProgressPercent(undefined), 0);

  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.stations = [{ id: "stove1", label: "STOVE 1", kind: "stove", status: "cooking", remainingSeconds: 3, totalSeconds: 12, item: "RAW MEAT" }];
  assert.match(renderApp(state, 1_000), /class="station-progress-track"[^>]*data-progress="75"/);
});

test("colours an order's patience bar by its share of its own patience, not absolute seconds", () => {
  const cases = [
    // [remaining, total, urgency]: the Pi's orders run 8-35 s, the mock's 120 s.
    [30, 30, "is-healthy"],
    [21, 30, "is-healthy"],
    [20, 30, "is-warning"],
    [11, 30, "is-warning"],
    [10, 30, "is-critical"],
    [2, 8, "is-critical"],
    [5, 8, "is-warning"],
    [7, 8, "is-healthy"],
    [120, 120, "is-healthy"],
    [80, 120, "is-warning"],
    [40, 120, "is-critical"],
    [100, 120, "is-healthy"],
  ];
  for (const [remaining, total, urgency] of cases) {
    const state = createInitialMockState(1_000);
    state.setup.phase = SETUP_PHASES.RUNNING;
    state.floorPlan.accepted = true;
    state.clock.status = "running";
    state.orders = [{ ...state.orders[0], remainingSeconds: remaining, totalSeconds: total }];
    state.order = { ...state.orders[0] };
    const html = renderApp(state, 1_000);
    assert.match(html, new RegExp(`class="hud-order ${urgency}"[^>]*data-order-id="order-1"`), `${remaining}/${total} is ${urgency}`);
    const width = Math.max(0, Math.min(100, (remaining / total) * 100));
    assert.match(html, new RegExp(`class="hud-order-progress"[^>]*aria-valuenow="${Math.round(width)}"[^>]*><span style="width:${width}%"`));
  }
});

test("round clock is four minutes (240 s) in the mock, matching the Pi's ROUND_SECONDS", async () => {
  const initial = createInitialMockState(1_000);
  assert.deepEqual(initial.clock, { status: "ready", remainingSeconds: 240, totalSeconds: 240 });
  assert.equal(createInitialProjectionState(1_000).clock.totalSeconds, 240);

  const running = await runningMockState();
  assert.equal(running.clock.status, "running");
  assert.equal(running.clock.remainingSeconds, 240);
  assert.equal(running.clock.totalSeconds, 240);
  const html = renderApp(running, 1_000);
  assert.match(html, /class="hud-timer-value">04:00</);
  assert.match(html, /Round timer 04:00/);
  // Per-order patience is separate and stays two minutes for mock orders.
  assert.ok(running.orders.every((order) => order.totalSeconds === 120));
  const preGame = renderApp(await approvedTransport().then((t) => t.snapshot()), 1_000);
  assert.match(preGame, /Welcome to [\s\S]*UnderCooked Interactive Tour/);
  assert.match(preGame, /data-order-count="1"/);
  assert.match(preGame, /class="hud-timer-value">04:00</);
});

test("advanceMockState counts the round clock and active orders down with recomputed patience segments", async () => {
  const start = await runningMockState();
  const before = structuredClone(start);
  const next = advanceMockState(start, 1_000, 2_000);

  assert.deepEqual(start, before, "the input state is not mutated");
  assert.equal(next.clock.remainingSeconds, 239);
  assert.equal(next.clock.status, "running");
  assert.ok(next.orders.every((order) => order.remainingSeconds === 119 && order.status === "active"));
  assert.equal(next.order.remainingSeconds, 119);
  assert.equal(next.orders[0].patience.filledSegments, 3);

  // 80 s in, a 120 s order has 40 s left: one patience segment.
  const later = advanceMockState(start, 80_000, 81_000);
  assert.equal(later.orders[0].remainingSeconds, 40);
  assert.equal(later.orders[0].patience.filledSegments, 1);
  assert.equal(advanceMockState(start, 40_000, 41_000).orders[0].patience.filledSegments, 2);
  assert.equal(later.clock.remainingSeconds, 160);
  assert.equal(validateFrontendSnapshot(later).valid, true);

  // Sub-second ticks accumulate: two half-seconds make one second (whole seconds round up like the Pi).
  const half = advanceMockState(start, 500, 1_500);
  assert.equal(half.clock.remainingSeconds, 240);
  assert.equal(advanceMockState(half, 500, 2_000).clock.remainingSeconds, 239);
  assert.equal(advanceMockState(advanceMockState(half, 500, 2_000), 1_000, 3_000).clock.remainingSeconds, 238);
});

test("advanceMockState expires an order that runs out and keeps the snapshot valid", async () => {
  const start = await runningMockState();
  const next = advanceMockState(start, 120_000, 121_000);

  assert.ok(next.orders.every((order) => order.status === "expired" && order.remainingSeconds === 0));
  assert.ok(next.orders.every((order) => order.patience.filledSegments === 0));
  assert.equal(next.clock.remainingSeconds, 120);
  assert.equal(next.setup.phase, SETUP_PHASES.RUNNING);
  assert.equal(validateFrontendSnapshot(next).valid, true);
  assert.match(renderApp(next, 121_000), /All orders served!/);

  // Only the shortest-patience order expires when the others still have time.
  const staggered = structuredClone(start);
  staggered.orders[1].remainingSeconds = 5;
  staggered.orders[1].patience.filledSegments = 1;
  const partial = advanceMockState(staggered, 5_000, 6_000);
  assert.equal(partial.orders[1].status, "expired");
  assert.equal(partial.orders[0].status, "active");
  assert.equal(partial.order.id, "order-1");
});

test("advanceMockState runs a stove through cooking, done, warning, then burnt like the Pi", async () => {
  const start = await runningMockState();
  // The round's first tick restarts the fixture's stove at the Pi's 15 s cook.
  const stove = (state) => state.stations.find((station) => station.id === "stove1");
  assert.equal(stove(start).status, "cooking");
  assert.equal(stove(start).progress, 0);
  assert.equal(stove(start).remainingSeconds, 15);
  assert.equal(stove(start).warning, false);

  const half = advanceMockState(start, 7_500, 8_500);
  assert.equal(stove(half).status, "cooking");
  assert.equal(stove(half).progress, 0.5);
  assert.equal(stove(half).remainingSeconds, 8);
  assert.equal(stationProgressPercent(stove(half)), 50);

  const done = advanceMockState(half, 7_500, 16_000);
  assert.equal(stove(done).status, "done");
  assert.equal(stove(done).progress, 1);
  assert.equal(stove(done).remainingSeconds, 2);
  assert.equal(stove(done).item, "COOKED MEAT");
  assert.match(renderApp(done, 16_000), /data-station="stove1"[^>]*>[\s\S]*?data-station-phase="cooked"/);

  const warning = advanceMockState(done, 2_000, 18_000);
  assert.equal(stove(warning).status, "warning");
  assert.equal(stove(warning).remainingSeconds, 3);
  assert.equal(stove(warning).warning, true);
  assert.match(renderApp(warning, 18_000), /data-station="stove1"[^>]*>[\s\S]*?data-station-warning="true"/);

  const burnt = advanceMockState(warning, 3_000, 21_000);
  assert.equal(stove(burnt).status, "burnt");
  assert.equal(stove(burnt).progress, 1);
  assert.equal(stove(burnt).remainingSeconds, 0);
  assert.equal(stove(burnt).item, "BURNT MEAT");
  assert.match(renderApp(burnt, 21_000), /data-station="stove1"[^>]*>[\s\S]*?data-station-phase="burnt"/);
  assert.equal(advanceMockState(burnt, 60_000, 81_000).stations.find((station) => station.id === "stove1").status, "burnt");

  // One long jump lands on the same phase as stepping through them.
  assert.equal(stove(advanceMockState(start, 15_000, 16_000)).status, "done");
  assert.equal(stove(advanceMockState(start, 17_000, 18_000)).status, "warning");
  assert.equal(stove(advanceMockState(start, 20_000, 21_000)).status, "burnt");
  // An idle stove is left alone.
  assert.deepEqual(half.stations.find((station) => station.id === "stove2"), start.stations.find((station) => station.id === "stove2"));
  assert.equal(validateFrontendSnapshot(burnt).valid, true);
});

test("advanceMockState finishes a chop at its total time and leaves it ready", async () => {
  const start = await runningMockState();
  const chop = (state) => state.stations.find((station) => station.id === "chop2");
  assert.equal(chop(start).status, "chopping");
  assert.equal(chop(start).progress, 0);
  assert.equal(chop(start).remainingSeconds, chop(start).totalSeconds);

  const total = chop(start).totalSeconds;
  const half = advanceMockState(start, (total / 2) * 1_000, 5_000);
  assert.equal(chop(half).status, "chopping");
  assert.equal(chop(half).progress, 0.5);
  assert.equal(chop(half).remainingSeconds, Math.ceil(total / 2));

  const finished = advanceMockState(half, (total / 2) * 1_000, 9_000);
  assert.equal(chop(finished).status, "ready");
  assert.equal(chop(finished).progress, 1);
  assert.equal(chop(finished).remainingSeconds, 0);
  assert.equal(chop(finished).item, "CHEESE");
  assert.deepEqual(chop(advanceMockState(finished, 5_000, 14_000)), chop(finished));

  // A chop with no total falls back to the Pi's 3 s chop.
  const bare = { ...start, stations: [{ id: "chop2", label: "CHOP 2", kind: "chop", status: "chopping", item: "LETTUCE" }] };
  assert.equal(bare.stations[0].totalSeconds, undefined);
  assert.equal(advanceMockState(bare, 1_500, 2_500).stations[0].progress, 0.5);
  assert.equal(advanceMockState(bare, 3_000, 4_000).stations[0].status, "ready");
});

test("advanceMockState ends the round when the clock reaches zero", async () => {
  const start = await runningMockState();
  const nearEnd = { ...start, clock: { ...start.clock, remainingSeconds: 3 } };

  const almost = advanceMockState(nearEnd, 2_999, 5_000);
  assert.equal(almost.setup.phase, SETUP_PHASES.RUNNING);
  assert.equal(almost.clock.remainingSeconds, 1);

  const ended = advanceMockState(nearEnd, 3_000, 5_000);
  assert.equal(ended.setup.phase, SETUP_PHASES.ENDED);
  assert.equal(ended.setup.updatedAt, 5_000);
  assert.equal(ended.clock.status, "ended");
  assert.equal(ended.clock.remainingSeconds, 0);
  assert.equal(ended.clock.totalSeconds, 240);
  assert.ok(ended.orders.every((order) => order.status !== "active"));
  assert.equal(ended.burgerLevel.status, "ended");
  assert.ok(ended.stations.filter((station) => station.kind === "stove" || station.kind === "chop")
    .every((station) => station.status === "idle" && station.progress === 0 && station.item === null));
  assert.equal(displayModeForPhase(ended.setup.phase), UI_DISPLAY_MODES.RESULTS);
  assert.equal(validateFrontendSnapshot(ended).valid, true);
  assert.match(renderApp(ended, 5_000), /data-display-mode="results"/);

  // A finished round no longer advances.
  assert.equal(advanceMockState(ended, 10_000, 15_000), ended);
});

test("advanceMockState does nothing unless a round is running and time has passed", async () => {
  const running = await runningMockState();
  for (const elapsed of [0, -5, Number.NaN, undefined, "abc", Infinity * 0]) {
    assert.equal(advanceMockState(running, elapsed, 2_000), running, `elapsed ${elapsed}`);
  }
  const idle = createInitialMockState(1_000);
  assert.equal(advanceMockState(idle, 5_000, 6_000), idle);
  const approved = await approvedTransport().then((transport) => transport.snapshot());
  assert.equal(advanceMockState(approved, 5_000, 6_000), approved);
  const readyClock = { ...running, clock: { ...running.clock, status: "ready" } };
  assert.equal(advanceMockState(readyClock, 5_000, 6_000), readyClock);
  assert.equal(advanceMockState(null, 1_000, 2_000), null);
  // A new round resets everything advanced by the previous one.
  const advanced = advanceMockState(running, 50_500, 60_000);
  assert.equal(advanced.clock.remainingSeconds, 190);
  const restarted = structuredClone({ ...advanced, setup: { ...advanced.setup, phase: SETUP_PHASES.BURGER_PLACEMENT } });
  restarted.clock.status = "ready";
  const transport = createMockTransport({ initialState: restarted, now: () => 70_000 });
  await transport.command(GAME_ACTIONS.START_GAME);
  const fresh = transport.snapshot();
  assert.equal(fresh.clock.remainingSeconds, 240);
  assert.ok(fresh.orders.every((order) => order.remainingSeconds === 120 && order.patience.filledSegments === 3));
  assert.equal(advanceMockState(fresh, 1_000, 71_000).clock.remainingSeconds, 239);
});

test("the mock heartbeat advances a running round by the real elapsed time and ignores a frozen clock", async () => {
  let now = 10_000;
  const transport = createMockTransport({ now: () => now });
  const seen = [];
  const stop = transport.connect((snapshot) => seen.push(snapshot));
  try {
    await transport.command(GAME_ACTIONS.START_HOST);
    await transport.command(GAME_ACTIONS.SCAN_ROOM);
    await transport.command(GAME_ACTIONS.APPROVE_LAYOUT);
    await transport.command(GAME_ACTIONS.START_GAME);
    assert.equal(transport.snapshot().clock.remainingSeconds, 240);

    // Frozen `now`: the heartbeat fires but no time has passed, so nothing moves.
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    assert.equal(transport.snapshot().clock.remainingSeconds, 240);
    assert.equal(transport.snapshot().orders[0].remainingSeconds, 120);

    // 7 s of "real" time pass: the next heartbeat applies exactly that.
    now += 7_000;
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    assert.equal(transport.snapshot().clock.remainingSeconds, 233);
    assert.equal(transport.snapshot().orders[0].remainingSeconds, 113);
    assert.equal(transport.snapshot().stations.find((station) => station.id === "stove1").remainingSeconds, 8);
    assert.equal(seen.at(-1).clock.remainingSeconds, 233);
    // Player tracking is kept fresh by the same heartbeat.
    assert.equal(transport.snapshot().players[0].tracking.lastSeenAt, now);
  } finally {
    stop();
    transport.close();
  }
});
