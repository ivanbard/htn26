import { canRunAction, cloneState, GAME_ACTIONS, SETUP_PHASES, stationProgressPercent } from "./state.js";
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
    workers: [
      { id: "camera-1", label: "CAMERA 1", status: "healthy", lastSeenAt: now, detail: "Master Pi camera" },
      { id: "camera-2", label: "CAMERA 2", status: "healthy", lastSeenAt: now, detail: "Worker Pi 2" },
      { id: "camera-3", label: "CAMERA 3", status: "healthy", lastSeenAt: now, detail: "Worker Pi 3" },
    ],
    inference: { id: "inference", label: "AI INFERENCE", status: "healthy", lastSeenAt: now, detail: "On-device tracking" },
    trackingCoverage: "healthy",
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
// server/src/projection.mjs EXPIRED_ORDER_PENALTY: an order that runs out of
// patience costs the team coins.
const EXPIRED_ORDER_PENALTY = 20;

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

// Order pacing mirrors server/src/projection.mjs: ONE order when the round
// starts, then another after a random gap, at most MAX_ACTIVE_ORDERS open at
// once, and never zero open orders while the round runs. Patience is the
// customer's wait (by recipe), not the spawn gap.
const MAX_ACTIVE_ORDERS = 3;
const ORDER_INTERVAL_SECONDS = Object.freeze({ min: 8, max: 35 });
const ORDER_PATIENCE_BASE_SECONDS = 60;
const ORDER_PATIENCE_PER_TOPPING_SECONDS = 15;
const ORDER_HISTORY_LIMIT = 32;

function recipePatienceSeconds(recipe) {
  return ORDER_PATIENCE_BASE_SECONDS + ORDER_PATIENCE_PER_TOPPING_SECONDS * Math.max(0, recipe.components.length - 2);
}

function randomIntervalMs(random) {
  const span = ORDER_INTERVAL_SECONDS.max - ORDER_INTERVAL_SECONDS.min;
  const value = Math.max(0, Math.min(0.999999, Number(random()) || 0));
  return (ORDER_INTERVAL_SECONDS.min + Math.floor(value * (span + 1))) * 1000;
}

const isActiveOrder = (order) => order?.status === "active";

// `schedule.sequence` counts orders issued so far, so recipes cycle in the same
// order as the server's (`BURGER_RECIPES[sequence % 4]`).
function issueOrder(orders, schedule, random) {
  const recipe = BURGER_RECIPES[schedule.sequence % BURGER_RECIPES.length];
  const patience = recipePatienceSeconds(recipe);
  return {
    orders: [...orders, makeMockOrder(`order-${schedule.sequence + 1}`, recipe, patience, patience)].slice(-ORDER_HISTORY_LIMIT),
    schedule: { sequence: schedule.sequence + 1, nextInMs: randomIntervalMs(random) },
  };
}

const MOCK_ORDERS = Object.freeze([
  makeMockOrder("order-1", BURGER_RECIPES[0], 112),
  makeMockOrder("order-2", BURGER_RECIPES[1], 96),
  makeMockOrder("order-3", BURGER_RECIPES[2], 82),
  makeMockOrder("order-4", BURGER_RECIPES[3], 68),
]);

function normalizedOrders(state) {
  const source = Array.isArray(state.orders) && state.orders.length ? state.orders : state.order ? [state.order] : [];
  return source;
}

function withPrimaryOrder(orders, fallback) {
  return orders.find((order) => order.status === "active") || orders[0] || fallback;
}

