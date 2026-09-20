// Renders snapshots produced by the REAL server projection (not the offline
// mock). The mock and the server disagree on several shapes — `plate: []`,
// plate item names, ISO timestamps, the waiting-for-host phase, one stove tile —
// and the mock-only tests could not see any of that.
import assert from "node:assert/strict";
import test from "node:test";
import { ServerProjection } from "../../server/src/projection.mjs";
import { LocalFloorplanProvider } from "../../server/src/provider.mjs";
import { normalizeServerSnapshot } from "../src/server-snapshot.js";
import { normalizeFrontendSnapshot, validateFrontendSnapshot } from "../src/contracts.js";
import { renderApp } from "../src/render.js";
import { createHttpTransport } from "../src/transport.js";
import { createActionTracker } from "../src/action-tracker.js";

async function startedRound() {
  let now = 1_000_000;
  const projection = new ServerProjection({
    provider: new LocalFloorplanProvider({ now: () => now }),
    now: () => now,
    orderIntervalMinSeconds: 8,
    orderIntervalMaxSeconds: 8,
    random: () => 0,
  });
  await projection.proposeFloorplan({ photos: [{ id: "fixture" }] }, now);
  projection.approveFloorplan(true, now);
  projection.command("START_GAME", {}, now);
  // The HTTP transport runs every snapshot through this; do the same here.
  const tracker = createActionTracker(() => now);
  const game = {
    projection,
    get now() { return now; },
    advance(ms) { now += ms; },
    act(action) { return projection.ingestPlayerAction(action, now); },
    start() { projection.ingestHostControl({ control: "START", durationSeconds: 240, framing: "legacy-game" }, now); now += 300; },
    view() {
      const state = normalizeFrontendSnapshot(normalizeServerSnapshot(projection.snapshot(now)));
      state.players = tracker.annotate(state.players);
      return { state, html: renderApp(state, now, "", "http") };
    },
  };
  return game;
}

const chunkFor = (html, attribute, id) => (html.match(new RegExp(`${attribute}="${id}"[\\s\\S]*?(?=${attribute}="|$)`)) || [""])[0];
const spriteName = (chunk, marker) => chunk.match(new RegExp(`${marker}[^>]*src="[^"]*/([^"/]+)\\.png"`))?.[1];

test("waiting-for-host-start is a valid phase with its own screen, not the error screen", async () => {
  const game = await startedRound();
  const { state, html } = game.view();
  assert.equal(state.setup.phase, "waiting-for-host-start");
  assert.equal(validateFrontendSnapshot(state).valid, true);
  assert.match(html, /data-onboarding="waiting"/);
  assert.match(html, /Press START on the host badge/);
  assert.match(html, /Waiting for the host badge connection/);
  assert.match(html, /data-command="START_GAME">Check host connection/);
  assert.doesNotMatch(html, /Authoritative state unavailable/);
  assert.doesNotMatch(html, />Start Game</);
});

