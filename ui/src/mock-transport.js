import { cloneState, GAME_ACTIONS, SETUP_PHASES } from "./state.js";

const PLAN = {
  accepted: true,
  width: 100,
  height: 68,
  walls: [
    { x: 0, y: 0, width: 100, height: 3 },
    { x: 0, y: 65, width: 100, height: 3 },
    { x: 0, y: 0, width: 2, height: 68 },
    { x: 98, y: 0, width: 2, height: 68 },
  ],
  stations: [
    { id: "ingredient", label: "TOMATO", kind: "ingredient", x: 10, y: 16, width: 15, height: 10 },
    { id: "chop1", label: "CHOP 1", kind: "chop", x: 37, y: 12, width: 15, height: 10 },
    { id: "pot1", label: "POT 1", kind: "pot", x: 65, y: 13, width: 15, height: 10 },
    { id: "delivery", label: "DELIVERY", kind: "delivery", x: 80, y: 48, width: 16, height: 10 },
  ],
};

function health(now) {
  return {
    gateway: {
      id: "gateway",
      label: "GATEWAY BADGE",
      status: "healthy",
      lastSeenAt: now,
      detail: "USB link online",
    },
    workers: [
      { id: "camera-1", label: "CAMERA 1", status: "healthy", lastSeenAt: now, detail: "Worker Pi 1" },
      { id: "camera-2", label: "CAMERA 2", status: "healthy", lastSeenAt: now, detail: "Worker Pi 2" },
      { id: "camera-3", label: "CAMERA 3", status: "healthy", lastSeenAt: now, detail: "Worker Pi 3" },
    ],
    inference: { id: "inference", label: "AI INFERENCE", status: "healthy", lastSeenAt: now, detail: "On-device" },
    trackingCoverage: "healthy",
  };
}

export function createInitialMockState(now = Date.now()) {
  return {
    version: 1,
    source: "mock-master-pi",
    setup: {
      phase: SETUP_PHASES.LAYOUT_ACCEPTED,
      message: "Layout accepted. Start the game when players are ready.",
      updatedAt: now,
    },
    floorPlan: cloneState(PLAN),
    players: [
      {
        id: "p1",
        label: "P1",
        name: "PLAYER 1",
        color: "orange",
        position: { x: 24, y: 48 },
        tracking: { status: "healthy", source: "camera-1", lastSeenAt: now, staleAfterMs: 2_000 },
        inventory: ["RAW TOMATO"],
      },
      {
        id: "p2",
        label: "P2",
        name: "PLAYER 2",
        color: "cyan",
        position: { x: 59, y: 38 },
        tracking: { status: "healthy", source: "camera-2", lastSeenAt: now, staleAfterMs: 2_000 },
        inventory: [],
      },
    ],
    order: {
      id: "order-1",
      dish: "TOMATO SOUP",
      status: "active",
      remainingSeconds: 78,
      totalSeconds: 120,
      ingredients: ["TOMATO", "CHOPPED TOMATO", "COOKED SOUP"],
    },
    stations: [
      {
        id: "pot1",
        label: "POT 1",
        kind: "pot",
        status: "cooking",
        progress: 0.64,
        remainingSeconds: 18,
        item: "TOMATO SOUP",
      },
      {
        id: "chop1",
        label: "CHOP 1",
        kind: "chop",
        status: "ready",
        progress: 1,
        remainingSeconds: 0,
        item: "CHOPPED TOMATO",
      },
    ],
    score: { value: 0, delivered: 0 },
    clock: { status: "ready", remainingSeconds: 78, totalSeconds: 120 },
    delivery: { lastEvent: null },
    health: health(now),
  };
}

function withUpdate(state, changes, now) {
  return {
    ...state,
    ...changes,
    setup: { ...state.setup, ...changes.setup, updatedAt: now },
  };
}

function scanLayout(state, now) {
  return withUpdate(state, {
    setup: { ...state.setup, phase: SETUP_PHASES.LAYOUT_PROPOSED, message: "Room scan complete. Review the proposed layout before accepting it." },
    floorPlan: { ...state.floorPlan, accepted: false },
  }, now);
}

function acceptLayout(state, now) {
  if (state.setup.phase !== SETUP_PHASES.LAYOUT_PROPOSED) return state;
  return withUpdate(state, {
    setup: { ...state.setup, phase: SETUP_PHASES.LAYOUT_ACCEPTED, message: "Layout accepted. Start the game when players are ready." },
    floorPlan: { ...state.floorPlan, accepted: true },
  }, now);
}

function startGame(state, now) {
  if (state.floorPlan?.accepted !== true) return state;
  return withUpdate(state, {
    setup: { ...state.setup, phase: SETUP_PHASES.RUNNING, message: "Game running. The master Pi is authoritative." },
    score: { value: 0, delivered: 0 },
    delivery: { lastEvent: null },
    clock: { ...state.clock, status: "running", remainingSeconds: state.clock.totalSeconds },
    order: { ...state.order, status: "active", remainingSeconds: state.order.totalSeconds },
  }, now);
}

function endGame(state, now) {
  if (state.setup.phase !== SETUP_PHASES.RUNNING) return state;
  return withUpdate(state, {
    setup: { ...state.setup, phase: SETUP_PHASES.ENDED, message: "Game ended. Reset or scan the room for another round." },
    clock: { ...state.clock, status: "ended" },
  }, now);
}

function recordDelivery(state, success, now) {
  const amount = 100;
  const event = success
    ? { status: "success", message: "ORDER COMPLETE", detail: "TOMATO SOUP delivered", points: amount, at: now }
    : { status: "failure", message: "WRONG ORDER", detail: "Plate rejected by the master Pi", points: 0, at: now };
  return withUpdate(state, {
    score: success
      ? { ...state.score, value: Number(state.score?.value || 0) + amount, delivered: Number(state.score?.delivered || 0) + 1 }
      : { ...state.score },
    order: success ? { ...state.order, status: "completed" } : { ...state.order, status: "active" },
    delivery: { lastEvent: event },
  }, now);
}

export function reduceMockState(state, command, now = Date.now()) {
  const action = typeof command === "string" ? command : command?.type;
  switch (action) {
    case GAME_ACTIONS.SCAN_ROOM:
    case GAME_ACTIONS.RESCAN:
      return scanLayout(state, now);
    case GAME_ACTIONS.ACCEPT_LAYOUT:
      return acceptLayout(state, now);
    case GAME_ACTIONS.START_GAME:
      return startGame(state, now);
    case GAME_ACTIONS.END_GAME:
      return endGame(state, now);
    case GAME_ACTIONS.RESET_GAME:
      return createInitialMockState(now);
    case GAME_ACTIONS.DELIVERY_SUCCESS:
      return recordDelivery(state, true, now);
    case GAME_ACTIONS.DELIVERY_FAILURE:
      return recordDelivery(state, false, now);
    default:
      return state;
  }
}

export function createMockTransport({ initialState, now = () => Date.now() } = {}) {
  let state = cloneState(initialState || createInitialMockState(now()));
  const listeners = new Set();

  const emit = () => {
    const snapshot = cloneState(state);
    listeners.forEach((listener) => listener(snapshot));
  };

  return {
    kind: "mock",
    connect(listener) {
      listeners.add(listener);
      listener(cloneState(state));
      return () => listeners.delete(listener);
    },
    snapshot() {
      return cloneState(state);
    },
    async command(command) {
      state = reduceMockState(state, command, now());
      emit();
      return cloneState(state);
    },
    close() {
      listeners.clear();
    },
  };
}