export function createInitialMockState(now = Date.now()) {
  const orders = cloneState(MOCK_ORDERS);
  return {
    version: 2,
    source: "mock-master-pi",
  setup: { phase: SETUP_PHASES.IDLE, message: "Host is idle. Start to prepare the standard kitchen.", updatedAt: now },
    floorPlan: cloneState(PROPOSED_PLAN),
    burgerLevel: burgerLevel(),
    players: [
      { id: "p1", label: "P1", name: "PLAYER 1", color: "red", position: { x: 20, y: 58 }, tracking: { status: "healthy", source: "nfc-scan", lastSeenAt: now, staleAfterMs: 20_000 }, inventory: [], plate: ["BUN", "COOKED MEAT", "SHREDDED LETTUCE"] },
      { id: "p2", label: "P2", name: "PLAYER 2", color: "blue", position: { x: 68, y: 58 }, tracking: { status: "healthy", source: "nfc-scan", lastSeenAt: now, staleAfterMs: 20_000 }, inventory: ["RAW MEAT"] },
      { id: "p3", label: "P3", name: "PLAYER 3", color: "green", position: { x: 82, y: 63 }, tracking: { status: "healthy", source: "nfc-scan", lastSeenAt: now, staleAfterMs: 20_000 }, inventory: [], plate: ["BUN", "CHOPPED CHEESE"] },
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
    score: { value: 0, delivered: 0 },
    gold: { total: 0, earned: 0, lastChange: 0 },
    tips: { total: 0, earned: 0, lastChange: 0 },
    clock: { status: "ready", remainingSeconds: 240, totalSeconds: 240 },
    serving: { lastEvent: null, gooseQueue: 4, location: "SERVING" },
    health: health(now),
  };
}

function withUpdate(state, changes, now) {
  return { ...state, ...changes, setup: { ...state.setup, ...changes.setup, updatedAt: now } };
}

// Timings mirrored from pi/server/src/projection.mjs (CHOP_SECONDS,
// COOK_SECONDS, DONE_SECONDS, WARNING_SECONDS, and its stove state machine in
// _updateStoves): cooking -> done -> warning -> burnt.
const CHOP_SECONDS = 3;
const COOK_SECONDS = 15;
const DONE_SECONDS = 2;
const WARNING_SECONDS = 3;
const EXPIRED_MESSAGE = "Time’s up. Reset to host another burger level.";

// advanceMockState keeps sub-second precision in hidden `remainingMs` /
// `elapsedMs` fields beside the whole-second values it publishes (the Pi sends
// whole seconds rounded up). They are only trusted while they still agree with
// the published seconds; anything that rewrote the seconds (a restart, a test
// fixture) falls back to the seconds, so a stale carry can never leak across.
function withoutCarry(item) {
  if (!item || typeof item !== "object") return item;
  const { remainingMs, elapsedMs, ...rest } = item;
  return rest;
}

function carriedRemainingMs(item, fallbackMs) {
  const carried = Number(item?.remainingMs);
  const seconds = Number(item?.remainingSeconds);
  return Number.isFinite(carried) && Number.isFinite(seconds) && Math.ceil(carried / 1000) === Math.ceil(seconds)
    ? carried
    : fallbackMs;
}

// A new round starts the workstation timers from zero, the way a fresh Pi
// round starts a fresh cook: the fixture's mid-cook stove/board restart their
// clocks so their bars visibly fill during the round.
function restartStationTimer(station) {
  if (station?.kind === "stove" && station.status === "cooking") {
    const { warningMessage, ...rest } = withoutCarry(station);
    return { ...rest, progress: 0, totalSeconds: COOK_SECONDS, remainingSeconds: COOK_SECONDS, warning: false };
  }
  if (station?.kind === "chop" && station.status === "chopping") {
    const totalSeconds = Number(station.totalSeconds) > 0 ? Number(station.totalSeconds) : CHOP_SECONDS;
    return { ...withoutCarry(station), progress: 0, totalSeconds, remainingSeconds: totalSeconds };
  }
  return station;
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
    ? "Personalized kitchen mapped. Follow the floor walkthrough to place the stations."
    : "Normal kitchen loaded. Follow the floor walkthrough to place the stations.";
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.BURGER_PLACEMENT, message },
    floorPlan: { ...state.floorPlan, accepted: true },
    burgerLevel: { ...state.burgerLevel, status: "placement-ready" },
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
    setup: { phase: SETUP_PHASES.BURGER_PLACEMENT, message: "Burger level generated. Place the ingredients, chopping boards, stoves, and assembly counter as shown." },
    floorPlan: { ...state.floorPlan, accepted: true },
    burgerLevel: { ...state.burgerLevel, status: "placement-ready" },
  }, now);
}

function startGame(state, now, random = Math.random) {
  if (!canRunAction(state, GAME_ACTIONS.START_GAME)) return state;
  const { orders, schedule } = issueOrder([], { sequence: 0 }, random);
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.RUNNING, message: "Burger game running. Live locations and orders come from the master Pi." },
    score: { value: 0, delivered: 0 },
    gold: { total: 0, earned: 0, lastChange: 0 },
    tips: { total: 0, earned: 0, lastChange: 0 },
    clock: { ...withoutCarry(state.clock), status: "running", remainingSeconds: state.clock.totalSeconds },
    order: { ...withPrimaryOrder(orders, state.order) },
    orders,
    orderSchedule: schedule,
    stations: Array.isArray(state.stations) ? state.stations.map(restartStationTimer) : state.stations,
    serving: { ...state.serving, lastEvent: null },
    burgerLevel: { ...state.burgerLevel, status: "in-play" },
  }, now);
}