test("players without a plate are not drawn holding one, and their hands show the right sprite", async () => {
  const game = await startedRound();
  game.start();
  assert.doesNotMatch(game.view().html, /tracked-player[^"]*has-plate/);

  const expected = {
    BUN: "bun", RAW_MEAT: "meat_raw", CHOPPED_MEAT: "meat_flattened", COOKED_MEAT: "meat_cooked", BURNT_MEAT: "meat_burnt",
    RAW_LETTUCE: "lettuce_head", LETTUCE: "lettuce_leaf", RAW_CHEESE: "cheese_triangle", CHEESE: "cheese_slice",
  };
  for (const [item, sprite] of Object.entries(expected)) {
    game.act({ playerId: "p2", action: "DROP" });
    game.act({ playerId: "p2", action: "PICKUP", item });
    const chunk = chunkFor(game.view().html, "data-player", "p2");
    assert.equal(spriteName(chunk, "player-held-item[\\s\\S]*?"), sprite, `${item} in hand`);
  }
});

test("a held empty plate is still drawn as a plate", async () => {
  const game = await startedRound();
  game.start();
  game.act({ playerId: "p3", action: "PLATE", plate: "NEW" });
  const { html } = game.view();
  assert.match(chunkFor(html, "data-player", "p3"), /player-plate-sprite/);
  assert.doesNotMatch(chunkFor(html, "data-player", "p1"), /player-plate-sprite/);
});

test("every plate combination renders the sprite drawn for exactly those ingredients", async () => {
  const game = await startedRound();
  game.start();
  const parts = [["B", "bun"], ["M", "meat"], ["L", "lettuce"], ["C", "cheese"]];
  // Sprites drawn for each ingredient set (the only set with no art is cheese + lettuce).
  const art = {
    B: "plate_bun", M: "plate_meat_cooked", L: "plate_lettuce_leaf", C: "plate_cheese_slice",
    BM: "plate_bun_meat", BL: "plate_bun_lettuce", BC: "plate_bun_cheese", ML: "plate_meat_lettuce", MC: "plate_meat_cheese",
    BML: "plate_bun_meat_lettuce", BMC: "plate_bun_meat_cheese", BLC: "plate_bun_cheese_lettuce", MLC: "plate_meat_lettuce_cheese",
    BMLC: "plate_bun_meat_lettuce_cheese",
  };
  for (let mask = 1; mask < 16; mask += 1) {
    const summary = parts.map(([letter], bit) => (mask >> bit) & 1 ? letter : "-").join("");
    const key = summary.replaceAll("-", "");
    game.act({ playerId: "p3", action: "DROP" });
    game.act({ playerId: "p3", action: "PLATE", plate: "NEW" });
    game.act({ playerId: "p3", action: "PLATE", plate: summary });
    const chunk = chunkFor(game.view().html, "data-player", "p3");
    if (art[key]) assert.equal(spriteName(chunk, "player-plate-sprite"), art[key], `plate ${summary}`);
    else assert.equal(spriteName(chunk, "player-plate-sprite"), "plate", `plate ${summary} falls back to loose icons`);
  }
});

test("both logical stoves are drawn and show their own cooking state", async () => {
  const game = await startedRound();
  game.start();
  for (const [playerId, side] of [["p1", "LEFT"], ["p2", "RIGHT"]]) {
    game.act({ playerId, action: "PICKUP", item: "RAW_MEAT" });
    game.act({ playerId, action: "CHOP", phase: "START" });
    game.advance(3_500);
    game.act({ playerId, action: "CHOP", phase: "DONE", item: "CHOPPED_MEAT" });
    game.act({ playerId, action: "STOVE", side, operation: "PLACE" });
  }
  game.advance(3_000);
  const { state, html } = game.view();
  assert.deepEqual(state.floorPlan.stations.filter((s) => s.kind === "stove").map((s) => s.id), ["stove-left", "stove-right"]);
  for (const id of ["stove-left", "stove-right"]) {
    assert.match(chunkFor(html, "data-station", id), /data-station-phase="cooking"/, id);
  }
});

test("submission results and expired orders are announced with the server's ISO timestamps", async () => {
  const game = await startedRound();
  game.start();
  const player = game.projection._player("p3");
  const target = game.projection._activeOrders()[0];
  const summary = ["BUN", "MEAT", "LETTUCE", "CHEESE"].map((c) => target.components.includes(c) ? c[0] : "-").join("");

  game.act({ playerId: "p3", action: "PLATE", plate: summary });
  for (const playerId of ["p1", "p2"]) game.act({ playerId, action: "READY" });
  game.projection.submit(player, target.recipe, game.now);
  assert.equal(typeof game.projection.snapshot(game.now).serving.lastEvent.at, "string");
  assert.match(game.view().html, /delivery-toast is-success/);

  game.advance(4_000);
  assert.doesNotMatch(game.view().html, /delivery-toast/);

  game.act({ playerId: "p3", action: "PLATE", plate: "-M--" });
  for (const playerId of ["p1", "p2"]) game.act({ playerId, action: "READY" });
  game.projection.submit(player, "-M--", game.now);
  assert.match(game.view().html, /delivery-toast is-failure/);

  // Let an order run out of patience: the card leaves, so a toast must say why.
  game.advance(4_000);
  const before = game.projection.snapshot(game.now).orders.filter((order) => order.status === "expired").length;
  let expired = null;
  for (let step = 0; step < 240 && !expired; step += 1) {
    game.advance(1_000);
    const raw = game.projection.snapshot(game.now);
    if (raw.orders.filter((order) => order.status === "expired").length > before) expired = raw;
  }
  assert.ok(expired, "an order expired");
  assert.match(game.view().html, /Order expired/);
});

test("a cut abandoned mid-way shows a short callout over the player, then fades", async () => {
  const game = await startedRound();
  game.start();
  game.view();
  game.act({ playerId: "p1", action: "PICKUP", item: "RAW_MEAT" });
  game.view();
  game.act({ playerId: "p1", action: "CHOP", phase: "START" });
  game.view();
  game.advance(500);
  game.act({ playerId: "p1", action: "CHOP", phase: "FAIL" });
  assert.match(chunkFor(game.view().html, "data-player", "p1"), /data-player-action="CUT FAILED"/);
  game.advance(30_000);
  assert.doesNotMatch(chunkFor(game.view().html, "data-player", "p1"), /data-player-action/, "callout fades");
});

test("a finished cut is not reported as a failure", async () => {
  const game = await startedRound();
  game.start();
  game.view();
  game.act({ playerId: "p1", action: "PICKUP", item: "RAW_MEAT" });
  game.view();
  game.act({ playerId: "p1", action: "CHOP", phase: "START" });
  game.view();
  game.advance(3_500);
  game.act({ playerId: "p1", action: "CHOP", phase: "DONE", item: "CHOPPED_MEAT" });
  assert.doesNotMatch(chunkFor(game.view().html, "data-player", "p1"), /data-player-action="CUT FAILED"/);
});

test("the results screen shows the final score, stars, and order outcomes without serving-badge copy", async () => {
  const game = await startedRound();
  game.start();
  const target = game.projection._activeOrders()[0];
  const summary = ["BUN", "MEAT", "LETTUCE", "CHEESE"].map((c) => target.components.includes(c) ? c[0] : "-").join("");
  game.act({ playerId: "p3", action: "PLATE", plate: summary });
  for (const playerId of ["p1", "p2"]) game.act({ playerId, action: "READY" });
  game.projection.submit(game.projection._player("p3"), target.recipe, game.now);
  game.projection.endGame(game.now);

  const { state, html } = game.view();
  assert.equal(state.setup.phase, "ended");
  assert.match(html, /data-onboarding="results"/);
  assert.match(html, new RegExp(`aria-label="${state.score.value} WatCoins"`));
  assert.match(html, /data-result-stat="burgers-served"><strong>1<\/strong>/);
  assert.match(html, /data-stars="[123]"/);
  assert.doesNotMatch(html, /serving badge|geese/i);
});

test("through the real HTTP transport, an abandoned cut arrives labelled and stamped", async () => {
  const game = await startedRound();
  game.start();
  let latest = () => JSON.parse(JSON.stringify(game.projection.snapshot(game.now)));
  let listener;
  const transport = createHttpTransport({
    baseUrl: "http://x",
    fetchImpl: async () => ({ ok: true, json: async () => latest() }),
    eventSourceFactory: class { constructor() { this.handlers = {}; listener = this; } addEventListener(name, fn) { this.handlers[name] = fn; } close() {} },
  });
  const received = [];
  const stop = await transport.connect((snapshot) => received.push(snapshot));
  const push = () => listener.handlers.state({ data: JSON.stringify(latest()) });
  const p1 = () => received.at(-1).players.find((player) => player.id === "p1");

  game.act({ playerId: "p1", action: "PICKUP", item: "RAW_MEAT" }); push();
  game.act({ playerId: "p1", action: "CHOP", phase: "START" }); push();
  assert.equal(p1().actionState, "chopping");
  game.advance(500);
  game.act({ playerId: "p1", action: "CHOP", phase: "FAIL" }); push();
  assert.equal(p1().actionState, "cut failed; holding raw_meat");
  assert.equal(typeof p1().actionStateAt, "number", "stamped by the browser");
  stop();
});
