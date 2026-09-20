import { canRunAction, cloneState, GAME_ACTIONS, SETUP_PHASES } from "./state.js";
import { createStandardRoomPlan } from "./room-grid.js";

const STANDARD_ROOM_PLAN = createStandardRoomPlan();
const PROPOSED_PLAN = {
  accepted: false,
  // The standard mode is intentionally independent of setup photography. A
  // future Pi-produced room plan opts into image placement with `true`.
  layoutFromImage: false,
  coordinateSpace: STANDARD_ROOM_PLAN.coordinateSpace,
  width: STANDARD_ROOM_PLAN.width,
  height: STANDARD_ROOM_PLAN.height,
  grid: STANDARD_ROOM_PLAN.grid,
  walls: STANDARD_ROOM_PLAN.walls,
  stations: STANDARD_ROOM_PLAN.stations,
};

const PLACEMENT_INSTRUCTIONS = STANDARD_ROOM_PLAN.placementInstructions;

function health(now) {
  return {
    gateway: { id: "gateway", label: "GATEWAY BADGE", status: "healthy", lastSeenAt: now, detail: "Host badge / USB online" },
    workers: [],
    inference: { id: "inference", label: "SETUP INFERENCE", status: "healthy", lastSeenAt: now, detail: "Room setup complete" },
    trackingCoverage: "event-inferred",
  };
}

function burgerLevel(status = "not-generated") {
  return { status, recipe: "BURGER", placementInstructions: cloneState(PLACEMENT_INSTRUCTIONS) };
}

// Mirrors pi/server/src/projection.mjs BURGER_RECIPES exactly (id, dish name,
// components, gold) — the mock is a stand-in for that authoritative Pi
// projection, so it uses the same four recipes and the same gold values
// rather than inventing its own catalog.
const BURGER_RECIPES = Object.freeze([
  { id: "PLAIN_MEAT", dish: "PLAIN MEAT BURGER", components: ["BUN", "MEAT"], gold: 100 },
  { id: "CHEESEBURGER", dish: "CHEESEBURGER", components: ["BUN", "MEAT", "CHEESE"], gold: 120 },
  { id: "LETTUCE_MEAT", dish: "LETTUCE-MEAT BURGER", components: ["BUN", "MEAT", "LETTUCE"], gold: 120 },
  { id: "CHEESE_LETTUCE_MEAT", dish: "CHEESE-LETTUCE-MEAT BURGER", components: ["BUN", "MEAT", "CHEESE", "LETTUCE"], gold: 150 },
]);
const RECIPE_BY_ID = new Map(BURGER_RECIPES.map((recipe) => [recipe.id, recipe]));

// README.md "Submission behavior": "The authoritative Pi projection applies
// the configured penalty, tip, or bonus-gold result for the submitted
// order." The gold/tip side of that is implemented in pi/server's
// projection.mjs (ported below in orderTip()); no file in this repo defines
// a penalty amount, so this is this mock's own reasonable stand-in for that
// documented-but-unspecified value, not a value read from server code.
const FAILED_SUBMISSION_PENALTY = 25;

function makeMockOrder(id, recipe, remainingSeconds, totalSeconds = 120) {
  return {
    id,
    dish: recipe.dish,
    recipe: recipe.id,
    status: "active",
    toppings: [],
    components: [...recipe.components],
    goldValue: recipe.gold,
    remainingSeconds,
    totalSeconds,
    // Same 3-segment patience meter as pi/server's projection.mjs, computed
    // the same way: ceil((remaining / total) * 3), clamped to [0, 3].
    patience: { segments: 3, filledSegments: orderPatienceSegments(remainingSeconds, totalSeconds) },
  };
}

function orderPatienceSegments(remainingSeconds, totalSeconds) {
  if (!(totalSeconds > 0)) return 0;
  return Math.max(0, Math.min(3, Math.ceil((remainingSeconds / totalSeconds) * 3)));
}

// Identical formula to pi/server/src/projection.mjs's submit(): gold is
// worth 10% of a tip, plus up to 5 more for a plate turned in with a full
// patience meter — so a same-tick (3/3 segments) submission tips the most,
// and it never rounds down to nothing.
function orderTip(recipe, remainingSeconds, totalSeconds) {
  const ratio = totalSeconds > 0 ? remainingSeconds / totalSeconds : 0;
  return Math.max(1, Math.round(recipe.gold * 0.1 + ratio * 5));
}