function endGame(state, now) {
  if (!canRunAction(state, GAME_ACTIONS.END_GAME)) return state;
  return withUpdate(state, { setup: { phase: SETUP_PHASES.ENDED, message: "Game ended. Reset to host another burger level." }, clock: { ...state.clock, status: "ended" } }, now);
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
function recordDelivery(state, success, now, orderId, random = Math.random) {
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
      status: "failure",
      message: "WRONG BURGER",
      detail: "The plate did not match an active order — penalty applied.",
      points: -penalty,
      gold: 0,
      tip: 0,
      penalty,
      at: now,
    };
  let nextOrders = success
    ? orders.map((order, index) => index === targetIndex ? { ...order, status: "completed" } : { ...order })
    : orders.map((order) => ({ ...order }));
  let schedule = state.orderSchedule;
  // Never leave the kitchen without an order: serving the last open one brings
  // the next straight away (the server does the same).
  if (success && schedule && !nextOrders.some(isActiveOrder)) ({ orders: nextOrders, schedule } = issueOrder(nextOrders, schedule, random));
  return withUpdate(state, {
    score: {
      ...state.score,
      value: Number(state.score?.value || 0) + (success ? gold + tip : -penalty),
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
    ...(schedule ? { orderSchedule: schedule } : {}),
    ...(success
      ? (state.penalties ? { penalties: { ...state.penalties, lastChange: 0 } } : {})
      : { penalties: { total: Number(state.penalties?.total || 0) + penalty, lastChange: -penalty } }),
    serving: { ...state.serving, lastEvent: event },
  }, now);
}

export function reduceMockState(state, command, now = Date.now(), random = Math.random) {
  const action = typeof command === "string" ? command : command?.type;
  const orderId = typeof command === "object" ? command?.orderId || command?.payload?.orderId : undefined;
  switch (action) {
    case GAME_ACTIONS.START_HOST: return startHost(state, now);
    case GAME_ACTIONS.SCAN_ROOM: return scanRoom(state, now);
    case GAME_ACTIONS.RESCAN: return rescanRoom(state, now);
    case GAME_ACTIONS.APPROVE_LAYOUT: return approveLayout(state, now);
    case GAME_ACTIONS.START_GAME: return startGame(state, now, random);
    case GAME_ACTIONS.END_GAME: return endGame(state, now);
    case GAME_ACTIONS.RESET_GAME: return createInitialMockState(now);
    case GAME_ACTIONS.DELIVERY_SUCCESS: return recordDelivery(state, true, now, orderId, random);
    case GAME_ACTIONS.DELIVERY_FAILURE: return recordDelivery(state, false, now, orderId, random);
    default: return state;
  }
}

function stovePhase(elapsedMs, cookSeconds) {
  const elapsed = Math.max(0, elapsedMs) / 1000;
  if (elapsed < cookSeconds) {
    return { status: "cooking", progress: Math.min(1, elapsed / cookSeconds), remainingSeconds: Math.ceil(cookSeconds - elapsed) };
  }
  if (elapsed < cookSeconds + DONE_SECONDS) {
    return { status: "done", progress: 1, remainingSeconds: Math.ceil(cookSeconds + DONE_SECONDS - elapsed) };
  }
  if (elapsed < cookSeconds + DONE_SECONDS + WARNING_SECONDS) {
    return { status: "warning", progress: 1, remainingSeconds: Math.ceil(cookSeconds + DONE_SECONDS + WARNING_SECONDS - elapsed) };
  }
  return { status: "burnt", progress: 1, remainingSeconds: 0 };
}

// Time already spent cooking, from the carried sub-second value when it still
// matches the published state, else from the published status/remaining.
function stoveElapsedMs(station, cookSeconds) {
  const carried = Number(station.elapsedMs);
  if (Number.isFinite(carried) && carried >= 0) {
    const phase = stovePhase(carried, cookSeconds);
    if (phase.status === station.status && phase.remainingSeconds === Number(station.remainingSeconds)) return carried;
  }
  const remaining = Number(station.remainingSeconds);
  const known = station.remainingSeconds != null && Number.isFinite(remaining);
  if (station.status === "cooking") {
    return (known ? Math.max(0, cookSeconds - remaining) : cookSeconds * (stationProgressPercent(station) / 100)) * 1000;
  }
  const phaseLength = station.status === "done" ? DONE_SECONDS : WARNING_SECONDS;
  const phaseEnd = cookSeconds + (station.status === "done" ? DONE_SECONDS : DONE_SECONDS + WARNING_SECONDS);
  return (phaseEnd - (known ? Math.max(0, Math.min(remaining, phaseLength)) : phaseLength)) * 1000;
}

function advanceStove(station, elapsedMs) {
  const cookSeconds = Number(station.totalSeconds) > 0 ? Number(station.totalSeconds) : COOK_SECONDS;
  const elapsed = stoveElapsedMs(station, cookSeconds) + elapsedMs;
  const phase = stovePhase(elapsed, cookSeconds);
  const { warningMessage, ...rest } = station;
  return {
    ...rest,
    status: phase.status,
    progress: phase.progress,
    remainingSeconds: phase.remainingSeconds,
    elapsedMs: elapsed,
    item: phase.status === "cooking" ? station.item : phase.status === "burnt" ? "BURNT MEAT" : "COOKED MEAT",
    warning: phase.status === "warning",
    ...(phase.status === "warning" ? { warningMessage: "MEAT IS NEARLY BURNT" } : {}),
  };
}

function advanceChop(station, elapsedMs) {
  const totalSeconds = Number(station.totalSeconds) > 0 ? Number(station.totalSeconds) : CHOP_SECONDS;
  const remaining = Number(station.remainingSeconds);
  const fallbackMs = station.remainingSeconds != null && Number.isFinite(remaining)
    ? remaining * 1000
    : totalSeconds * 1000 * (1 - stationProgressPercent(station) / 100);
  const remainingMs = carriedRemainingMs(station, fallbackMs) - elapsedMs;
  if (remainingMs <= 0) {
    return { ...withoutCarry(station), status: "ready", progress: 1, remainingSeconds: 0 };
  }
  return {
    ...station,
    status: "chopping",
    progress: Math.max(0, Math.min(1, 1 - remainingMs / (totalSeconds * 1000))),
    remainingSeconds: Math.ceil(remainingMs / 1000),
    remainingMs,
  };
}

function advanceStation(station, elapsedMs) {
  if (station?.kind === "chop" && station.status === "chopping") return advanceChop(station, elapsedMs);
  if (station?.kind === "stove" && ["cooking", "done", "warning"].includes(station.status)) return advanceStove(station, elapsedMs);
  return station;
}

function advanceOrder(order, elapsedMs, now) {
  if (order?.status !== "active") return order;
  const totalSeconds = Number(order.totalSeconds);
  const remainingMs = carriedRemainingMs(order, Number(order.remainingSeconds || 0) * 1000) - elapsedMs;
  if (remainingMs <= 0) {
    return {
      ...withoutCarry(order),
      status: "expired",
      expiredAt: now,
      penalty: EXPIRED_ORDER_PENALTY,
      remainingSeconds: 0,
      patienceState: 0,
      patience: { ...order.patience, remainingSeconds: 0, filledSegments: 0, state: 0 },
    };
  }
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const filledSegments = orderPatienceSegments(remainingSeconds, totalSeconds);
  return {
    ...order,
    remainingSeconds,
    remainingMs,
    patienceState: filledSegments,
    patience: { ...order.patience, segments: order.patience?.segments ?? 3, remainingSeconds, totalSeconds, filledSegments, state: filledSegments },
  };
}

// The Pi clears the workstations and cancels open orders when the round timer
// reaches zero (projection.mjs _tick).
function endRound(state, now) {
  const cancel = (order) => order?.status === "active"
    ? {
      ...withoutCarry(order),
      status: "cancelled",
      remainingSeconds: 0,
      patienceState: 0,
      patience: { ...order.patience, remainingSeconds: 0, filledSegments: 0, state: 0 },
    }
    : order;
  const hasOrders = Array.isArray(state.orders) && state.orders.length > 0;
  const orders = hasOrders ? state.orders.map(cancel) : state.orders;
  const cleared = (station) => {
    if (station?.kind !== "stove" && station?.kind !== "chop") return station;
    const { warningMessage, ...rest } = withoutCarry(station);
    return { ...rest, status: "idle", progress: 0, remainingSeconds: 0, item: null, warning: false };
  };
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.ENDED, message: EXPIRED_MESSAGE },
    clock: { ...withoutCarry(state.clock), status: "ended", remainingSeconds: 0 },
    ...(hasOrders ? { orders, order: { ...withPrimaryOrder(orders, state.order) } } : { order: cancel(state.order) }),
    stations: Array.isArray(state.stations) ? state.stations.map(cleared) : state.stations,
    burgerLevel: { ...state.burgerLevel, status: "ended" },
  }, now);
}

