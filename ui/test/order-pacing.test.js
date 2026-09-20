// Order pacing: a round opens with ONE order, more arrive after a random gap,
// there are never more than three open, and the kitchen is never left without
// one. The offline mock must behave like server/src/projection.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { ServerProjection, ORDER_RULES } from "../../server/src/projection.mjs";
import { LocalFloorplanProvider } from "../../server/src/provider.mjs";
import { validateFrontendSnapshot } from "../src/contracts.js";
import { advanceMockState, createMockTransport } from "../src/mock-transport.js";
import { GAME_ACTIONS } from "../src/state.js";

async function runningMock({ random = () => 0 } = {}) {
  let now = 1_000;
  const transport = createMockTransport({ now: () => now, random });
  for (const command of [GAME_ACTIONS.START_HOST, GAME_ACTIONS.SCAN_ROOM, GAME_ACTIONS.APPROVE_LAYOUT, GAME_ACTIONS.START_GAME]) {
    await transport.command(command);
  }
  const state = transport.snapshot();
  transport.close();
  return { state, random, at: () => now };
}

const active = (state) => state.orders.filter((order) => order.status === "active");

test("a round opens with a single order and schedules the next one", async () => {
  const { state } = await runningMock();
  assert.equal(state.orders.length, 1);
  assert.equal(state.order.id, "order-1");
  assert.equal(state.orders[0].status, "active");
  assert.equal(state.orderSchedule.sequence, 1);
  assert.equal(state.orderSchedule.nextInMs, 8_000);
});

test("the next order arrives after the random gap (8-35 s) and not a moment sooner", async () => {
  for (const [random, gapSeconds] of [[() => 0, 8], [() => 0.999999, 35]]) {
    const { state } = await runningMock({ random });
    assert.equal(state.orderSchedule.nextInMs, gapSeconds * 1000);
    const before = advanceMockState(state, (gapSeconds - 1) * 1000, 2_000, random);
    assert.equal(before.orders.length, 1, `nothing yet at ${gapSeconds - 1}s`);
    const after = advanceMockState(before, 1_000, 3_000, random);
    assert.equal(after.orders.length, 2, `second order at ${gapSeconds}s`);
    assert.equal(after.orders[1].id, "order-2");
  }
});

test("there is always at least one open order and never more than three, even if nothing is served", async () => {
  const { state: start, random } = await runningMock();
  let state = start;
  let expired = 0;
  let maxOpen = 0;
  for (let second = 1; second < 240; second += 1) {
    state = advanceMockState(state, 1_000, 1_000 + second * 1_000, random);
    const open = active(state).length;
    maxOpen = Math.max(maxOpen, open);
    assert.ok(open >= 1, `an order is open at t+${second}s`);
    assert.ok(open <= 3, `at most three open at t+${second}s`);
    assert.equal(validateFrontendSnapshot(state).valid, true, `valid snapshot at t+${second}s`);
    expired = state.orders.filter((order) => order.status === "expired").length;
  }
  assert.equal(maxOpen, 3, "the queue does fill to the cap when nobody keeps up");
  assert.ok(expired >= 1, "unserved orders eventually expire");
  assert.ok(state.orders.length > 4, "order history is kept beyond four entries");
});

test("serving the last open order brings the next one immediately", async () => {
  const transport = createMockTransport({ now: () => 5_000, random: () => 0.999999 });
  try {
    for (const command of [GAME_ACTIONS.START_HOST, GAME_ACTIONS.SCAN_ROOM, GAME_ACTIONS.APPROVE_LAYOUT, GAME_ACTIONS.START_GAME]) {
      await transport.command(command);
    }
    assert.equal(active(transport.snapshot()).length, 1);
    const served = await transport.command(GAME_ACTIONS.DELIVERY_SUCCESS);
    assert.equal(served.orders[0].status, "completed");
    assert.equal(active(served).length, 1, "a replacement is waiting");
    assert.equal(served.order.id, "order-2");
    assert.equal(validateFrontendSnapshot(served).valid, true);
  } finally {
    transport.close();
  }
});

test("a wrong burger keeps the order open and does not spawn a replacement", async () => {
  const transport = createMockTransport({ now: () => 5_000, random: () => 0.999999 });
  try {
    for (const command of [GAME_ACTIONS.START_HOST, GAME_ACTIONS.SCAN_ROOM, GAME_ACTIONS.APPROVE_LAYOUT, GAME_ACTIONS.START_GAME]) {
      await transport.command(command);
    }
    const failed = await transport.command(GAME_ACTIONS.DELIVERY_FAILURE);
    assert.equal(failed.orders.length, 1);
    assert.equal(failed.orders[0].status, "active");
  } finally {
    transport.close();
  }
});

test("fixture states without a schedule keep their fixed orders (no surprise spawns)", async () => {
  const { state } = await runningMock();
  const { orderSchedule, ...unscheduled } = state;
  const later = advanceMockState(unscheduled, 30_000, 31_000, () => 0);
  assert.equal(later.orders.length, 1);
  assert.equal("orderSchedule" in later, false);
});

test("a new round after a reset starts over with one order", async () => {
  const transport = createMockTransport({ now: () => 9_000, random: () => 0 });
  try {
    for (const command of [GAME_ACTIONS.START_HOST, GAME_ACTIONS.SCAN_ROOM, GAME_ACTIONS.APPROVE_LAYOUT, GAME_ACTIONS.START_GAME]) {
      await transport.command(command);
    }
    await transport.command(GAME_ACTIONS.END_GAME);
    await transport.command(GAME_ACTIONS.RESET_GAME);
    for (const command of [GAME_ACTIONS.START_HOST, GAME_ACTIONS.SCAN_ROOM, GAME_ACTIONS.APPROVE_LAYOUT, GAME_ACTIONS.START_GAME]) {
      await transport.command(command);
    }
    const state = transport.snapshot();
    assert.equal(state.orders.length, 1);
    assert.equal(state.order.id, "order-1");
  } finally {
    transport.close();
  }
});

test("the mock and the real server issue the same recipes with the same patience", async () => {
  let now = 1_000_000;
  const projection = new ServerProjection({
    provider: new LocalFloorplanProvider({ now: () => now }),
    now: () => now,
    orderIntervalMinSeconds: 8,
    orderIntervalMaxSeconds: 8,
    random: () => 0,
    maxActiveOrders: 3,
  });
  await projection.proposeFloorplan({ photos: [{ id: "fixture" }] }, now);
  projection.approveFloorplan(true, now);
  projection.command("START_GAME", {}, now);
  projection.ingestHostControl({ control: "START", durationSeconds: 240, framing: "legacy-game" }, now);
  for (let step = 0; step < 2; step += 1) { now += 8_000; projection.snapshot(now); }
  const server = projection.snapshot(now).orders.slice(0, 3);

  let { state, random } = await runningMock();
  for (let step = 0; step < 2; step += 1) state = advanceMockState(state, 8_000, 1_000 + step * 8_000, random);
  const mock = state.orders.slice(0, 3);

  assert.deepEqual(mock.map((order) => order.recipe), server.map((order) => order.recipe));
  assert.deepEqual(mock.map((order) => order.totalSeconds), server.map((order) => order.totalSeconds));
  assert.deepEqual(server.map((order) => order.totalSeconds), [60, 75, 75]);
  assert.equal(ORDER_RULES.patienceBaseSeconds, 60);
});
