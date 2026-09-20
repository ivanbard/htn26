// "Never stranded": every screen the setup-to-play flow can land on must offer a
// visible way forward or back, whatever fails. Each test names the dead end it guards.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  App,
  AppErrorBoundary,
  measureTourTargets,
  resolveTourTargetInfo,
  tourStepsForOrder,
  unmeasuredTargetInfo,
} from "../src/App.js";
import { createApp } from "../src/main.js";
import { createInitialMockState } from "../src/mock-transport.js";
import { renderApp } from "../src/render.js";
import { SETUP_PHASES } from "../src/state.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const html = (props) => renderToStaticMarkup(React.createElement(App, props));
const scanning = (mutate) => {
  const state = createInitialMockState(1_000);
  state.setup = { ...state.setup, phase: SETUP_PHASES.SCANNING };
  mutate?.(state);
  return state;
};

// ---- screens with no state, or state we cannot read --------------------------------

test("waiting for state (server down at first load) offers retry, reload, and the offline demo", () => {
  const withRetry = html({ state: null, connectionError: "GAME SERVER UNAVAILABLE — x", onRetryConnect() {} });
  assert.match(withRetry, /data-escape="retry"[^>]*>Try again now</);
  assert.match(withRetry, /data-escape="reload"/);
  assert.match(withRetry, /href="\?transport=mock"[^>]*>Open the offline demo</);
  assert.match(withRetry, /id="ui-error"/, "the reason is still shown");
});

test("a snapshot the UI cannot read (e.g. a phase it has never heard of) offers reload and reset", () => {
  const state = createInitialMockState(1_000);
  state.setup = { ...state.setup, phase: "some-new-server-phase" };
  const page = html({ state, onCommand() {} });
  assert.match(page, /Authoritative state unavailable/);
  assert.match(page, /data-escape="reload"/);
  assert.match(page, /data-escape="reset"[^>]*data-command="RESET_GAME"/);
  assert.doesNotMatch(renderApp(state, 1_000), /PLAYER 1/, "no game values are drawn from unreadable state");
});

// ---- a render exception must not blank the page ----------------------------------

test("the error boundary shows a way out instead of a blank page, and clears on a newer snapshot", () => {
  const error = new Error("boom");
  assert.deepEqual(AppErrorBoundary.getDerivedStateFromError(error), { error });

  const boundary = new AppErrorBoundary({ resetKey: "running:5", onCommand() {}, children: null });
  boundary.state = { ...boundary.state, ...AppErrorBoundary.getDerivedStateFromError(error) };
  const fallback = renderToStaticMarkup(boundary.render());
  assert.match(fallback, /data-render-error="true"/);
  assert.match(fallback, /Something went wrong drawing this screen/);
  for (const action of ["try-again", "reload", "reset"]) assert.match(fallback, new RegExp(`data-escape="${action}"`), action);

  // Same snapshot: stays on the message (no error loop). A newer one: recovers.
  assert.equal(AppErrorBoundary.getDerivedStateFromProps({ resetKey: "running:5" }, { error, resetKey: "running:5" }), null);
  assert.deepEqual(AppErrorBoundary.getDerivedStateFromProps({ resetKey: "running:6" }, { error, resetKey: "running:5" }), { error: null, resetKey: "running:6" });
  // The "Try again" button clears it by hand.
  let cleared;
  boundary.setState = (next) => { cleared = next; };
  boundary.tryAgain();
  assert.deepEqual(cleared, { error: null });
});

// ---- player setup: hardware must never be the only way forward --------------------

