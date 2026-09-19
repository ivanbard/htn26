import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/main.js";
import { createInitialMockState, createMockTransport } from "../src/mock-transport.js";
import { renderApp } from "../src/render.js";
import { GAME_ACTIONS, SETUP_PHASES } from "../src/state.js";

async function approvedTransport(now = 1_000) {
  const transport = createMockTransport({ now: () => now });
  await transport.command(GAME_ACTIONS.START_HOST);
  await transport.command(GAME_ACTIONS.SCAN_ROOM);
  await transport.command(GAME_ACTIONS.APPROVE_LAYOUT);
  return transport;
}

test("renders the approved burger floor plan, topping order, stations, and goose queue", async () => {
  const transport = await approvedTransport();
  const html = renderApp(transport.snapshot(), 1_000);

  assert.match(html, /Accepted burger floor plan/);
  assert.match(html, /BURGER LEVEL PLACEMENT/);
  assert.match(html, /data-player="p1"/);
  assert.match(html, /data-player="p2"/);
  assert.match(html, /BURGER/);
  assert.match(html, /CHEESE/);
  assert.match(html, /LETTUCE/);
  assert.match(html, /STOVE 1/);
  assert.match(html, /CHOP 3[\s\S]*MEAT[\s\S]*CHOPPING/);
  assert.match(html, /62%/);
  assert.match(html, /4 geese waiting/);
  assert.match(html, /01:52/);
});

test("marks old or missing player tracking and stale worker health", () => {
  const state = createInitialMockState(1_000);
  state.players[1].tracking.lastSeenAt = 0;
  delete state.players[0].position;
  state.health.workers[1].lastSeenAt = 0;

  const html = renderApp(state, 7_000);

  assert.match(html, /data-player="p1" data-stale="true"/);
  assert.match(html, /P1[\s\S]*TRACKING LOST/);
  assert.doesNotMatch(html, /data-player="p1"[^>]*style="left:0%;top:0%;/);
  assert.match(html, /data-player="p2" data-stale="true"/);
  assert.match(html, /P2[\s\S]*TRACKING STALE/);
  assert.match(html, /CAMERA 2[\s\S]*STALE/);
  assert.match(html, /TRACKING DEGRADED/);
});

test("host commands follow start, scan, approval, burger placement, and round lifecycle", async () => {
  let now = 10_000;
  const transport = createMockTransport({ now: () => now });

  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.IDLE);
  const idleHtml = renderApp(transport.snapshot(), now);
  assert.match(idleHtml, /data-command="RESCAN" disabled/);
  await transport.command(GAME_ACTIONS.RESCAN);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.IDLE);

  await transport.command(GAME_ACTIONS.START_HOST);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.SCANNING);
  await transport.command(GAME_ACTIONS.SCAN_ROOM);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.LAYOUT_PROPOSED);
  assert.equal(transport.snapshot().floorPlan.accepted, false);
  await transport.command(GAME_ACTIONS.RESCAN);
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

test("renders serving success and score update from the authoritative snapshot", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.DELIVERY_SUCCESS);
  const state = transport.snapshot();

  assert.equal(state.score.value, 100);
  assert.equal(state.order.status, "completed");
  const html = renderApp(state, 2_000);
  assert.match(html, /BURGER SERVED/);
  assert.match(html, /\+100/);
  assert.match(html, /delivery-success/);
});

test("renders rejected burger without changing score", async () => {
  const transport = await approvedTransport(1_000);
  await transport.command(GAME_ACTIONS.DELIVERY_FAILURE);
  const state = transport.snapshot();

  assert.equal(state.score.value, 0);
  assert.equal(state.order.status, "active");
  const html = renderApp(state, 2_000);
  assert.match(html, /WRONG BURGER/);
  assert.match(html, /NO SCORE/);
  assert.match(html, /delivery-failure/);
});

test("shows a connection error while waiting for authoritative state", () => {
  const html = renderApp(null, 1_000, "MASTER PI UNAVAILABLE — offline");
  assert.match(html, /id="ui-error" class="ui-error" role="alert"/);
  assert.match(html, /MASTER PI UNAVAILABLE — offline/);
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
