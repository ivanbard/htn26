import test from "node:test";
import assert from "node:assert/strict";
import {
  DifficultySidecarClient,
  normalizeDifficultyFeatures,
  validateDifficultyResponse,
} from "../src/difficulty-sidecar.mjs";
import { ServerProjection } from "../src/projection.mjs";

const validResponse = {
  schemaVersion: 1,
  difficulty: "hectic",
  source: "local-opencv-rtrees",
  model: { name: "htn26-difficulty-rtrees", version: "pr22-bootstrap-1", artifact: "difficulty.xml" },
  latencyMs: 4.2,
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

function startedProjection(options = {}) {
  let now = 1_000;
  const projection = new ServerProjection({
    now: () => now,
    orderIntervalSeconds: 4,
    orderPatienceSeconds: 30,
    random: () => 0,
    ...options,
  });
  projection.ingestHostControl({ control: "START", durationSeconds: 120 }, now);
  return { projection, advance(milliseconds) { now += milliseconds; return projection.snapshot(now); } };
}

test("v1 client sends only normalized features and accepts only bounded label metadata", async () => {
  let sent;
  const client = new DifficultySidecarClient({
    baseUrl: "http://qnx.test:8790",
    fetchImpl: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify(validResponse), { status: 200 });
    },
  });
  const result = await client.recommend({
    activeOrderPressure: 2,
    recentFailureRate: -1,
    busyStovePressure: 0.5,
    roundElapsed: 0.25,
  });
  assert.equal(sent.url, "http://qnx.test:8790/v1/recommendation");
  assert.deepEqual(sent.body, {
    schemaVersion: 1,
    features: {
      activeOrderPressure: 1,
      recentFailureRate: 0,
      busyStovePressure: 0.5,
      roundElapsed: 0.25,
    },
  });
  assert.equal(result.difficulty, "hectic");
  assert.deepEqual(Object.keys(result).sort(), ["difficulty", "latencyMs", "model", "source"]);
});

test("client rejects invalid labels, extra authority fields, oversized output, and network failure", async () => {
  assert.throws(() => validateDifficultyResponse({ ...validResponse, difficulty: "impossible" }), /invalid difficulty label/);
  assert.throws(() => validateDifficultyResponse({ ...validResponse, recipe: "PLAIN_MEAT" }), /response fields/);
  assert.throws(() => normalizeDifficultyFeatures({ activeOrderPressure: 0 }), /exactly/);

  for (const fetchImpl of [
    async () => new Response(JSON.stringify({ ...validResponse, score: 999 }), { status: 200 }),
    async () => new Response("x".repeat(4097), { status: 200 }),
    async () => { throw new Error("network down"); },
  ]) {
    const client = new DifficultySidecarClient({ baseUrl: "http://qnx.test:8790", fetchImpl });
    await assert.rejects(client.recommend({
      activeOrderPressure: 0,
      recentFailureRate: 0,
      busyStovePressure: 0,
      roundElapsed: 0,
    }));
  }
});

test("client timeout aborts without synchronously blocking the laptop", async () => {
  const client = new DifficultySidecarClient({
    baseUrl: "http://qnx.test:8790",
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  await assert.rejects(client.recommend({
    activeOrderPressure: 0,
    recentFailureRate: 0,
    busyStovePressure: 0,
    roundElapsed: 0,
  }), /aborted/);
});

test("projection requests asynchronously and makes the recipe decision from a valid label", async () => {
  let requestedFeatures;
  const sidecar = {
    recommend(features) {
      requestedFeatures = features;
      return Promise.resolve({
        difficulty: "hectic",
        source: "local-opencv-rtrees",
        model: validResponse.model,
        latencyMs: 3,
      });
    },
  };
  const { projection, advance } = startedProjection({ difficultySidecar: sidecar });
  assert.equal(projection.snapshot(1_000).orders[0].recipe, "PLAIN_MEAT", "first order keeps the existing laptop policy");
  assert.equal(requestedFeatures, undefined, "recommendation is not called in the synchronous game transition");
  await settle();
  assert.deepEqual(Object.keys(requestedFeatures).sort(), [
    "activeOrderPressure", "busyStovePressure", "recentFailureRate", "roundElapsed",
  ]);
  const state = advance(4_000);
  assert.equal(state.orders[1].recipe, "CHEESE_LETTUCE_MEAT", "the laptop maps hectic to its own valid recipe");
  assert.equal(state.eventHistory.at(-1).difficulty, "hectic");
});

test("projection discards a recommendation stale from skipped spawn intervals", async () => {
  const sidecar = {
    recommend() {
      return Promise.resolve({
        difficulty: "hectic",
        source: "local-opencv-rtrees",
        model: validResponse.model,
        latencyMs: 3,
      });
    },
  };
  const { advance } = startedProjection({
    difficultySidecar: sidecar,
    maxActiveOrders: 1,
    orderPatienceSeconds: 10,
  });
  await settle();

  advance(4_000);
  const state = advance(8_000);
  assert.deepEqual(state.orders.map((order) => order.recipe), ["PLAIN_MEAT", "CHEESEBURGER"]);
  const latestOrderEvent = state.eventHistory.filter((event) => event.type === "order-created").at(-1);
  assert.equal(latestOrderEvent.difficulty, undefined);
});

test("missing, failed, pending, or invalid sidecars preserve the existing order sequence", async () => {
  const baseline = startedProjection();
  assert.deepEqual(baseline.advance(4_000).orders.map((order) => order.recipe), ["PLAIN_MEAT", "CHEESEBURGER"]);

  for (const recommend of [
    () => Promise.reject(new Error("offline")),
    () => new Promise(() => {}),
    () => Promise.resolve({ difficulty: "extreme" }),
  ]) {
    const current = startedProjection({ difficultySidecar: { recommend } });
    await settle();
    const state = current.advance(4_000);
    assert.deepEqual(state.orders.map((order) => order.recipe), ["PLAIN_MEAT", "CHEESEBURGER"]);
  }
});