test("with no badges connected there is still a clearly labelled way to continue", () => {
  const state = scanning((s) => { s.players = []; });
  const page = renderApp(state, 1_000, "", "http");
  assert.match(page, /player-setup-continue" disabled="" data-command="SCAN_ROOM">Continue with Normal Room Layout/, "the normal button stays gated");
  assert.match(page, /No badges are connected yet/);
  assert.match(page, /player-setup-continue-anyway[^>]*>Continue anyway</);
  assert.doesNotMatch(page, /player-setup-continue-anyway[^>]*disabled/);
});

test("once a badge is connected the extra 'Continue anyway' is not shown", () => {
  const page = renderApp(scanning(), 1_000, "", "http");
  assert.doesNotMatch(page, /Continue anyway|No badges are connected yet/);
});

test("continuing anyway follows the same route the primary button would (personalized when photos are in)", () => {
  const photos = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const state = scanning((s) => { s.players = []; s.photos = photos; });
  const page = renderApp(state, 1_000, "", "http");
  assert.match(page, /Continue with Personalized Room Layout/);
  assert.match(page, /player-setup-continue-anyway/);
});

test("after the personalized layout fails, the normal layout comes first and the personalized one can be retried", () => {
  const state = scanning((s) => { s.photos = [{ id: "a" }, { id: "b" }, { id: "c" }]; });
  const page = renderApp(state, 1_000, "ROOM LAYOUT FAILED — Room layout generation failed (503)", "http");
  assert.match(page, /data-command="SCAN_ROOM">Continue with Normal Room Layout/);
  assert.match(page, /player-setup-retry-personalized[^>]*>Try the personalized layout again</);
  assert.doesNotMatch(page, /player-setup-retry-personalized[^>]*disabled/);
});

// ---- tour: nothing may hide its own buttons --------------------------------------

const fakeBoard = ({ width, height, targets = [], throwOn }) => ({
  getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
  querySelectorAll: () => {
    if (throwOn) throw new Error("selector exploded");
    return targets.map(([left, top, w, h]) => ({ getBoundingClientRect: () => ({ left, top, width: w, height: h, right: left + w, bottom: top + h }) }));
  },
});
const step = { key: "chop", target: "station" };

test("a board that measures 0x0 (hidden tab, tiny window) yields 'nothing to point at', not 'no answer'", () => {
  assert.equal(measureTourTargets(fakeBoard({ width: 0, height: 0 }), step), null, "the raw measurement has no answer");
  const info = resolveTourTargetInfo(fakeBoard({ width: 0, height: 0 }), step);
  assert.deepEqual(info, unmeasuredTargetInfo(step));
  assert.equal(info.bounds, null);
  assert.equal(info.stepKey, "chop", "and it belongs to the step being shown");
});

test("a measurement that throws, or a missing board, also resolves to 'nothing to point at'", () => {
  assert.equal(resolveTourTargetInfo(fakeBoard({ width: 800, height: 400, throwOn: true }), step).bounds, null);
  assert.equal(resolveTourTargetInfo(null, step).bounds, null);
  assert.equal(resolveTourTargetInfo(undefined, step).stepKey, "chop");
});

test("a real measurement is still used when there is one", () => {
  const info = resolveTourTargetInfo(fakeBoard({ width: 800, height: 400, targets: [[100, 100, 50, 50]] }), step);
  assert.ok(info.bounds);
  assert.equal(info.rects.length, 1);
});

test("every tour step exists for odd plans: no stations, unknown ids, no order", () => {
  for (const plan of [undefined, { stations: [] }, { stations: [{ id: "zzz", kind: "mystery" }] }, { stations: null }]) {
    for (const order of [undefined, {}, { components: [] }, { components: ["BUN"] }]) {
      const steps = tourStepsForOrder(order, plan);
      assert.equal(steps.length, 6);
      assert.ok(steps.every((s) => s.key && s.title && s.detail && s.control && ["order", "station", "players"].includes(s.target)));
    }
  }
});

// ---- main.js handlers -------------------------------------------------------------

const fakeRoot = () => ({ innerHTML: "", addEventListener() {}, removeEventListener() {} });
function harness(overrides = {}) {
  let listener;
  const calls = [];
  const transport = {
    kind: "http",
    async connect(next) { listener = next; return () => {}; },
    async command(command) { calls.push(command); return overrides.command ? overrides.command(command) : undefined; },
    ...overrides.transport,
    close() {},
  };
  const app = createApp({ root: fakeRoot(), transport });
  return { app, calls, push: (state) => listener(state) };
}

test("a failed command shows why, and the notice can be dismissed", async () => {
  const h = harness({ command: () => { throw Object.assign(new Error("Game server command failed (500)")); } });
  h.push(scanning());
  await flush();
  await h.app.actions.onCommand("SCAN_ROOM");
  assert.match(h.app.getConnectionError(), /^COMMAND NOT SENT — Game server command failed \(500\)/);
  h.app.actions.onDismissError();
  assert.equal(h.app.getConnectionError(), "");
  h.app.destroy();
});

test("a failure that arrives after the game already moved on is not reported (double click)", async () => {
  let release;
  const h = harness({ command: () => new Promise((_, reject) => { release = () => reject(new Error("Game server command failed (500)")); }) });
  h.push(scanning());
  await flush();
  const pending = h.app.actions.onCommand("START_GAME");
  h.push({ ...scanning(), setup: { ...scanning().setup, phase: SETUP_PHASES.RUNNING } }); // the server got there first
  release();
  await pending;
  assert.equal(h.app.getConnectionError(), "", "no stale red banner over a game that is running");
  h.app.destroy();
});

test("a notice about one screen is cleared when the game moves to another phase", async () => {
  const h = harness({ command: () => { throw new Error("nope"); } });
  h.push(scanning());
  await flush();
  await h.app.actions.onCommand("SCAN_ROOM");
  assert.match(h.app.getConnectionError(), /COMMAND NOT SENT/);
  h.push({ ...scanning(), setup: { ...scanning().setup, phase: SETUP_PHASES.BURGER_PLACEMENT } });
  assert.equal(h.app.getConnectionError(), "");
  h.app.destroy();
});

test("a command whose reply has no state keeps the screen instead of blanking it", async () => {
  const h = harness({ command: () => undefined });
  h.push(scanning());
  await flush();
  await h.app.actions.onCommand("SCAN_ROOM");
  assert.equal(h.app.getState().setup.phase, SETUP_PHASES.SCANNING);
  h.app.destroy();
});

test("clicking a layout choice twice runs it once, and a failure that lands after the game moved on is ignored", async () => {
  let runs = 0;
  let finish;
  const h = harness({ transport: { useDefaultLayout: () => { runs += 1; return new Promise((_, reject) => { finish = () => reject(new Error("Default room layout activation failed (500)")); }); } } });
  h.push(scanning());
  await flush();
  const first = h.app.actions.onUseDefaultLayout();
  const second = h.app.actions.onUseDefaultLayout();
  assert.equal(runs, 1, "the second click did not start another run");
  h.push({ ...scanning(), setup: { ...scanning().setup, phase: SETUP_PHASES.BURGER_PLACEMENT } }); // it actually worked
  finish();
  await Promise.all([first, second]);
  assert.equal(h.app.getConnectionError(), "", "no false failure banner");
  // ...and once it has finished, the choice can be used again.
  const retry = h.app.actions.onUseDefaultLayout();
  assert.equal(runs, 2);
  finish();
  await retry;
  h.app.destroy();
});

test("a real layout failure is reported and leaves the choice usable", async () => {
  let runs = 0;
  const h = harness({ transport: { generateRoomLayout: async () => { runs += 1; throw new Error("Room layout generation failed (503)"); } } });
  h.push(scanning());
  await flush();
  await h.app.actions.onGenerateLayout();
  assert.match(h.app.getConnectionError(), /^ROOM LAYOUT FAILED — Room layout generation failed \(503\)/);
  await h.app.actions.onGenerateLayout();
  assert.equal(runs, 2, "retry works");
  h.app.destroy();
});

test("'Try again now' on the waiting screen reconnects immediately instead of waiting out the timer", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let attempts = 0;
    const transport = { kind: "http", async connect() { attempts += 1; throw Object.assign(new Error("x"), { status: 500 }); }, async command() {}, close() {} };
    const app = createApp({ root: fakeRoot(), transport });
    await flush();
    assert.equal(attempts, 1);
    app.actions.onRetryConnect();
    await flush();
    assert.equal(attempts, 2, "no 3 s wait");
    app.destroy();
  } finally {
    mock.timers.reset();
  }
});
