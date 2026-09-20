// (1) Every tour step must have something on screen to point at, on the plans the
//     server really sends as well as the mock's: a step with no target used to
//     leave its card hidden and strand the tour on "5 of 6".
// (2) Server-plan station tiles must be square on the wide game board.
import assert from "node:assert/strict";
import test from "node:test";
import { ServerProjection } from "../../server/src/projection.mjs";
import { LocalFloorplanProvider } from "../../server/src/provider.mjs";
import { tourStepsForOrder } from "../src/App.js";
import { normalizeFrontendSnapshot } from "../src/contracts.js";
import { createInitialMockState } from "../src/mock-transport.js";
import { normalizeServerSnapshot } from "../src/server-snapshot.js";

// The floor plan (board minus frame) is ~2.1:1; a tile is a CSS square sized by its width.
const PLAN_ASPECT = 2.12;

async function serverPlan() {
  const now = 1_000;
  const projection = new ServerProjection({ provider: new LocalFloorplanProvider({ now: () => now }), now: () => now });
  await projection.proposeFloorplan({ photos: [{ id: "fixture" }] }, now);
  projection.approveFloorplan(true, now);
  return normalizeFrontendSnapshot(normalizeServerSnapshot(projection.snapshot(now))).floorPlan;
}

// A station step is "targetable" when at least one plan station matches its focus,
// using the same id / kind / assetKey rule RoomSurface uses to highlight tiles.
const matches = (plan, focus) => plan.stations.filter((station) => focus.some((target) => target === station.id || target === station.kind || target === station.assetKey?.toLowerCase()));

for (const [name, planOf] of [["the server's default room", serverPlan], ["the mock's standard room", async () => createInitialMockState(1_000).floorPlan]]) {
  test(`every tour step has a target on ${name}`, async () => {
    const plan = await planOf();
    const steps = tourStepsForOrder({ components: ["BUN", "MEAT", "CHEESE", "LETTUCE"] }, plan);
    assert.equal(steps.length, 6);
    for (const step of steps) {
      if (step.target === "station") assert.ok(matches(plan, step.focus).length > 0, `"${step.title}" points at ${JSON.stringify(step.focus)}, which is not on this plan`);
      else assert.ok(["order", "players"].includes(step.target), step.key);
    }
  });
}

test("with no assembly counter, the build step points at the pantry (that's where plates come from)", async () => {
  const plan = await serverPlan();
  assert.ok(!plan.stations.some((station) => station.kind === "assembly"));
  const build = tourStepsForOrder({ components: ["BUN", "MEAT"] }, plan).find((step) => step.key === "assembly");
  assert.deepEqual(build.focus, ["pantry"]);
  assert.match(build.detail, /pantry/i);
  assert.match(build.control, /Down/);
});

test("with an assembly counter (the mock), the build step still points at it", () => {
  const plan = createInitialMockState(1_000).floorPlan;
  const build = tourStepsForOrder({ components: ["BUN", "MEAT"] }, plan).find((step) => step.key === "assembly");
  assert.deepEqual(build.focus, ["assembly"]);
  assert.doesNotMatch(build.detail, /pantry/i);
});

test("a plan with nothing matching still yields all six steps (the card then centres instead of hiding)", () => {
  const steps = tourStepsForOrder({ components: ["BUN", "MEAT"] }, { stations: [] });
  assert.equal(steps.length, 6);
  assert.ok(steps.every((step) => step.title && step.detail));
});

test("server-plan station tiles are square on the floor plan, and the two stoves sit side by side", async () => {
  const plan = await serverPlan();
  for (const station of plan.stations) {
    const { width, height } = station.display;
    assert.ok(Math.abs((width * PLAN_ASPECT) - height) < 0.01, `${station.id} tile is ${width}% x ${height}% of the board, not square`);
  }
  const [left, right] = ["stove-left", "stove-right"].map((id) => plan.stations.find((station) => station.id === id).display);
  assert.ok(Math.abs(left.x + left.width - right.x) < 0.001 && left.y === right.y, "the stoves touch, left then right");
  assert.ok(plan.stations.every((station) => station.display.y + station.display.height <= 100.001), "no tile spills off the bottom");
});