/**
 * Advance a RUNNING round by `elapsedMs` the way the real Pi's projection tick
 * does, and return the next state (the input is never mutated). This is the one
 * place the browser side simulates timers; the renderer only displays them.
 *
 * - the round clock counts down and, at zero, the round ends (setup.phase
 *   ENDED, clock.status "ended", open orders cancelled, workstations cleared);
 * - active orders count down with `patience.filledSegments` recomputed, and an
 *   order that reaches zero becomes "expired";
 * - a chopping board's progress follows remaining/total and finishes "ready";
 * - a stove runs cooking -> done -> warning -> burnt (COOK/DONE/WARNING
 *   seconds as in projection.mjs).
 *
 * Returns the same `state` object when the round is not running or no time has
 * elapsed, so callers can cheaply detect a no-op.
 */
export function advanceMockState(state, elapsedMs, now = Date.now(), random = Math.random) {
  const elapsed = Number(elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return state;
  if (state?.setup?.phase !== SETUP_PHASES.RUNNING || state.clock?.status !== "running") return state;

  const clockMs = carriedRemainingMs(state.clock, Number(state.clock.remainingSeconds || 0) * 1000) - elapsed;
  if (clockMs <= 0) return endRound(state, now);

  const hasOrders = Array.isArray(state.orders) && state.orders.length > 0;
  let orders = hasOrders ? state.orders.map((order) => advanceOrder(order, elapsed, now)) : state.orders;
  // Only a round started through START_GAME carries a schedule, so hand-built
  // fixture states keep their fixed order list.
  const newlyExpired = hasOrders ? orders.filter((order, index) => order.status === "expired" && state.orders[index]?.status === "active").length : 0;
  const penaltyCoins = newlyExpired * EXPIRED_ORDER_PENALTY;
  let schedule = hasOrders && state.orderSchedule ? { ...state.orderSchedule, nextInMs: state.orderSchedule.nextInMs - elapsed } : null;
  if (schedule) {
    const open = orders.filter(isActiveOrder).length;
    if (open === 0 || (schedule.nextInMs <= 0 && open < MAX_ACTIVE_ORDERS)) ({ orders, schedule } = issueOrder(orders, schedule, random));
    else if (schedule.nextInMs <= 0) schedule = { ...schedule, nextInMs: randomIntervalMs(random) };
  }
  return {
    ...state,
    clock: { ...state.clock, remainingSeconds: Math.ceil(clockMs / 1000), remainingMs: clockMs },
    ...(penaltyCoins ? {
      score: { ...state.score, value: Number(state.score?.value || 0) - penaltyCoins },
      penalties: { total: Number(state.penalties?.total || 0) + penaltyCoins, lastChange: -penaltyCoins },
    } : {}),
    ...(hasOrders
      ? { orders, order: { ...withPrimaryOrder(orders, state.order) }, ...(schedule ? { orderSchedule: schedule } : {}) }
      : { order: advanceOrder(state.order, elapsed, now) }),
    stations: Array.isArray(state.stations) ? state.stations.map((station) => advanceStation(station, elapsed)) : state.stations,
  };
}

export function createMockTransport({ initialState, now = () => Date.now(), random = Math.random } = {}) {
  let state = cloneState(initialState || createInitialMockState(now()));
  const listeners = new Set();
  const emit = () => { const snapshot = cloneState(state); listeners.forEach((listener) => listener(snapshot)); };
  // The mock stands in for the Pi's projection tick: every second it advances a
  // running round by the real time that passed (advanceMockState is a no-op
  // unless the round is running, or when `now` has not moved).
  let lastTickAt = now();
  const tick = () => {
    const at = now();
    const elapsedMs = at - lastTickAt;
    lastTickAt = at;
    state = advanceMockState(state, elapsedMs, at, random);
  };
  // Real badges keep re-scanning, so tracking.lastSeenAt keeps advancing. The
  // mock never dispatches anything per-player, so without a heartbeat every
  // player's lastSeenAt freezes at game start and trips staleAfterMs (20s),
  // fading all players (.is-stale) for the rest of the round.
  const heartbeat = setInterval(() => {
    tick();
    if (!listeners.size || !Array.isArray(state.players)) return;
    const seenAt = now();
    const players = state.players.map((player) => player.tracking?.status === "healthy"
      ? { ...player, tracking: { ...player.tracking, lastSeenAt: seenAt } }
      : player);
    state = { ...state, players };
    emit();
  }, 1_000);
  // Don't keep a Node process (tests) alive just for the heartbeat.
  if (typeof heartbeat === "object" && typeof heartbeat.unref === "function") heartbeat.unref();
  return {
    kind: "mock",
    connect(listener) { listeners.add(listener); listener(cloneState(state)); return () => listeners.delete(listener); },
    snapshot() { return cloneState(state); },
    async command(command) { tick(); state = reduceMockState(state, command, now(), random); emit(); return cloneState(state); },
    close() { clearInterval(heartbeat); listeners.clear(); },
  };
}
