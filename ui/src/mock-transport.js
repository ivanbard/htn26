import { cloneState, GAME_ACTIONS, SETUP_PHASES } from "./state.js";

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
    { id: "cheese-source", label: "CHEESE", kind: "ingredient", x: 7, y: 12, width: 13, height: 9 },
    { id: "lettuce-source", label: "LETTUCE", kind: "ingredient", x: 23, y: 12, width: 13, height: 9 },
    { id: "meat-source", label: "MEAT", kind: "ingredient", x: 39, y: 12, width: 13, height: 9 },
    { id: "buns-source", label: "BUNS", kind: "ingredient", x: 55, y: 12, width: 13, height: 9 },
    { id: "chop1", label: "CHOP 1", kind: "chop", x: 16, y: 43, width: 15, height: 10 },
    { id: "chop2", label: "CHOP 2", kind: "chop", x: 36, y: 43, width: 15, height: 10 },
    { id: "stove1", label: "STOVE 1", kind: "stove", x: 59, y: 40, width: 14, height: 12 },
    { id: "stove2", label: "STOVE 2", kind: "stove", x: 76, y: 40, width: 14, height: 12 },
    { id: "serving", label: "SERVING", kind: "delivery", x: 78, y: 12, width: 17, height: 11 },
  ],
};

const PLACEMENT_INSTRUCTIONS = [
  { id: "cheese-source", label: "CHEESE SOURCE", instruction: "Place printed cheese icon here", x: 7, y: 12 },
  { id: "lettuce-source", label: "LETTUCE SOURCE", instruction: "Place printed lettuce icon here", x: 23, y: 12 },
  { id: "meat-source", label: "MEAT SOURCE", instruction: "Place printed meat icon here", x: 39, y: 12 },
  { id: "buns-source", label: "BUN SOURCE", instruction: "Place bun icons beside serving", x: 55, y: 12 },
  { id: "chop1", label: "CHOPPING BOARD 1", instruction: "Keep stationary", x: 16, y: 43 },
  { id: "chop2", label: "CHOPPING BOARD 2", instruction: "Keep stationary", x: 36, y: 43 },
  { id: "stove1", label: "STOVE 1", instruction: "Place paper stove plate", x: 59, y: 40 },
  { id: "stove2", label: "STOVE 2", instruction: "Place paper stove plate", x: 76, y: 40 },
  { id: "serving", label: "SERVING / GEESE", instruction: "Master badge and goose queue", x: 78, y: 12 },
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

export function createInitialMockState(now = Date.now()) {
  return {
    version: 2,
    source: "mock-master-pi",
    setup: { phase: SETUP_PHASES.IDLE, message: "Host is idle. Start to scan the room and generate a floor plan.", updatedAt: now },
    floorPlan: cloneState(PROPOSED_PLAN),
    burgerLevel: burgerLevel(),
    players: [
      { id: "p1", label: "P1", name: "PLAYER 1", color: "orange", position: { x: 24, y: 56 }, tracking: { status: "healthy", source: "camera-1", lastSeenAt: now, staleAfterMs: 2_000 }, inventory: ["BUN"] },
      { id: "p2", label: "P2", name: "PLAYER 2", color: "cyan", position: { x: 56, y: 56 }, tracking: { status: "healthy", source: "camera-2", lastSeenAt: now, staleAfterMs: 2_000 }, inventory: ["RAW MEAT"] },
    ],
    order: { id: "order-1", dish: "BURGER", status: "active", remainingSeconds: 112, totalSeconds: 120, toppings: ["CHEESE", "LETTUCE"], components: ["BUN", "MEAT", "CHEESE", "LETTUCE"] },
    stations: [
      { id: "stove1", label: "STOVE 1", kind: "stove", status: "cooking", progress: 0.62, remainingSeconds: 22, item: "MEAT PATTY" },
      { id: "chop1", label: "CHOP 1", kind: "chop", status: "ready", progress: 1, remainingSeconds: 0, item: "LETTUCE" },
      { id: "chop2", label: "CHOP 2", kind: "chop", status: "chopping", progress: 0.4, remainingSeconds: 9, item: "CHEESE" },
    ],
    score: { value: 0, delivered: 0 },
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
    setup: { phase: SETUP_PHASES.LAYOUT_PROPOSED, message: "Proposed floor plan ready. Approve it to generate burger-level placement instructions." },
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
    score: { value: 0, delivered: 0 },
    clock: { ...state.clock, status: "running", remainingSeconds: state.clock.totalSeconds },
    order: { ...state.order, status: "active", remainingSeconds: state.order.totalSeconds },
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
  const event = success
    ? { status: "success", message: "BURGER SERVED", detail: "Order matched at the serving badge", points: amount, at: now }
    : { status: "failure", message: "WRONG BURGER", detail: "Serving badge rejected the topping combination", points: 0, at: now };
  return withUpdate(state, {
    score: success ? { ...state.score, value: Number(state.score?.value || 0) + amount, delivered: Number(state.score?.delivered || 0) + 1 } : { ...state.score },
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
