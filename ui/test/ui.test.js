import test from "node:test";
import assert from "node:assert/strict";
import { createInitialMockState, createMockTransport } from "../src/mock-transport.js";
import { renderApp } from "../src/render.js";
import { GAME_ACTIONS, SETUP_PHASES } from "../src/state.js";

test("renders the authoritative accepted floor plan and live game snapshot", () => {
  const html = renderApp(createInitialMockState(1_000), 1_000);

  assert.match(html, /Accepted floor plan/);
  assert.match(html, /data-player="p1"/);
  assert.match(html, /data-player="p2"/);
  assert.match(html, /TOMATO SOUP/);
  assert.match(html, /POT 1/);
  assert.match(html, /64%/);
  assert.match(html, />0<\/h2>/);
  assert.match(html, /01:18/);
  assert.match(html, /TRACKING COVERAGE HEALTHY/);
});

test("marks an old player position and worker heartbeat stale", () => {
  const state = createInitialMockState(1_000);
  state.players[1].tracking.lastSeenAt = 0;
  state.health.workers[1].lastSeenAt = 0;

  const html = renderApp(state, 7_000);

  assert.match(html, /data-player="p2" data-stale="true"/);
  assert.match(html, /P2[\s\S]*TRACKING STALE/);
  assert.match(html, /CAMERA 2[\s\S]*STALE/);
  assert.match(html, /TRACKING DEGRADED/);
});

test("host commands move setup through scan, approval, start, and end", async () => {
  let now = 10_000;
  const transport = createMockTransport({ now: () => now });

  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.LAYOUT_ACCEPTED);
  await transport.command(GAME_ACTIONS.SCAN_ROOM);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.LAYOUT_PROPOSED);
  assert.equal(transport.snapshot().floorPlan.accepted, false);

  await transport.command(GAME_ACTIONS.ACCEPT_LAYOUT);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.LAYOUT_ACCEPTED);
  assert.equal(transport.snapshot().floorPlan.accepted, true);

  now += 1_000;
  await transport.command(GAME_ACTIONS.START_GAME);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.RUNNING);
  assert.equal(transport.snapshot().clock.status, "running");

  await transport.command(GAME_ACTIONS.END_GAME);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.ENDED);
  assert.equal(transport.snapshot().clock.status, "ended");

  await transport.command(GAME_ACTIONS.RESCAN);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.LAYOUT_PROPOSED);
  await transport.command(GAME_ACTIONS.ACCEPT_LAYOUT);
  await transport.command(GAME_ACTIONS.RESET_GAME);
  assert.equal(transport.snapshot().setup.phase, SETUP_PHASES.LAYOUT_ACCEPTED);
  assert.equal(transport.snapshot().score.value, 0);
});

test("renders delivery success and score update from the transport snapshot", async () => {
  const transport = createMockTransport({ initialState: createInitialMockState(1_000), now: () => 2_000 });
  await transport.command(GAME_ACTIONS.DELIVERY_SUCCESS);
  const state = transport.snapshot();

  assert.equal(state.score.value, 100);
  assert.equal(state.order.status, "completed");
  const html = renderApp(state, 2_000);
  assert.match(html, /ORDER COMPLETE/);
  assert.match(html, /\+100/);
  assert.match(html, /class="delivery-panel panel delivery-success"/);
});

test("renders rejected delivery without changing score", async () => {
  const transport = createMockTransport({ initialState: createInitialMockState(1_000), now: () => 2_000 });
  await transport.command(GAME_ACTIONS.DELIVERY_FAILURE);
  const state = transport.snapshot();

  assert.equal(state.score.value, 0);
  assert.equal(state.order.status, "active");
  const html = renderApp(state, 2_000);
  assert.match(html, /WRONG ORDER/);
  assert.match(html, /NO SCORE/);
  assert.match(html, /class="delivery-panel panel delivery-failure"/);
});
