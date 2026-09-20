// (1) An order banner is the same size whether one order or four are open.
// (2) Coins lost to penalties are shown, not just coins earned.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ServerProjection } from "../../server/src/projection.mjs";
import { LocalFloorplanProvider } from "../../server/src/provider.mjs";
import { normalizeServerSnapshot } from "../src/server-snapshot.js";
import { normalizeFrontendSnapshot } from "../src/contracts.js";
import { advanceMockState, createInitialMockState, createMockTransport } from "../src/mock-transport.js";
import { renderApp } from "../src/render.js";
import { GAME_ACTIONS, SETUP_PHASES } from "../src/state.js";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function runningWithOrders(count) {
  const state = createInitialMockState(1_000);
  state.setup.phase = SETUP_PHASES.RUNNING;
  state.floorPlan.accepted = true;
  state.clock.status = "running";
  state.orders = state.orders.slice(0, count);
  state.order = { ...state.orders[0] };
  return state;
}

test("the order strip uses the four-slot layout and identical card classes for 1, 2, 3, and 4 orders", () => {
  const signatures = new Set();
  for (const count of [1, 2, 3, 4]) {
    const html = renderApp(runningWithOrders(count), 1_000);
    assert.match(html, new RegExp(`data-order-count="${count}"`));
    const strip = html.match(/class="(game-board-orders[^"]*)"/)[1];
    assert.equal(strip, "game-board-orders orders-4", `${count} orders`);
    const cards = [...html.matchAll(/class="(hud-order [^"]*)" data-node-id="39:26"/g)].map((m) => m[1].replace(/ is-(healthy|warning|critical)/, ""));
    assert.equal(cards.length, count);
    cards.forEach((card) => signatures.add(card));
  }
  assert.equal(signatures.size, 1, "every card carries the same size classes whatever the order count");
});

test("no stylesheet rule sizes the order strip by how many orders are open", () => {
  assert.doesNotMatch(css, /\.orders-[123]\b/);
  assert.match(css, /\.game-board-orders\.orders-4 \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
});

async function serverRound() {
  let now = Date.now();
  const projection = new ServerProjection({ provider: new LocalFloorplanProvider({ now: () => now }), now: () => now, orderIntervalMinSeconds: 30, orderIntervalMaxSeconds: 30, random: () => 0, orderPatienceSeconds: 20 });
  await projection.proposeFloorplan({ photos: [{ id: "fixture" }] }, now);
  projection.approveFloorplan(true, now);
  projection.command("START_GAME", {}, now);
  projection.ingestHostControl({ control: "START", durationSeconds: 240, framing: "legacy-game" }, now);
  return {
    projection,
    get now() { return now; },
    advance(ms) { now += ms; },
    view() {
      const state = normalizeFrontendSnapshot(normalizeServerSnapshot(projection.snapshot(now)));
      return { state, html: renderApp(state, now, "", "http") };
    },
  };
}

// The announcement pill's text, e.g. "Wrong burger" + "-25 WatCoins".
const announcement = (html) => {
  const match = html.match(/class="delivery-toast[^"]*"[^>]*><span class="delivery-toast-message">([^<]*)<\/span>(?:<span class="delivery-toast-amount">([^<]*)<\/span>)?/);
  return match ? { message: match[1], amount: match[2] ?? null } : null;
};

test("a wrong plate announces the WatCoins lost and turns the negative total red", async () => {
  const game = await serverRound();
  const p3 = game.projection._player("p3");
  game.projection.ingestPlayerAction({ playerId: "p3", action: "PLATE", plate: "-M--" }, game.now);
  for (const playerId of ["p1", "p2"]) game.projection.ingestPlayerAction({ playerId, action: "READY" }, game.now);
  game.projection.submit(p3, "-M--", game.now);
  const { state, html } = game.view();
  assert.equal(state.score.value, -25);
  assert.deepEqual(announcement(html), { message: "Wrong burger", amount: "-25 WatCoins" });
  assert.match(html, /class="board-score-value is-negative">-25</);
  assert.match(html, /aria-label="-25 WatCoins/);

  game.advance(4_000);
  assert.equal(announcement(game.view().html), null, "the announcement fades; the total stays");
  assert.match(game.view().html, /class="board-score-value is-negative">-25</);
});

test("a served burger announces the WatCoins gained, matching the counter", async () => {
  const game = await serverRound();
  const target = game.projection._activeOrders()[0];
  const summary = ["BUN", "MEAT", "LETTUCE", "CHEESE"].map((c) => target.components.includes(c) ? c[0] : "-").join("");
  game.projection.ingestPlayerAction({ playerId: "p3", action: "PLATE", plate: summary }, game.now);
  for (const playerId of ["p1", "p2"]) game.projection.ingestPlayerAction({ playerId, action: "READY" }, game.now);
  game.projection.submit(game.projection._player("p3"), target.recipe, game.now);
  const { state, html } = game.view();
  const served = announcement(html);
  assert.equal(served.message, "Burger served");
  assert.equal(served.amount, `+${state.gold.total + state.tips.total} WatCoins`);
  assert.equal(state.score.value, state.gold.total + state.tips.total, "the counter moves by exactly the announced amount");
  assert.doesNotMatch(html, /board-score-value is-negative/);
});

test("an order that expires announces the WatCoins it cost", async () => {
  const game = await serverRound();
  game.advance(20_000);
  const { state, html } = game.view();
  assert.equal(state.score.value, -20);
  assert.deepEqual(announcement(html), { message: "Order expired", amount: "-20 WatCoins" });
});

test("the offline mock charges the same penalties: wrong plate -25, expired order -20", async () => {
  let now = 10_000;
  const transport = createMockTransport({ now: () => now, random: () => 0.999999 });
  try {
    for (const command of [GAME_ACTIONS.START_HOST, GAME_ACTIONS.SCAN_ROOM, GAME_ACTIONS.APPROVE_LAYOUT, GAME_ACTIONS.START_GAME]) await transport.command(command);
    const wrong = await transport.command(GAME_ACTIONS.DELIVERY_FAILURE);
    assert.equal(wrong.score.value, -25);
    assert.deepEqual(wrong.penalties, { total: 25, lastChange: -25 });
    const html = renderApp(wrong, now);
    assert.deepEqual(announcement(html), { message: "Wrong burger", amount: "-25 WatCoins" });
  } finally {
    transport.close();
  }

  const start = createInitialMockState(1_000);
  start.setup.phase = SETUP_PHASES.RUNNING;
  start.clock.status = "running";
  start.orders = [{ ...start.orders[0], remainingSeconds: 2, totalSeconds: 60 }];
  start.order = { ...start.orders[0] };
  const later = advanceMockState(start, 2_000, 50_000);
  assert.equal(later.orders[0].status, "expired");
  assert.equal(later.orders[0].expiredAt, 50_000);
  assert.equal(later.score.value, -20);
  assert.deepEqual(later.penalties, { total: 20, lastChange: -20 });
  const html = renderApp(later, 50_500);
  assert.deepEqual(announcement(html), { message: "Order expired", amount: "-20 WatCoins" });
});

test("the results screen itemizes the penalties that took coins away", async () => {
  const game = await serverRound();
  game.advance(20_000);
  game.view(); // the server ticks continuously; let the expiry land before the round ends
  game.projection.endGame(game.now);
  const { html } = game.view();
  assert.match(html, /data-onboarding="results"/);
  assert.match(html, /data-result-stat="penalties"><strong>-20<\/strong>/);
});