const MOCK_ORDERS = Object.freeze([
  makeMockOrder("order-1", BURGER_RECIPES[0], 112),
  makeMockOrder("order-2", BURGER_RECIPES[1], 96),
  makeMockOrder("order-3", BURGER_RECIPES[2], 82),
  makeMockOrder("order-4", BURGER_RECIPES[3], 68),
]);

function normalizedOrders(state) {
  const source = Array.isArray(state.orders) && state.orders.length ? state.orders : state.order ? [state.order] : [];
  return source.slice(0, 4);
}

function withPrimaryOrder(orders, fallback) {
  return orders.find((order) => order.status === "active") || orders[0] || fallback;
}

export function createInitialMockState(now = Date.now()) {
  const orders = cloneState(MOCK_ORDERS);
  return {
    version: 2,
    schemaVersion: 2,
    source: "mock-laptop-server",
    setup: { phase: SETUP_PHASES.IDLE, message: "Host is idle. Start to prepare the standard kitchen.", updatedAt: now },
    floorPlan: cloneState(PROPOSED_PLAN),
    burgerLevel: burgerLevel(),
    players: [
      { id: "p1", label: "P1", name: "PLAYER 1", color: "red", position: { x: 20, y: 58 }, location: "center", positionSource: "badge-events", tracking: { status: "inferred", source: "badge-events", lastSeenAt: now, staleAfterMs: null }, heldItem: "PLATE", actionState: "holding plate", inventory: ["BUN", "COOKED MEAT", "SHREDDED LETTUCE"], plate: ["BUN", "COOKED MEAT", "SHREDDED LETTUCE"] },
      { id: "p2", label: "P2", name: "PLAYER 2", color: "blue", position: { x: 68, y: 58 }, location: "center", positionSource: "badge-events", tracking: { status: "inferred", source: "badge-events", lastSeenAt: now, staleAfterMs: null }, heldItem: "RAW_MEAT", actionState: "holding raw meat", inventory: ["RAW MEAT"] },
      { id: "p3", label: "P3", name: "PLAYER 3", color: "green", position: { x: 82, y: 63 }, location: "center", positionSource: "badge-events", tracking: { status: "inferred", source: "badge-events", lastSeenAt: now, staleAfterMs: null }, heldItem: "PLATE", actionState: "holding plate", inventory: ["BUN", "CHOPPED CHEESE"], plate: ["BUN", "CHOPPED CHEESE"] },
    ],
    order: cloneState(orders[0]),
    orders,
    stations: [
      { id: "stove1", label: "STOVE 1", kind: "stove", status: "cooking", progress: 0.86, remainingSeconds: 3, totalSeconds: 22, item: "MEAT PATTY", warning: true, warningMessage: "MEAT IS NEARLY BURNT" },
      { id: "stove2", label: "STOVE 2", kind: "stove", status: "ready", progress: 0, remainingSeconds: 0, item: "EMPTY" },
      { id: "assembly", label: "ASSEMBLY", kind: "assembly", status: "ready", progress: 1, remainingSeconds: 0, item: "PLATE" },
      { id: "chop1", label: "CHOP 1", kind: "chop", status: "ready", progress: 1, remainingSeconds: 0, item: "LETTUCE" },
      { id: "chop2", label: "CHOP 2", kind: "chop", status: "chopping", progress: 0.4, remainingSeconds: 9, totalSeconds: 15, item: "CHEESE" },
    ],
    gold: { total: 0, earned: 0, lastChange: 0 },
    tips: { total: 0, earned: 0, lastChange: 0 },
    score: { value: 0, delivered: 0 },
    gold: { total: 0, earned: 0, lastChange: 0 },
    tips: { total: 0, earned: 0, lastChange: 0 },
    clock: { status: "ready", remainingSeconds: 240, totalSeconds: 240 },
    submissions: [],
    serving: { lastEvent: null, gooseQueue: 4, location: "SERVING" },
    health: health(now),
  };
}

function withUpdate(state, changes, now) {
  return { ...state, ...changes, setup: { ...state.setup, ...changes.setup, updatedAt: now } };
}

function startHost(state, now) {
  if (!canRunAction(state, GAME_ACTIONS.START_HOST)) return state;
  const message = state.floorPlan?.layoutFromImage
    ? "Host started. Setup photos are being used to propose a floor plan."
    : "Host started. The standard kitchen is ready to review.";
  return withUpdate(state, { setup: { phase: SETUP_PHASES.SCANNING, message } }, now);
}

