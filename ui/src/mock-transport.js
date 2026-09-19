import { cloneState, GAME_ACTIONS, SETUP_PHASES } from "./state.js";

export const BURGER_RECIPES = Object.freeze([
  { id: "plain-meat", name: "PLAIN MEAT BURGER", ingredients: ["BUN", "MEAT"], toppings: [] },
  { id: "cheeseburger", name: "CHEESEBURGER", ingredients: ["BUN", "MEAT", "CHEESE"], toppings: ["CHEESE"] },
  { id: "lettuce-meat", name: "LETTUCE-MEAT BURGER", ingredients: ["BUN", "MEAT", "LETTUCE"], toppings: ["LETTUCE"] },
  { id: "cheese-lettuce-meat", name: "CHEESE-LETTUCE-MEAT BURGER", ingredients: ["BUN", "MEAT", "CHEESE", "LETTUCE"], toppings: ["CHEESE", "LETTUCE"] },
]);

const PROPOSED_PLAN = {
  accepted: false,
  width: 100,
  height: 68,
  walls: [
    { x: 0, y: 0, width: 100, height: 3 },
    { x: 0, y: 65, width: 100, height: 3 },
    { x: 0, y: 0, width: 2, height: 68 },
    { x: 98, y: 0, width: 2, height: 68 },
  ],
  stations: [
    { id: "pantry", label: "PANTRY", kind: "ingredient", x: 8, y: 13, width: 19, height: 13 },
    { id: "fridge", label: "FRIDGE", kind: "ingredient", x: 31, y: 13, width: 19, height: 13 },
    { id: "cutting-board", label: "CUTTING BOARD", kind: "chop", x: 14, y: 43, width: 28, height: 13 },
    { id: "stove", label: "STOVE", kind: "stove", x: 58, y: 40, width: 28, height: 16 },
  ],
};

const PLACEMENT_INSTRUCTIONS = [
  { id: "pantry", label: "PANTRY ZONE", instruction: "Place pantry NFC sticker for buns and lettuce", x: 8, y: 13 },
  { id: "fridge", label: "FRIDGE ZONE", instruction: "Place fridge NFC sticker for cheese and meat", x: 31, y: 13 },
  { id: "cutting-board", label: "CUTTING BOARD ZONE", instruction: "Keep cutting-board NFC sticker stationary", x: 14, y: 43 },
  { id: "stove", label: "STOVE ZONE", instruction: "Place the two logical stove positions here", x: 58, y: 40 },
];

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

function initialOrder() {
  return { id: "order-1", recipeId: "cheese-lettuce-meat", recipe: "CHEESE-LETTUCE-MEAT BURGER", dish: "BURGER", status: "active", remainingSeconds: 112, totalSeconds: 120, patienceSegments: ["full", "full", "full"], toppings: ["CHEESE", "LETTUCE"], components: ["BUN", "MEAT", "CHEESE", "LETTUCE"] };
}

export function createInitialMockState(now = Date.now()) {
  const order = initialOrder();
  return {
    version: 2,
    source: "mock-master-pi",
    setup: { phase: SETUP_PHASES.IDLE, message: "Host is idle. Start to review the static floor plan.", updatedAt: now },
    floorPlan: cloneState(PROPOSED_PLAN),
    burgerLevel: burgerLevel(),
    players: [
      { id: "p1", label: "P1", name: "PLAYER 1", color: "orange", heldItem: "BUN", actionState: "READY", tracking: { status: "healthy", source: "gateway", lastSeenAt: now, staleAfterMs: 2_000 }, inventory: ["BUN"] },
      { id: "p2", label: "P2", name: "PLAYER 2", color: "cyan", heldItem: "RAW MEAT", actionState: "CHOPPING", tracking: { status: "healthy", source: "gateway", lastSeenAt: now, staleAfterMs: 2_000 }, inventory: ["RAW MEAT"] },
      { id: "p3", label: "P3", name: "PLAYER 3", color: "purple", heldItem: "EMPTY HANDS", actionState: "READY", tracking: { status: "healthy", source: "gateway", lastSeenAt: now, staleAfterMs: 2_000 }, inventory: [] },
    ],
    recipes: cloneState(BURGER_RECIPES),
    orders: [order],
    order,
    stations: [
      { id: "stove1", label: "STOVE 1", kind: "stove", status: "cooking", progress: 0.62, remainingSeconds: 22, item: "MEAT PATTY" },
      { id: "chop1", label: "CHOP 1", kind: "chop", status: "ready", progress: 1, remainingSeconds: 0, item: "LETTUCE" },
      { id: "chop2", label: "CHOP 2", kind: "chop", status: "chopping", progress: 0.4, remainingSeconds: 9, item: "CHEESE" },
      { id: "chop3", label: "CHOP 3", kind: "chop", status: "chopping", progress: 0.25, remainingSeconds: 14, item: "MEAT" },
    ],
    score: { value: 0, delivered: 0, gold: 0, tips: 0, penalties: 0 },
    submission: { status: "idle", message: "No submission yet", detail: "All three players shake together to submit a plate." },
    clock: { status: "ready", remainingSeconds: 112, totalSeconds: 120 },
    serving: { lastEvent: null, gooseQueue: 4, location: "SERVING" },
    health: health(now),
  };
}