function scanRoom(state, now) {
  if (!canRunAction(state, GAME_ACTIONS.SCAN_ROOM)) return state;
  const message = state.floorPlan?.layoutFromImage
    ? "Proposed image-based floor plan ready. Approve it to generate burger-level placement instructions."
    : "Standard kitchen ready. Approve it to generate burger-level placement instructions.";
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.LAYOUT_PROPOSED, message },
    floorPlan: { ...state.floorPlan, accepted: false },
  }, now);
}

function rescanRoom(state, now) {
  if (!canRunAction(state, GAME_ACTIONS.RESCAN)) return state;
  const message = state.floorPlan?.layoutFromImage
    ? "Rescan requested. Setup photos are being used to update the floor plan."
    : "Standard kitchen restored. Review the fixed station positions.";
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.SCANNING, message },
    floorPlan: { ...state.floorPlan, accepted: false },
    burgerLevel: { ...state.burgerLevel, status: "not-generated" },
  }, now);
}

function approveLayout(state, now) {
  if (!canRunAction(state, GAME_ACTIONS.APPROVE_LAYOUT)) return state;
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.BURGER_PLACEMENT, message: "Burger level generated. Place the ingredients, chopping boards, stoves, and serving badge as shown." },
    floorPlan: { ...state.floorPlan, accepted: true },
    burgerLevel: { ...state.burgerLevel, status: "placement-ready" },
  }, now);
}

function startGame(state, now) {
  if (!canRunAction(state, GAME_ACTIONS.START_GAME)) return state;
  const orders = normalizedOrders(state).map((order) => ({ ...order, status: "active", remainingSeconds: order.totalSeconds }));
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.RUNNING, message: "Burger game running. Badge events drive player state and inferred positions." },
    gold: { total: 0, earned: 0, lastChange: 0 },
    tips: { total: 0, earned: 0, lastChange: 0 },
    score: { value: 0, delivered: 0 },
    gold: { total: 0, earned: 0, lastChange: 0 },
    tips: { total: 0, earned: 0, lastChange: 0 },
    clock: { ...state.clock, status: "running", remainingSeconds: state.clock.totalSeconds },
    order: { ...withPrimaryOrder(orders, state.order) },
    orders,
    serving: { ...state.serving, lastEvent: null },
    submissions: [],
    players: state.players.map((player, index) => ({
      ...player,
      position: { x: [34, 50, 66][index] ?? 50, y: 88 },
      location: "bottom",
      heldItem: "EMPTY",
      actionState: "idle",
      inventory: [],
    })),
    burgerLevel: { ...state.burgerLevel, status: "in-play" },
  }, now);
}

function endGame(state, now) {
  if (!canRunAction(state, GAME_ACTIONS.END_GAME)) return state;
  const orders = normalizedOrders(state).map((order) => order.status === "active"
    ? { ...order, status: "expired", remainingSeconds: 0 }
    : { ...order });
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.ENDED, message: "Game ended. Reset to host another burger level." },
    clock: { ...state.clock, status: "ended", remainingSeconds: 0 },
    orders,
    order: { ...withPrimaryOrder(orders, state.order) },
    players: state.players.map((player, index) => ({ ...player, position: { x: [34, 50, 66][index] ?? 50, y: 88 }, location: "bottom", heldItem: "EMPTY", actionState: "idle", inventory: [] })),
  }, now);
}

function hasActiveRound(state) {
  return state.setup?.phase === SETUP_PHASES.RUNNING
    && state.clock?.status === "running"
    && normalizedOrders(state).some((order) => order.status === "active");
}

// README.md "Submission behavior": a correct submission "reports its
// score"; a failed one "applies a penalty and has no retry." pi/server's
// submit() implements the success side (gold from the matched recipe, a tip
// from remaining patience) — ported via orderTip()/RECIPE_BY_ID above so
// this mock computes the same numbers the authoritative Pi would. The
// penalty side has no numeric spec anywhere in the codebase (see
// FAILED_SUBMISSION_PENALTY above), so it's this mock's own stand-in.
function recordDelivery(state, success, now, orderId) {
  if (!hasActiveRound(state)) return state;
  const orders = normalizedOrders(state);
  const targetIndex = orderId
    ? orders.findIndex((order) => order.id === orderId && order.status === "active")
    : orders.findIndex((order) => order.status === "active");
  if (targetIndex < 0) return state;
  const target = orders[targetIndex];
  const recipe = RECIPE_BY_ID.get(target.recipe) || BURGER_RECIPES[0];
  const segments = target.patience?.filledSegments ?? orderPatienceSegments(target.remainingSeconds, target.totalSeconds);

  const gold = success ? recipe.gold : 0;
  const tip = success ? orderTip(recipe, target.remainingSeconds, target.totalSeconds) : 0;
  const penalty = success ? 0 : FAILED_SUBMISSION_PENALTY;
  const event = success
    ? {
      id: `submission-${(state.submissions || []).length + 1}`,
      playerId: "p1",
      status: "success",
      message: "BURGER SERVED",
      detail: segments >= 3 ? "Served with a full patience meter — max tip." : segments > 0 ? `Served with ${segments}/3 patience remaining.` : "Served just before the order ran out.",
      points: gold,
      gold,
      tip,
      patienceSegments: segments,
      at: now,
    }
    : {
      id: `submission-${(state.submissions || []).length + 1}`,
      playerId: "p1",
      status: "failure",
      message: "WRONG BURGER",
      detail: `Serving badge rejected the topping combination — penalty applied.`,
      points: -penalty,
      gold: 0,
      tip: 0,
      penalty,
      at: now,
    };
  const nextOrders = success
    ? orders.map((order, index) => index === targetIndex ? { ...order, status: "completed" } : { ...order })
    : orders.map((order) => ({ ...order }));
  return withUpdate(state, {
    score: {
      ...state.score,
      value: Number(state.score?.value || 0) + (success ? gold : -penalty),
      delivered: Number(state.score?.delivered || 0) + (success ? 1 : 0),
    },
    gold: success
      ? { ...state.gold, total: Number(state.gold?.total || 0) + gold, earned: Number(state.gold?.earned || 0) + gold, lastChange: gold }
      : { ...state.gold, lastChange: 0 },
    tips: success
      ? { ...state.tips, total: Number(state.tips?.total || 0) + tip, earned: Number(state.tips?.earned || 0) + tip, lastChange: tip }
      : { ...state.tips, lastChange: 0 },
    order: { ...withPrimaryOrder(nextOrders, state.order) },
    orders: nextOrders,
    serving: { ...state.serving, lastEvent: event },
    submissions: [...(state.submissions || []), event],
  }, now);
}

export function reduceMockState(state, command, now = Date.now()) {
  const action = typeof command === "string" ? command : command?.type;
  const orderId = typeof command === "object" ? command?.orderId || command?.payload?.orderId : undefined;
  switch (action) {
    case GAME_ACTIONS.START_HOST: return startHost(state, now);
    case GAME_ACTIONS.SCAN_ROOM: return scanRoom(state, now);
    case GAME_ACTIONS.RESCAN: return rescanRoom(state, now);
    case GAME_ACTIONS.APPROVE_LAYOUT: return approveLayout(state, now);
    case GAME_ACTIONS.START_GAME: return startGame(state, now);
    case GAME_ACTIONS.END_GAME: return endGame(state, now);
    case GAME_ACTIONS.RESET_GAME: return createInitialMockState(now);
    case GAME_ACTIONS.DELIVERY_SUCCESS: return recordDelivery(state, true, now, orderId);
    case GAME_ACTIONS.DELIVERY_FAILURE: return recordDelivery(state, false, now, orderId);
    default: return state;
  }
}

export function createMockTransport({ initialState, now = () => Date.now() } = {}) {
  let state = cloneState(initialState || createInitialMockState(now()));
  const listeners = new Set();
  const emit = () => { const snapshot = cloneState(state); listeners.forEach((listener) => listener(snapshot)); };
  // Real badges keep re-scanning, so tracking.lastSeenAt keeps advancing. The
  // mock never dispatches anything per-player, so without a heartbeat every
  // player's lastSeenAt freezes at game start and trips staleAfterMs (20s),
  // fading all players (.is-stale) for the rest of the round.
  const heartbeat = setInterval(() => {
    if (!listeners.size || !Array.isArray(state.players)) return;
    const seenAt = now();
    state = { ...state, players: state.players.map((player) => player.tracking?.status === "healthy" ? { ...player, tracking: { ...player.tracking, lastSeenAt: seenAt } } : player) };
    emit();
  }, 5_000);
  // Don't keep a Node process (tests) alive just for the heartbeat.
  if (typeof heartbeat === "object" && typeof heartbeat.unref === "function") heartbeat.unref();
  return {
    kind: "mock",
    connect(listener) { listeners.add(listener); listener(cloneState(state)); return () => listeners.delete(listener); },
    snapshot() { return cloneState(state); },
    async command(command) { state = reduceMockState(state, command, now()); emit(); return cloneState(state); },
    close() { clearInterval(heartbeat); listeners.clear(); },
  };
}