function withUpdate(state, changes, now) {
  return { ...state, ...changes, setup: { ...state.setup, ...changes.setup, updatedAt: now } };
}

function startHost(state, now) {
  return withUpdate(state, { setup: { phase: SETUP_PHASES.SCANNING, message: "Host started. Cameras are scanning the room for a proposed floor plan." } }, now);
}

function scanRoom(state, now) {
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.LAYOUT_PROPOSED, message: "Proposed floor plan ready. Review and approve it to generate burger-level placement instructions." },
    floorPlan: { ...state.floorPlan, accepted: false },
  }, now);
}

function rescanRoom(state, now) {
  if (![SETUP_PHASES.SCANNING, SETUP_PHASES.LAYOUT_PROPOSED, SETUP_PHASES.BURGER_PLACEMENT, SETUP_PHASES.LAYOUT_ACCEPTED].includes(state.setup.phase)) return state;
  return scanRoom(state, now);
}

function approveLayout(state, now) {
  if (state.setup.phase !== SETUP_PHASES.LAYOUT_PROPOSED) return state;
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.BURGER_PLACEMENT, message: "Burger level generated. Place the ingredients, chopping boards, stoves, and serving badge as shown." },
    floorPlan: { ...state.floorPlan, accepted: true },
    burgerLevel: { ...state.burgerLevel, status: "placement-ready" },
  }, now);
}

function startGame(state, now) {
  if (state.floorPlan?.accepted !== true) return state;
  return withUpdate(state, {
    setup: { phase: SETUP_PHASES.RUNNING, message: "Burger game running. Live locations and orders come from the master Pi." },
    score: { value: 0, delivered: 0, gold: 0, tips: 0, penalties: 0 },
    clock: { ...state.clock, status: "running", remainingSeconds: state.clock.totalSeconds },
    orders: (state.orders || [state.order]).map((order) => ({ ...order, status: "active", remainingSeconds: order.totalSeconds, patienceSegments: ["full", "full", "full"] })),
    order: { ...state.order, status: "active", remainingSeconds: state.order.totalSeconds, patienceSegments: ["full", "full", "full"] },
    serving: { ...state.serving, lastEvent: null },
    burgerLevel: { ...state.burgerLevel, status: "in-play" },
  }, now);
}

function endGame(state, now) {
  if (state.setup.phase !== SETUP_PHASES.RUNNING) return state;
  return withUpdate(state, { setup: { phase: SETUP_PHASES.ENDED, message: "Game ended. Reset to host another burger level." }, clock: { ...state.clock, status: "ended" } }, now);
}

function recordDelivery(state, success, now) {
  const amount = 100;
  const tip = success ? 25 : 0;
  const event = success
    ? { status: "success", message: "BURGER SERVED", detail: "Order matched after the three-player shake", points: amount, gold: amount, tip, at: now }
    : { status: "failure", message: "WRONG BURGER", detail: "The master Pi rejected the submitted plate", points: 0, gold: -25, tip: 0, at: now };
  return withUpdate(state, {
    score: success
      ? { ...state.score, value: Number(state.score?.value || 0) + amount, delivered: Number(state.score?.delivered || 0) + 1, gold: Number(state.score?.gold || 0) + amount, tips: Number(state.score?.tips || 0) + tip }
      : { ...state.score, gold: Number(state.score?.gold || 0) - 25, penalties: Number(state.score?.penalties || 0) + 1 },
    submission: { status: event.status, message: event.message, detail: event.detail, gold: event.gold, tip: event.tip, at: now },
    orders: (state.orders || [state.order]).map((order, index) => index === 0 ? { ...order, status: success ? "completed" : "active" } : order),
    order: success ? { ...state.order, status: "completed" } : { ...state.order, status: "active" },
    serving: { ...state.serving, lastEvent: event },
  }, now);
}

export function reduceMockState(state, command, now = Date.now()) {
  const action = typeof command === "string" ? command : command?.type;
  switch (action) {
    case GAME_ACTIONS.START_HOST: return startHost(state, now);
    case GAME_ACTIONS.SCAN_ROOM: return scanRoom(state, now);
    case GAME_ACTIONS.RESCAN: return rescanRoom(state, now);
    case GAME_ACTIONS.APPROVE_LAYOUT: return approveLayout(state, now);
    case GAME_ACTIONS.START_GAME: return startGame(state, now);
    case GAME_ACTIONS.END_GAME: return endGame(state, now);
    case GAME_ACTIONS.RESET_GAME: return createInitialMockState(now);
    case GAME_ACTIONS.DELIVERY_SUCCESS: return recordDelivery(state, true, now);
    case GAME_ACTIONS.DELIVERY_FAILURE: return recordDelivery(state, false, now);
    default: return state;
  }
}

export function createMockTransport({ initialState, now = () => Date.now() } = {}) {
  let state = cloneState(initialState || createInitialMockState(now()));
  const listeners = new Set();
  const emit = () => { const snapshot = cloneState(state); listeners.forEach((listener) => listener(snapshot)); };
  return {
    kind: "mock",
    connect(listener) { listeners.add(listener); listener(cloneState(state)); return () => listeners.delete(listener); },
    snapshot() { return cloneState(state); },
    async command(command) { state = reduceMockState(state, command, now()); emit(); return cloneState(state); },
    close() { listeners.clear(); },
  };
}
