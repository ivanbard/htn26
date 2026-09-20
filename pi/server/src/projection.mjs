import { LocalFloorplanProvider, localPlan } from "./provider.mjs";

const ROUND_SECONDS = 240;
const CHOP_SECONDS = 3;
const COOK_SECONDS = 15;
const DONE_SECONDS = 2;
const WARNING_SECONDS = 3;
const DEFAULT_ORDER_INTERVAL_SECONDS = 30;
const WRONG_ORDER_PENALTY = 25;
const EXPIRED_ORDER_PENALTY = 20;
const DEFAULT_LOCATION_HOLD_SECONDS = 2;
const HISTORY_LIMIT = 100;

export const BURGER_RECIPES = Object.freeze([
  { id: "PLAIN_MEAT", name: "PLAIN MEAT BURGER", toppings: [], components: ["BUN", "MEAT"], gold: 100 },
  { id: "CHEESEBURGER", name: "CHEESEBURGER", toppings: ["CHEESE"], components: ["BUN", "MEAT", "CHEESE"], gold: 120 },
  { id: "LETTUCE_MEAT", name: "LETTUCE-MEAT BURGER", toppings: ["LETTUCE"], components: ["BUN", "MEAT", "LETTUCE"], gold: 120 },
  { id: "CHEESE_LETTUCE_MEAT", name: "CHEESE-LETTUCE-MEAT BURGER", toppings: ["CHEESE", "LETTUCE"], components: ["BUN", "MEAT", "CHEESE", "LETTUCE"], gold: 150 },
]);

const RECIPE_BY_ID = new Map(BURGER_RECIPES.map((recipe) => [recipe.id, recipe]));
const DEFAULT_PLAYERS = [
  { id: "p1", label: "P1", name: "PLAYER 1", color: "orange" },
  { id: "p2", label: "P2", name: "PLAYER 2", color: "cyan" },
  { id: "p3", label: "P3", name: "PLAYER 3", color: "violet" },
];
const SHORT_ITEMS = Object.freeze({
  B: "BUN", R: "RAW_MEAT", M: "CHOPPED_MEAT", X: "BURNT_MEAT",
  Q: "RAW_LETTUCE", L: "LETTUCE", K: "RAW_CHEESE", C: "CHEESE",
});
const PLATE_ITEMS = new Set(["BUN", "COOKED_MEAT", "MEAT", "LETTUCE", "CHEESE"]);
const RAW_TO_CHOPPED = Object.freeze({ RAW_MEAT: "CHOPPED_MEAT", RAW_LETTUCE: "LETTUCE", RAW_CHEESE: "CHEESE" });

function clone(value) { return structuredClone(value); }
function iso(ms) { return new Date(ms).toISOString(); }
function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.floor(number))) : fallback;
}
function plateComponent(item) {
  if (item === "BUN") return "BUN";
  if (item === "MEAT" || item === "COOKED_MEAT") return "MEAT";
  if (item === "LETTUCE") return "LETTUCE";
  if (item === "CHEESE") return "CHEESE";
  return null;
}
function plateSummary(items = []) {
  const values = new Set(items.map(plateComponent).filter(Boolean));
  return `${values.has("BUN") ? "B" : "-"}${values.has("MEAT") ? "M" : "-"}${values.has("LETTUCE") ? "L" : "-"}${values.has("CHEESE") ? "C" : "-"}`;
}
function itemsFromPlateSummary(summary) {
  if (!/^(?:B|-)(?:M|-)(?:L|-)(?:C|-)$/.test(String(summary || ""))) return null;
  const items = [];
  if (summary[0] === "B") items.push("BUN");
  if (summary[1] === "M") items.push("MEAT");
  if (summary[2] === "L") items.push("LETTUCE");
  if (summary[3] === "C") items.push("CHEESE");
  return items;
}
function sameComponents(left, right) {
  return [...left].sort().join("|") === [...right].sort().join("|");
}
function patienceTier(remaining, total) {
  if (remaining <= 0 || total <= 0) return 0;
  const ratio = remaining / total;
  if (ratio > 2 / 3) return 3;
  if (ratio > 1 / 3) return 2;
  return 1;
}
function makePlayer(player, now) {
  return {
    ...player,
    badgeMac: null,
    position: null,
    tracking: { status: "unknown", source: "badge-projection", lastSeenAt: null, staleAfterMs: 2000 },
    inventory: [],
    hand: null,
    hasPlate: false,
    plate: [],
    heldItem: "EMPTY",
    actionState: "idle",
    processing: null,
    lastCompletedChop: null,
    submissionReadyUntil: null,
    currentStation: "center",
    simulatedLocation: { stationId: "center", label: "CENTER / DEFAULT", source: "action-inference", sinceAt: iso(now), returnAt: null },
  };
}
function makeStations() {
  return [
    { id: "pantry", label: "PANTRY", kind: "ingredient", status: "idle", progress: 0, remainingSeconds: 0, item: null },
    { id: "fridge", label: "FRIDGE", kind: "ingredient", status: "idle", progress: 0, remainingSeconds: 0, item: null },
    { id: "cutting-board", label: "CUTTING BOARD", kind: "chop", status: "idle", progress: 0, remainingSeconds: 0, item: null },
    { id: "stove-left", label: "STOVE 1", kind: "stove", side: "LEFT", status: "idle", progress: 0, remainingSeconds: 0, item: null, startedAt: null, doneAt: null, warningAt: null, burntAt: null },
    { id: "stove-right", label: "STOVE 2", kind: "stove", side: "RIGHT", status: "idle", progress: 0, remainingSeconds: 0, item: null, startedAt: null, doneAt: null, warningAt: null, burntAt: null },
    { id: "serving", label: "SERVING", kind: "serving", status: "idle", progress: 0, remainingSeconds: 0, item: null },
  ];
}
function makeMoney() {
  return {
    gold: 0,
    tips: 0,
    penalties: 0,
    net: 0,
    lastChange: 0,
  };
}
function makeOrder(id, recipe, now, patienceSeconds) {
  return {
    id,
    dish: "BURGER",
    recipe: recipe.id,
    recipeName: recipe.name,
    status: "active",
    issuedAt: iso(now),
    patienceSeconds,
    deadlineAt: iso(now + patienceSeconds * 1000),
    remainingSeconds: patienceSeconds,
    totalSeconds: patienceSeconds,
    patienceState: 3,
    patience: { segments: 3, filledSegments: 3, remainingSeconds: patienceSeconds, totalSeconds: patienceSeconds, state: 3 },
    toppings: [...recipe.toppings],
    components: [...recipe.components],
    goldValue: recipe.gold,
    penalty: 0,
  };
}

export function createInitialProjectionState(now = Date.now(), roundSeconds = ROUND_SECONDS) {
  const plan = localPlan({ generatedAt: iso(now), photoCount: 0 });
  return {
    version: 1,
    source: "pi-server-simulator",
    setup: { phase: "idle", message: "Upload 3-4 room photos for setup, or start the local simulator with a host serial record.", updatedAt: iso(now) },
    floorPlan: plan,
    burgerLevel: { status: "not-generated", recipe: "BURGER", placementInstructions: clone(plan.placementInstructions) },
    photos: [],
    players: DEFAULT_PLAYERS.map((player) => makePlayer(player, now)),
    orders: [],
    activeOrders: [],
    order: null,
    gold: { total: 0, earned: 0, lastChange: 0 },
    tips: { total: 0, earned: 0, lastChange: 0 },
    penalties: { total: 0, lastChange: 0 },
    money: makeMoney(),
    score: { value: 0, delivered: 0 },
    timer: { status: "ready", remainingSeconds: roundSeconds, totalSeconds: roundSeconds },
    clock: { status: "ready", remainingSeconds: roundSeconds, totalSeconds: roundSeconds },
    submissions: [],
    eventHistory: [],
    serving: { lastEvent: null, gooseQueue: 4, location: "SERVING" },
    stations: makeStations(),
    health: {
      gateway: { id: "gateway", label: "GATEWAY BADGE", status: "unknown", lastSeenAt: null, detail: "Waiting for host-badge serial" },
      inference: { id: "inference", label: "SETUP INFERENCE", status: "healthy", lastSeenAt: iso(now), detail: plan.reviewMessage },
      trackingCoverage: "unknown",
      workers: [],
    },
  };
}

export class ServerProjection {
  constructor({ provider, now = () => Date.now(), roundSeconds = ROUND_SECONDS,
    orderIntervalSeconds, orderIntervalMinSeconds = 8, orderIntervalMaxSeconds = 35,
    orderPatienceSeconds, maxActiveOrders = 3, locationHoldSeconds = DEFAULT_LOCATION_HOLD_SECONDS,
    random = Math.random, authoritativeEngine } = {}) {
    this.now = now;
    this.provider = provider || new LocalFloorplanProvider({ now });
    this.roundSeconds = clampInteger(roundSeconds, 1, 3600, ROUND_SECONDS);
    const fixedInterval = Number(orderIntervalSeconds);
    this.orderIntervalMinSeconds = clampInteger(Number.isFinite(fixedInterval) ? fixedInterval : orderIntervalMinSeconds, 1, 120, 8);
    this.orderIntervalMaxSeconds = clampInteger(Number.isFinite(fixedInterval) ? fixedInterval : orderIntervalMaxSeconds, this.orderIntervalMinSeconds, 180, 35);
    this.orderPatienceSeconds = Number.isFinite(Number(orderPatienceSeconds)) ? clampInteger(orderPatienceSeconds, 3, 600, DEFAULT_ORDER_INTERVAL_SECONDS) : null;
    this.maxActiveOrders = clampInteger(maxActiveOrders, 1, 6, 3);
    this.locationHoldSeconds = clampInteger(locationHoldSeconds, 0, 30, DEFAULT_LOCATION_HOLD_SECONDS);
    this.random = typeof random === "function" ? random : Math.random;
    this.authoritativeEngine = authoritativeEngine || null;
    this._nextOrderAt = null;
    this._orderSequence = 0;
    this._state = createInitialProjectionState(now(), this.roundSeconds);
    this._badges = new Map();
    this._seenEvents = new Set();
    this._listeners = new Set();
    this._roundStartedAt = null;
    this._roundDurationSeconds = this.roundSeconds;
    this._pendingTransfer = null;
    this._pendingSubmission = null;
    this._historySequence = 0;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(now = this.now()) {
    this._state.setup.updatedAt = iso(now);
    const snapshot = clone(this._state);
    for (const listener of this._listeners) listener(snapshot);
  }

  _publish(now = this.now()) {
    this._state.version += 1;
    this._emit(now);
  }

  _touch(now = this.now()) { this._publish(now); }

  _record(type, message, now = this.now(), details = {}) {
    this._state.eventHistory.push({
      id: `event-${++this._historySequence}`,
      type,
      message,
      at: iso(now),
      ...clone(details),
    });
    while (this._state.eventHistory.length > HISTORY_LIMIT) this._state.eventHistory.shift();
  }

  applyAuthoritativeSnapshot(snapshot, now = this.now()) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("an authoritative snapshot is required");
    this._state = clone(snapshot);
    this._state.setup ??= { phase: "idle", message: "", updatedAt: iso(now) };
    this._state.setup.updatedAt = iso(now);
    this._state.eventHistory ??= [];
    this._emit(now);
    return this.snapshot(now);
  }

  _randomSeconds(minimum = this.orderIntervalMinSeconds, maximum = this.orderIntervalMaxSeconds) {
    const span = maximum - minimum;
    const value = Math.max(0, Math.min(0.999999, Number(this.random()) || 0));
    return minimum + Math.floor(value * (span + 1));
  }

  _patienceSeconds() {
    return this.orderPatienceSeconds || this._randomSeconds();
  }

  _activeOrders() { return this._state.orders.filter((order) => order.status === "active"); }

  _syncActiveOrder() {
    const active = this._activeOrders();
    this._state.activeOrders = clone(active);
    this._state.order = active[0] ? clone(active[0]) : null;
  }

  _issueOrder(now = this.now()) {
    const recipe = BURGER_RECIPES[this._orderSequence % BURGER_RECIPES.length];
    this._orderSequence += 1;
    const order = makeOrder(`order-${this._orderSequence}`, recipe, now, this._patienceSeconds());
    this._state.orders.push(order);
    while (this._state.orders.length > 32) this._state.orders.shift();
    this._syncActiveOrder();
    this._record("order-created", `${order.recipeName} ordered`, now, { orderId: order.id, recipe: order.recipe });
    return order;
  }

  _syncMoney(lastChange = 0) {
    const gold = this._state.gold.total;
    const tips = this._state.tips.total;
    const penalties = this._state.penalties.total;
    this._state.money = { gold, tips, penalties, net: gold + tips - penalties, lastChange };
    this._state.score.value = this._state.money.net;
  }

  _applyPenalty(amount, reason, now, order = null) {
    const penalty = Math.max(0, Math.floor(amount));
    this._state.penalties.total += penalty;
    this._state.penalties.lastChange = -penalty;
    this._state.gold.lastChange = 0;
    this._state.tips.lastChange = 0;
    if (order) order.penalty = (order.penalty || 0) + penalty;
    this._syncMoney(-penalty);
    this._record("penalty", `${reason}: -${penalty}`, now, { amount: -penalty, orderId: order?.id || null, net: this._state.money.net });
  }

  _syncPlayer(player) {
    if (player.hasPlate) {
      player.plate = [...new Set(player.plate.map(plateComponent).filter(Boolean))];
      player.hand = null;
      player.heldItem = "PLATE";
      player.inventory = [...player.plate];
    } else {
      player.plate = [];
      player.heldItem = player.hand || "EMPTY";
      player.inventory = player.hand ? [player.hand] : [];
    }
  }

  _setPlayerLocation(player, stationId, now = this.now(), returnAt = now + this.locationHoldSeconds * 1000) {
    const labels = {
      center: "CENTER / DEFAULT",
      pantry: "PANTRY",
      fridge: "FRIDGE",
      "cutting-board": "CUTTING BOARD",
      "stove-left": "STOVE 1",
      "stove-right": "STOVE 2",
      serving: "SERVING",
    };
    const resolved = labels[stationId] ? stationId : "center";
    player.currentStation = resolved;
    player.simulatedLocation = {
      stationId: resolved,
      label: labels[resolved],
      source: "action-inference",
      sinceAt: iso(now),
      returnAt: resolved === "center" || returnAt == null ? null : iso(returnAt),
    };
  }

  _updatePlayerLocations(now) {
    let changed = false;
    for (const player of this._state.players) {
      const returnAt = player.simulatedLocation?.returnAt ? Date.parse(player.simulatedLocation.returnAt) : null;
      if (player.currentStation !== "center" && returnAt != null && now >= returnAt) {
        this._setPlayerLocation(player, "center", now, null);
        changed = true;
      }
    }
    return changed;
  }

  _clearPlayer(player, now = this.now()) {
    player.hand = null;
    player.hasPlate = false;
    player.plate = [];
    player.processing = null;
    player.lastCompletedChop = null;
    player.submissionReadyUntil = null;
    player.actionState = "idle";
    this._setPlayerLocation(player, "center", now, null);
    this._syncPlayer(player);
  }

  _clearStations() {
    this._state.stations = makeStations();
  }

  _updateChopping(now) {
    let changed = false;
    const station = this._state.stations.find((value) => value.id === "cutting-board");
    const chopping = this._state.players.find((player) => player.processing?.type === "chop");
    if (!chopping) {
      if (station.status !== "idle") {
        Object.assign(station, { status: "idle", progress: 0, remainingSeconds: 0, item: null });
        changed = true;
      }
      return changed;
    }
    const deadline = Date.parse(chopping.processing.deadlineAt);
    const started = Date.parse(chopping.processing.startedAt);
    const remainingMs = Math.max(0, deadline - now);
    const progress = Math.max(0, Math.min(1, (now - started) / (CHOP_SECONDS * 1000)));
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    if (station.status !== "chopping" || station.progress !== progress || station.remainingSeconds !== remainingSeconds) changed = true;
    Object.assign(station, { status: "chopping", progress, remainingSeconds, item: chopping.hand });
    if (now >= deadline) {
      const result = RAW_TO_CHOPPED[chopping.hand];
      if (result) chopping.hand = result;
      chopping.processing = null;
      chopping.lastCompletedChop = result ? { item: result, completedAt: iso(deadline), acknowledged: false } : null;
      chopping.actionState = result ? `holding ${result.toLowerCase()}` : "cut failed";
      this._setPlayerLocation(chopping, "cutting-board", now);
      this._syncPlayer(chopping);
      Object.assign(station, { status: "idle", progress: 0, remainingSeconds: 0, item: null });
      this._record("chop-complete", `${chopping.label} finished chopping`, now, { playerId: chopping.id, item: result || null });
      changed = true;
    }
    return changed;
  }

  _updateStoves(now) {
    let changed = false;
    for (const station of this._state.stations.filter((value) => value.kind === "stove" && value.startedAt)) {
      const started = Date.parse(station.startedAt);
      const elapsed = Math.max(0, (now - started) / 1000);
      let status;
      let item;
      let progress;
      let remainingSeconds;
      if (elapsed < COOK_SECONDS) {
        status = "cooking";
        item = "CHOPPED_MEAT";
        progress = Math.max(0, Math.min(1, elapsed / COOK_SECONDS));
        remainingSeconds = Math.ceil(COOK_SECONDS - elapsed);
      } else if (elapsed < COOK_SECONDS + DONE_SECONDS) {
        status = "done";
        item = "COOKED_MEAT";
        progress = 1;
        remainingSeconds = Math.ceil(COOK_SECONDS + DONE_SECONDS - elapsed);
      } else if (elapsed < COOK_SECONDS + DONE_SECONDS + WARNING_SECONDS) {
        status = "warning";
        item = "COOKED_MEAT";
        progress = 1;
        remainingSeconds = Math.ceil(COOK_SECONDS + DONE_SECONDS + WARNING_SECONDS - elapsed);
      } else {
        status = "burnt";
        item = "BURNT_MEAT";
        progress = 1;
        remainingSeconds = 0;
      }
      if (station.status !== status) {
        this._record("stove-state", `${station.label} is ${status}`, now, { stationId: station.id, status });
        changed = true;
      }
      if (station.item !== item || station.progress !== progress || station.remainingSeconds !== remainingSeconds) changed = true;
      Object.assign(station, { status, item, progress, remainingSeconds });
    }
    return changed;
  }

  _tick(now = this.now()) {
    if (this._state.timer.status !== "running" || this._roundStartedAt == null) return false;
    const remainingRound = Math.max(0, this._roundDurationSeconds - Math.floor((now - this._roundStartedAt) / 1000));
    let changed = remainingRound !== this._state.timer.remainingSeconds;
    this._state.timer.remainingSeconds = remainingRound;
    this._state.clock.remainingSeconds = remainingRound;
    changed = this._updateChopping(now) || changed;
    changed = this._updateStoves(now) || changed;
    changed = this._updatePlayerLocations(now) || changed;

    for (const player of this._state.players) {
      if (player.submissionReadyUntil && now > Date.parse(player.submissionReadyUntil)) {
        player.submissionReadyUntil = null;
        if (player.actionState === "ready to submit") player.actionState = "idle";
        changed = true;
      }
    }
    if (this._pendingSubmission && now > this._pendingSubmission.deadline) {
      this._record("rejected-submission", "Submission consensus window expired before all three players were ready", now, { playerId: this._pendingSubmission.playerId });
      const submitter = this._player(this._pendingSubmission.playerId);
      if (submitter) submitter.actionState = "submission consensus expired";
      this._pendingSubmission = null;
      changed = true;
    }

    if (remainingRound === 0) {
      for (const order of this._activeOrders()) {
        order.status = "cancelled";
        order.remainingSeconds = 0;
        order.patienceState = 0;
        Object.assign(order.patience, { remainingSeconds: 0, filledSegments: 0, state: 0 });
      }
      this._syncActiveOrder();
      this._roundStartedAt = null;
      this._state.timer.status = "ended";
      this._state.clock.status = "ended";
      this._state.setup.phase = "ended";
      this._state.setup.message = "Round timer reached zero. Round state was cleared; reset or start to play again.";
      this._state.burgerLevel.status = "ended";
      for (const player of this._state.players) this._clearPlayer(player, now);
      this._clearStations();
      this._pendingSubmission = null;
      this._record("round-ended", "Round timer reached zero", now);
      changed = true;
    } else {
      for (const order of this._activeOrders()) {
        const remaining = Math.max(0, Math.ceil((Date.parse(order.deadlineAt) - now) / 1000));
        const tier = patienceTier(remaining, order.totalSeconds);
        if (remaining !== order.remainingSeconds || tier !== order.patience.filledSegments) changed = true;
        order.remainingSeconds = remaining;
        order.patienceState = tier;
        Object.assign(order.patience, { remainingSeconds: remaining, filledSegments: tier, state: tier });
        if (remaining === 0) {
          order.status = "expired";
          this._applyPenalty(EXPIRED_ORDER_PENALTY, `${order.recipeName} expired`, now, order);
          this._record("order-expired", `${order.recipeName} expired`, now, { orderId: order.id, recipe: order.recipe });
          changed = true;
        }
      }
      const active = this._activeOrders();
      if (this._nextOrderAt == null) this._nextOrderAt = now + this._randomSeconds() * 1000;
      if (active.length === 0) {
        this._issueOrder(now);
        this._nextOrderAt = now + this._randomSeconds() * 1000;
        changed = true;
      } else if (now >= this._nextOrderAt) {
        if (active.length < this.maxActiveOrders) {
          this._issueOrder(now);
          changed = true;
        }
        this._nextOrderAt = now + this._randomSeconds() * 1000;
      }
      this._syncActiveOrder();
    }

    if (changed) {
      this._state.version += 1;
      this._emit(now);
    }
    return changed;
  }

  snapshot(now = this.now()) {
    this._tick(now);
    return clone(this._state);
  }

  registerBadge(mac, playerId) {
    const normalized = String(mac || "").toUpperCase();
    const player = this._state.players.find((candidate) => candidate.id === playerId || candidate.id === `p${playerId}` || String(candidate.id) === String(playerId));
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(normalized) || !player) return false;
    const previous = this._badges.get(normalized);
    if (previous && previous !== player.id) {
      const previousPlayer = this._state.players.find((candidate) => candidate.id === previous);
      if (previousPlayer) previousPlayer.badgeMac = null;
    }
    if (player.badgeMac && player.badgeMac !== normalized) this._badges.delete(player.badgeMac);
    this._badges.set(normalized, player.id);
    player.badgeMac = normalized;
    return true;
  }

  assignNextBadge(mac) {
    const normalized = String(mac || "").toUpperCase();
    const existing = this._badges.get(normalized);
    if (existing) return existing;
    const unassigned = this._state.players.find((player) => !player.badgeMac);
    if (!unassigned || !this.registerBadge(normalized, unassigned.id)) return null;
    return unassigned.id;
  }

  setPhotos(photos, now = this.now()) {
    this._state.photos = photos.map(({ absolutePath, ...photo }) => ({ ...photo }));
    this._touch(now);
  }

  async proposeFloorplan({ photos = [], readPhoto } = {}, now = this.now()) {
    const result = await this.provider.propose({ photos, readPhoto });
    this._state.floorPlan = clone(result);
    this._state.floorPlan.accepted = false;
    this._state.burgerLevel = { status: "not-generated", recipe: "BURGER", placementInstructions: clone(result.placementInstructions) };
    this._state.setup.phase = "layout-proposed";
    this._state.setup.message = result.reviewMessage || "Review the proposed floorplan before approving it.";
    this._state.health.inference = { id: "inference", label: "SETUP INFERENCE", status: result.mode === "ai" ? "healthy" : "degraded", lastSeenAt: iso(now), detail: this._state.setup.message };
    this._touch(now);
    return this.snapshot(now);
  }

  approveFloorplan(approved = true, now = this.now()) {
    if (!approved) return this.snapshot(now);
    if (this._state.setup.phase !== "layout-proposed") throw new Error("a proposed floorplan is required before approval");
    this._state.floorPlan.accepted = true;
    this._state.setup.phase = "burger-placement";
    this._state.setup.message = "Floorplan approved. Place the four burger stations as instructed, then start the round.";
    this._state.burgerLevel = { status: "placement-ready", recipe: "BURGER", placementInstructions: clone(this._state.floorPlan.placementInstructions) };
    this._touch(now);
    return this.snapshot(now);
  }

  _resetEconomy() {
    this._state.gold = { total: 0, earned: 0, lastChange: 0 };
    this._state.tips = { total: 0, earned: 0, lastChange: 0 };
    this._state.penalties = { total: 0, lastChange: 0 };
    this._state.money = makeMoney();
    this._state.score = { value: 0, delivered: 0 };
  }

  _startRound(now, { durationSeconds = this.roundSeconds, allowUnapproved = false, startSource = "development simulator" } = {}) {
    if (this._state.floorPlan.accepted !== true) {
      if (!allowUnapproved) throw new Error("approve the floorplan before starting the game");
      this._state.floorPlan.accepted = true;
      this._state.floorPlan.reviewMessage = "Local simulator fixture accepted by the host START record.";
    }
    this._roundDurationSeconds = clampInteger(durationSeconds, 1, 3600, this.roundSeconds);
    this._roundStartedAt = now;
    this._state.setup.phase = "running";
    this._state.setup.message = startSource === "physical host badge"
      ? "Burger game running from the physical host badge START event. The server owns orders, timers, stations, validation, and money."
      : "Development simulator round running. The server owns orders, timers, stations, validation, and money.";
    this._state.timer = { status: "running", remainingSeconds: this._roundDurationSeconds, totalSeconds: this._roundDurationSeconds };
    this._state.clock = { ...this._state.timer };
    this._state.burgerLevel.status = "in-play";
    this._state.orders = [];
    this._state.activeOrders = [];
    this._state.order = null;
    this._state.submissions = [];
    this._state.eventHistory = [];
    this._historySequence = 0;
    this._state.serving.lastEvent = null;
    this._resetEconomy();
    this._clearStations();
    for (const player of this._state.players) this._clearPlayer(player, now);
    this._orderSequence = 0;
    this._nextOrderAt = null;
    this._pendingTransfer = null;
    this._pendingSubmission = null;
    this._seenEvents.clear();
    this._record("round-started", `Round started for ${this._roundDurationSeconds} seconds`, now, { durationSeconds: this._roundDurationSeconds, playerCount: 3, startSource });
    this._issueOrder(now);
    this._nextOrderAt = now + this._randomSeconds() * 1000;
    this._publish(now);
    return this.snapshot(now);
  }

  resetGame(now = this.now()) {
    this._roundStartedAt = null;
    this._roundDurationSeconds = this.roundSeconds;
    for (const player of this._state.players) this._clearPlayer(player, now);
    this._clearStations();
    this._state.orders = [];
    this._state.activeOrders = [];
    this._state.order = null;
    this._state.submissions = [];
    this._state.serving.lastEvent = null;
    this._resetEconomy();
    this._state.timer = { status: "ready", remainingSeconds: this.roundSeconds, totalSeconds: this.roundSeconds };
    this._state.clock = { ...this._state.timer };
    this._state.setup.phase = this._state.floorPlan.accepted ? "burger-placement" : "idle";
    this._state.setup.message = "Round reset. Send a host START record when the three fixed players are ready.";
    this._state.burgerLevel.status = this._state.floorPlan.accepted ? "placement-ready" : "not-generated";
    this._state.eventHistory = [];
    this._historySequence = 0;
    this._record("round-reset", "Round state reset", now);
    this._nextOrderAt = null;
    this._pendingTransfer = null;
    this._pendingSubmission = null;
    this._seenEvents.clear();
    this._publish(now);
    return this.snapshot(now);
  }

  command(type, payload = {}, now = this.now()) {
    switch (String(type || payload?.type || "")) {
      case "START_HOST":
        this._state.setup.phase = "scanning";
        this._state.setup.message = "Host started. Upload or review room photos for a proposed floorplan.";
        this._state.floorPlan.accepted = false;
        this._state.burgerLevel.status = "not-generated";
        this._touch(now);
        return this.snapshot(now);
      case "SCAN_ROOM":
        this._state.setup.phase = "scanning";
        this._state.setup.message = "Room scan requested. POST /api/floorplan/review to generate the proposal.";
        this._touch(now);
        return this.snapshot(now);
      case "APPROVE_LAYOUT":
      case "ACCEPT_LAYOUT":
        return this.approveFloorplan(true, now);
      case "START_GAME":
        if (this._state.floorPlan.accepted !== true) throw new Error("approve the floorplan before preparing the game");
        if (this._state.timer.status === "running") throw new Error("round is already running from a host lifecycle event");
        this._state.setup.phase = "waiting-for-host-start";
        this._state.setup.message = "Setup is ready. Press START on the physical host badge; the native GAME START record begins the production round.";
        this._state.burgerLevel.status = "placement-ready";
        this._touch(now);
        return this.snapshot(now);
      case "END_GAME":
        this.endGame(now);
        return this.snapshot(now);
      case "RESET_GAME":
        return this.resetGame(now);
      default:
        throw new Error(`unsupported command: ${type}`);
    }
  }

  ingestHostControl(record, now = this.now()) {
    if (record.control === "START") {
      const physicalHost = record.framing === "legacy-game";
      const state = this._startRound(now, {
        durationSeconds: record.durationSeconds || this.roundSeconds,
        allowUnapproved: true,
        startSource: physicalHost ? "physical host badge" : "development simulator",
      });
      return { accepted: true, detail: physicalHost ? "physical host started round" : "development simulator started round", stateVersion: state.version };
    }
    if (record.control === "END") {
      this.endGame(now);
      return { accepted: true, detail: "host ended round", stateVersion: this._state.version };
    }
    if (record.control === "RESET") {
      const state = this.resetGame(now);
      return { accepted: true, detail: "host reset round", stateVersion: state.version };
    }
    return { accepted: false, detail: "unsupported host control" };
  }

  endGame(now = this.now()) {
    for (const order of this._activeOrders()) {
      order.status = "cancelled";
      order.remainingSeconds = 0;
      order.patienceState = 0;
      Object.assign(order.patience, { remainingSeconds: 0, filledSegments: 0, state: 0 });
    }
    this._syncActiveOrder();
    this._roundStartedAt = null;
    this._state.setup.phase = "ended";
    this._state.setup.message = "Game ended by the host. Round state was cleared.";
    this._state.timer.status = "ended";
    this._state.timer.remainingSeconds = 0;
    this._state.clock = { ...this._state.timer };
    this._state.burgerLevel.status = "ended";
    for (const player of this._state.players) this._clearPlayer(player, now);
    this._clearStations();
    this._pendingSubmission = null;
    this._record("round-ended", "Host ended the round", now);
    this._publish(now);
  }

  _player(playerId) {
    return this._state.players.find((candidate) => candidate.id === playerId || candidate.id === `p${playerId}`) || null;
  }

  _playerForIntent(intent) {
    if (intent.type === "H") return null;
    const mac = String(intent.senderMac || "").toUpperCase();
    const known = this._badges.get(mac);
    if (known) return this._player(known);
    const assigned = this.assignNextBadge(mac);
    return assigned ? this._player(assigned) : null;
  }

  _setPlate(player, summary, now) {
    if (summary === "NEW") {
      const component = plateComponent(player.hand);
      if (player.hand && !component) return { accepted: false, detail: "held item cannot be plated" };
      player.hasPlate = true;
      player.plate = component ? [component] : [];
      player.hand = null;
    } else {
      const items = itemsFromPlateSummary(summary);
      if (!items) return { accepted: false, detail: "invalid plate summary" };
      player.hasPlate = true;
      player.plate = items;
      player.hand = null;
    }
    player.processing = null;
    player.actionState = `holding plate ${plateSummary(player.plate)}`;
    this._setPlayerLocation(player, "pantry", now);
    this._syncPlayer(player);
    return { accepted: true, detail: `${player.id} plate is ${plateSummary(player.plate)}` };
  }

  _pickup(player, item, now) {
    const normalized = String(item || "").toUpperCase();
    if (player.processing) return { accepted: false, detail: "player is busy chopping" };
    if (player.hasPlate) {
      const component = plateComponent(normalized);
      if (!component || !PLATE_ITEMS.has(normalized)) return { accepted: false, detail: "raw or non-platable item cannot be added to a plate" };
      if (player.plate.includes(component)) return { accepted: false, detail: "plate cannot contain duplicate items" };
      player.plate.push(component);
      player.actionState = `added ${component.toLowerCase()} to plate`;
      const stationId = ["BUN", "RAW_LETTUCE", "LETTUCE"].includes(normalized) ? "pantry"
        : ["RAW_MEAT", "RAW_CHEESE", "CHEESE", "MEAT"].includes(normalized) ? "fridge" : "center";
      this._setPlayerLocation(player, stationId, now);
      this._syncPlayer(player);
      return { accepted: true, detail: `${component} added to ${player.id} plate` };
    }
    if (player.hand) return { accepted: false, detail: "player hand is not empty" };
    player.hand = normalized;
    player.actionState = `holding ${normalized.toLowerCase()}`;
    const stationId = ["BUN", "RAW_LETTUCE", "LETTUCE"].includes(normalized) ? "pantry"
      : ["RAW_MEAT", "RAW_CHEESE", "CHEESE", "MEAT"].includes(normalized) ? "fridge"
        : ["CHOPPED_MEAT", "COOKED_MEAT", "BURNT_MEAT"].includes(normalized) ? "stove-left" : "center";
    this._setPlayerLocation(player, stationId, now);
    this._syncPlayer(player);
    return { accepted: true, detail: `${player.id} picked up ${normalized}` };
  }

  _chop(player, phase, item, now) {
    const station = this._state.stations.find((value) => value.id === "cutting-board");
    if (phase === "START") {
      if (!RAW_TO_CHOPPED[player.hand]) return { accepted: false, detail: "raw meat, lettuce, or cheese is required to chop" };
      if (this._state.players.some((candidate) => candidate !== player && candidate.processing?.type === "chop")) return { accepted: false, detail: "cutting board is busy" };
      player.processing = { type: "chop", item: player.hand, startedAt: iso(now), deadlineAt: iso(now + CHOP_SECONDS * 1000) };
      player.lastCompletedChop = null;
      player.actionState = "chopping";
      this._setPlayerLocation(player, "cutting-board", now, now + (CHOP_SECONDS + this.locationHoldSeconds) * 1000);
      Object.assign(station, { status: "chopping", progress: 0, remainingSeconds: CHOP_SECONDS, item: player.hand });
      return { accepted: true, detail: `${player.id} started chopping` };
    }
    if (phase === "FAIL") {
      if (!player.processing || player.processing.type !== "chop") return { accepted: false, detail: "player is not chopping" };
      player.processing = null;
      player.actionState = `holding ${String(player.hand).toLowerCase()}`;
      this._setPlayerLocation(player, "cutting-board", now);
      Object.assign(station, { status: "idle", progress: 0, remainingSeconds: 0, item: null });
      return { accepted: true, detail: `${player.id} chop failed and progress was lost` };
    }
    if (phase === "DONE") {
      if (!player.processing || player.processing.type !== "chop") {
        const reported = SHORT_ITEMS[item] || item || player.lastCompletedChop?.item;
        if (player.lastCompletedChop && !player.lastCompletedChop.acknowledged
          && player.hand === player.lastCompletedChop.item && reported === player.lastCompletedChop.item) {
          player.lastCompletedChop.acknowledged = true;
          player.actionState = `holding ${reported.toLowerCase()}; chop complete`;
          this._setPlayerLocation(player, "cutting-board", now);
          return { accepted: true, detail: `${player.id} confirmed completed chop ${reported}` };
        }
        return { accepted: false, detail: "player is not chopping" };
      }
      const deadline = Date.parse(player.processing.deadlineAt);
      if (now < deadline) return { accepted: false, detail: "chop completion reported before the server deadline" };
      const result = RAW_TO_CHOPPED[player.hand];
      const reported = SHORT_ITEMS[item] || item || result;
      if (!result || reported !== result) return { accepted: false, detail: "reported chopped item does not match the active server item" };
      player.hand = result;
      player.processing = null;
      player.actionState = `holding ${result.toLowerCase()}`;
      this._setPlayerLocation(player, "cutting-board", now);
      this._syncPlayer(player);
      Object.assign(station, { status: "idle", progress: 0, remainingSeconds: 0, item: null });
      return { accepted: true, detail: `${player.id} finished chopping ${result}` };
    }
    return { accepted: false, detail: "unknown chop phase" };
  }

  _stove(player, side, operation, now) {
    const station = this._state.stations.find((value) => value.id === `stove-${String(side).toLowerCase()}`);
    if (!station) return { accepted: false, detail: "unknown stove side" };
    this._setPlayerLocation(player, station.id, now);
    this._updateStoves(now);
    if (operation === "CHECK" || operation === "STATUS") {
      player.actionState = `checked ${station.label.toLowerCase()}: ${station.status}`;
      return { accepted: true, detail: `${station.label} is ${station.status}` };
    }
    if (operation === "PLACE") {
      if (station.status !== "idle" || station.item) return { accepted: false, detail: `${station.label} is not empty` };
      if (player.hand !== "CHOPPED_MEAT" && player.hand !== "MEAT") return { accepted: false, detail: "chopped raw meat is required" };
      player.hand = null;
      player.actionState = `cooking on ${station.label.toLowerCase()}`;
      this._syncPlayer(player);
      Object.assign(station, {
        status: "cooking", item: "CHOPPED_MEAT", progress: 0, remainingSeconds: COOK_SECONDS,
        startedAt: iso(now), doneAt: iso(now + COOK_SECONDS * 1000),
        warningAt: iso(now + (COOK_SECONDS + DONE_SECONDS) * 1000),
        burntAt: iso(now + (COOK_SECONDS + DONE_SECONDS + WARNING_SECONDS) * 1000),
      });
      return { accepted: true, detail: `${player.id} placed meat on ${station.label}` };
    }
    if (operation === "TAKE") {
      if (!["done", "warning", "burnt"].includes(station.status)) return { accepted: false, detail: `${station.label} food is not ready` };
      const taken = station.status === "burnt" ? "BURNT_MEAT" : "COOKED_MEAT";
      if (player.hasPlate) {
        if (taken === "BURNT_MEAT") return { accepted: false, detail: "burnt meat cannot be plated" };
        if (player.plate.includes("MEAT")) return { accepted: false, detail: "plate already contains meat" };
        player.plate.push("MEAT");
      } else if (player.hand) {
        return { accepted: false, detail: "player hand is not empty" };
      } else {
        player.hand = taken;
      }
      player.actionState = `took ${taken.toLowerCase()} from ${station.label.toLowerCase()}`;
      this._syncPlayer(player);
      Object.assign(station, { status: "idle", progress: 0, remainingSeconds: 0, item: null, startedAt: null, doneAt: null, warningAt: null, burntAt: null });
      return { accepted: true, detail: `${player.id} took ${taken} from ${station.label}` };
    }
    return { accepted: false, detail: "unknown stove operation" };
  }

  _transfer(first, second, now = this.now()) {
    if (!first || !second || first === second) return { accepted: false, detail: "transfer requires two different players" };
    if (first.hasPlate && second.hasPlate) {
      [first.plate, second.plate] = [second.plate, first.plate];
    } else if (!first.hasPlate && !second.hasPlate) {
      [first.hand, second.hand] = [second.hand, first.hand];
    } else {
      const platePlayer = first.hasPlate ? first : second;
      const handPlayer = first.hasPlate ? second : first;
      const component = plateComponent(handPlayer.hand);
      if (component && PLATE_ITEMS.has(handPlayer.hand) && !platePlayer.plate.includes(component)) {
        platePlayer.plate.push(component);
        handPlayer.hand = null;
      } else {
        const oldPlate = [...platePlayer.plate];
        const oldHand = handPlayer.hand;
        platePlayer.hasPlate = false;
        platePlayer.plate = [];
        platePlayer.hand = oldHand;
        handPlayer.hasPlate = true;
        handPlayer.plate = oldPlate;
        handPlayer.hand = null;
      }
    }
    first.actionState = `transferred with ${second.label}`;
    second.actionState = `transferred with ${first.label}`;
    this._setPlayerLocation(first, "center", now, null);
    this._setPlayerLocation(second, "center", now, null);
    this._syncPlayer(first);
    this._syncPlayer(second);
    return { accepted: true, detail: `${first.id} and ${second.id} transferred held state` };
  }

  _applyPlayerAction(player, action, now) {
    switch (action.action) {
      case "PICKUP": return this._pickup(player, action.item, now);
      case "PLATE": return this._setPlate(player, action.plate, now);
      case "CHOP": return this._chop(player, action.phase, action.item, now);
      case "STOVE": return this._stove(player, action.side, action.operation, now);
      case "DROP":
        this._clearPlayer(player, now);
        player.actionState = "dropped held state";
        return { accepted: true, detail: `${player.id} dropped held state` };
      case "TRANSFER": return this._transfer(player, this._player(action.targetPlayerId), now);
      case "TRANSFER_READY": {
        if (this._pendingTransfer && this._pendingTransfer.playerId !== player.id && now - this._pendingTransfer.at <= 800) {
          const other = this._player(this._pendingTransfer.playerId);
          this._pendingTransfer = null;
          return this._transfer(other, player, now);
        }
        this._pendingTransfer = { playerId: player.id, at: now };
        player.actionState = "ready to transfer";
        return { accepted: true, detail: `${player.id} is ready to transfer` };
      }
      case "READY":
        player.submissionReadyUntil = iso(now + 500);
        player.actionState = "ready to submit";
        return { accepted: true, detail: `${player.id} ready for submission` };
      case "LEAVE":
        if (player.currentStation !== "center") this._setPlayerLocation(player, player.currentStation, now);
        player.actionState = "leaving station";
        return { accepted: true, detail: `${player.id} leaving station` };
      case "AT_STATION": {
        const value = String(action.station || "").toUpperCase();
        const stationId = value.includes("PANTRY") ? "pantry" : value.includes("FRIDGE") ? "fridge"
          : value.includes("CHOP") || value.includes("CUTTING") ? "cutting-board"
            : value.includes("RIGHT") || value.endsWith("2") ? "stove-right"
              : value.includes("STOVE") ? "stove-left" : value.includes("SERV") ? "serving" : "center";
        this._setPlayerLocation(player, stationId, now);
        player.actionState = `at ${String(action.station).toLowerCase()}`;
        return { accepted: true, detail: `${player.id} at ${action.station}` };
      }
      default: return { accepted: false, detail: "unsupported player action" };
    }
  }

  ingestPlayerAction(action, now = this.now()) {
    this._tick(now);
    const player = this._player(action.playerId);
    if (!player) return { accepted: false, detail: "unknown fixed player" };
    if (this._state.timer.status !== "running") {
      this._record("ignored-action", `${player.id} action ignored while round is not running`, now, { playerId: player.id, action: action.action });
      this._publish(now);
      return { accepted: false, ignored: true, detail: "player action ignored before game start", stateVersion: this._state.version };
    }
    const result = this._applyPlayerAction(player, action, now);
    if (result.accepted && action.action === "READY" && this._pendingSubmission) {
      const pending = this._pendingSubmission;
      const allReady = this._state.players.every((candidate) => {
        const readyUntil = candidate.submissionReadyUntil ? Date.parse(candidate.submissionReadyUntil) : 0;
        return readyUntil >= now;
      });
      if (allReady && now <= pending.deadline) {
        const completion = this._completeSubmission(this._player(pending.playerId), pending.value, pending.submittedItems, now);
        result.submissionResult = completion;
        if (!completion.accepted) this._record("rejected-submission", completion.detail, now, { playerId: pending.playerId });
      }
    }
    this._record(result.accepted ? "player-action" : "rejected-action", result.detail, now, { playerId: player.id, action: action.action });
    this._state.health.gateway = { ...this._state.health.gateway, status: "healthy", lastSeenAt: iso(now), detail: "Host badge / serial diagnostic online" };
    this._publish(now);
    return { ...result, stateVersion: this._state.version };
  }

  submit(player, value, now = this.now()) {
    this._tick(now);
    if (this._state.timer.status !== "running") return { accepted: false, ignored: true, detail: "submission ignored while round is not running" };
    if (!player) return { accepted: false, detail: "unknown fixed player" };
    if (this._pendingSubmission) {
      return { accepted: false, detail: `submission already pending from ${this._pendingSubmission.playerId}` };
    }
    player.submissionReadyUntil = iso(now + 500);
    if (!player.hasPlate) return { accepted: false, detail: "submitter does not hold an authoritative server plate" };
    const submittedItems = [...player.plate];
    player.hand = null;
    player.hasPlate = false;
    player.plate = [];
    player.processing = null;
    player.lastCompletedChop = null;
    player.actionState = "submission pending";
    this._setPlayerLocation(player, "serving", now);
    this._syncPlayer(player);

    const raw = String(value || "").toUpperCase();
    const claimed = raw.replace(/^SUBMIT[:=]/, "").replace(/^RECIPE[:=]/, "").split(/[|,;]/)[0];
    const summaryItems = itemsFromPlateSummary(claimed);
    const claimedRecipe = RECIPE_BY_ID.get(claimed) || null;
    const claimMatchesPlate = (summaryItems && sameComponents(summaryItems, submittedItems))
      || (claimedRecipe && sameComponents(claimedRecipe.components, submittedItems));
    if (!claimMatchesPlate) {
      for (const candidate of this._state.players) candidate.submissionReadyUntil = null;
      player.actionState = "submission assertion rejected; plate consumed";
      return { accepted: false, detail: "submitted plate assertion does not match the consumed authoritative server plate" };
    }

    const missingReady = this._state.players.filter((candidate) => {
      const readyUntil = candidate.submissionReadyUntil ? Date.parse(candidate.submissionReadyUntil) : 0;
      return readyUntil < now;
    });
    if (missingReady.length) {
      this._pendingSubmission = { playerId: player.id, value, submittedItems, deadline: now + 500 };
      return { accepted: true, pending: true, detail: `submission waiting for ${missingReady.map((candidate) => candidate.label).join(", ")} within the 0.5-second window` };
    }
    return this._completeSubmission(player, value, submittedItems, now);
  }

  _completeSubmission(player, value, submittedItems, now = this.now()) {
    if (!player) return { accepted: false, detail: "unknown fixed player" };
    const raw = String(value || "").toUpperCase();
    const claimed = raw.replace(/^SUBMIT[:=]/, "").replace(/^RECIPE[:=]/, "").split(/[|,;]/)[0];
    const summaryItems = itemsFromPlateSummary(claimed);
    const claimedRecipe = RECIPE_BY_ID.get(claimed) || null;
    this._pendingSubmission = null;

    if (this.authoritativeEngine?.submit) {
      const result = this.authoritativeEngine.submit({ playerId: player.id, value: plateSummary(submittedItems), now });
      if (result?.state) this.applyAuthoritativeSnapshot(result.state, now);
      return { accepted: result?.accepted !== false, submission: result?.submission || result, detail: result?.detail || "authoritative engine processed submission" };
    }

    const active = this._activeOrders();
    const current = active[0] || null;
    let target = null;
    if (claimedRecipe) target = active.find((order) => order.recipe === claimedRecipe.id) || null;
    else if (summaryItems) target = active.find((order) => sameComponents(order.components, submittedItems)) || null;
    const success = this._state.timer.status === "running" && Boolean(target)
      && sameComponents(target.components, submittedItems);
    const recipe = target ? RECIPE_BY_ID.get(target.recipe) : claimedRecipe;
    const tier = target?.patience?.filledSegments || 0;
    const gold = success ? recipe.gold : 0;
    const tipRate = tier === 3 ? 0.2 : tier === 2 ? 0.1 : tier === 1 ? 0.05 : 0;
    const tip = success ? Math.max(1, Math.round(gold * tipRate)) : 0;
    const expiredMatch = !target && this._state.orders.find((order) => order.status === "expired" && sameComponents(order.components, submittedItems));
    const event = {
      id: `submission-${this._state.submissions.length + 1}`,
      playerId: player?.id || null,
      status: success ? "success" : "failure",
      message: success ? "BURGER SERVED" : expiredMatch ? "ORDER EXPIRED" : "WRONG BURGER",
      recipe: recipe?.id || claimed || null,
      submittedPlate: plateSummary(submittedItems),
      expectedRecipe: current?.recipe || null,
      gold,
      tip,
      penalty: success ? 0 : WRONG_ORDER_PENALTY,
      at: iso(now),
      raw: value,
      validation: success ? "server plate and active-order match" : expiredMatch ? "matching order had already expired" : "plate did not match an active order",
    };
    this._state.submissions.push(event);
    while (this._state.submissions.length > 32) this._state.submissions.shift();
    this._state.serving.lastEvent = event;
    if (success) {
      target.status = "completed";
      target.remainingSeconds = 0;
      target.patienceState = 0;
      Object.assign(target.patience, { remainingSeconds: 0, filledSegments: 0, state: 0 });
      this._state.gold.total += gold;
      this._state.gold.earned += gold;
      this._state.gold.lastChange = gold;
      this._state.tips.total += tip;
      this._state.tips.earned += tip;
      this._state.tips.lastChange = tip;
      this._state.penalties.lastChange = 0;
      this._state.score.delivered += 1;
      this._syncMoney(gold + tip);
      this._record("submission-success", `${recipe.name} served for ${gold} gold and ${tip} tip`, now, { submissionId: event.id, playerId: player?.id || null, orderId: target.id });
      this._syncActiveOrder();
      if (this._activeOrders().length === 0) {
        this._issueOrder(now);
        this._nextOrderAt = now + this._randomSeconds() * 1000;
      }
    } else {
      this._applyPenalty(WRONG_ORDER_PENALTY, event.message, now, expiredMatch || current);
      this._record("submission-failure", event.message, now, { submissionId: event.id, playerId: player?.id || null, submittedPlate: event.submittedPlate });
    }
    for (const candidate of this._state.players) {
      this._clearPlayer(candidate, now);
      candidate.actionState = candidate === player
        ? (success ? "order served" : "submission rejected")
        : "submission team cleared";
    }
    this._setPlayerLocation(player, "serving", now);
    return { accepted: true, submission: event, detail: event.message };
  }

  ingestSubmission(record, now = this.now()) {
    this._tick(now);
    if (this._state.timer.status !== "running") {
      this._record("ignored-submission", "Submission ignored while round is not running", now, { playerId: record.playerId });
      this._publish(now);
      return { accepted: false, ignored: true, detail: "submission ignored before game start", stateVersion: this._state.version };
    }
    const result = this.submit(this._player(record.playerId), record.plate, now);
    if (!result.accepted) {
      this._record("rejected-submission", result.detail, now, { playerId: record.playerId });
    } else if (result.pending) {
      this._record("submission-pending", result.detail, now, { playerId: record.playerId });
    }
    this._publish(now);
    return { ...result, stateVersion: this._state.version };
  }

  _legacyPlayerEvent(intent, now) {
    const match = String(intent.value || "").match(/^P([1-3]):(.+)$/);
    if (!match) return { accepted: false, detail: "invalid fixed-player event" };
    const playerId = `p${match[1]}`;
    const player = this._player(playerId);
    if (player && intent.senderMac) {
      const senderMac = String(intent.senderMac).toUpperCase();
      const mappedPlayerId = this._badges.get(senderMac);
      if ((mappedPlayerId && mappedPlayerId !== playerId) || (player.badgeMac && player.badgeMac !== senderMac)) {
        return { accepted: false, detail: `${playerId} is already assigned to another badge` };
      }
      if (!mappedPlayerId) this.registerBadge(senderMac, playerId);
    }
    const action = match[2];
    let translated = null;
    let submission = null;
    let item;
    if ((item = action.match(/^PU:([BRMXQLKC])$/))) translated = { playerId, action: "PICKUP", item: SHORT_ITEMS[item[1]] };
    else if (/^PL:(NEW|(?:B|-)(?:M|-)(?:L|-)(?:C|-))$/.test(action)) translated = { playerId, action: "PLATE", plate: action.slice(3) };
    else if (action === "CH:S") translated = { playerId, action: "CHOP", phase: "START" };
    else if (action === "CH:F") translated = { playerId, action: "CHOP", phase: "FAIL" };
    else if ((item = action.match(/^CH:D:([MLC])$/))) translated = { playerId, action: "CHOP", phase: "DONE", item: item[1] };
    else if ((item = action.match(/^ST:([LR]):([PTX])$/))) translated = { playerId, action: "STOVE", side: item[1] === "L" ? "LEFT" : "RIGHT", operation: item[2] === "P" ? "PLACE" : "TAKE" };
    else if ((item = action.match(/^ST:([LR]):C:(EMPTY|COOKING|DONE|WARNING|BURNT)$/))) translated = { playerId, action: "STOVE", side: item[1] === "L" ? "LEFT" : "RIGHT", operation: "STATUS", reportedStatus: item[2] };
    else if (/^DROP:(?:P(?:B|-)(?:M|-)(?:L|-)(?:C|-)|H[BRMXQLKC]|E----)$/.test(action)) translated = { playerId, action: "DROP" };
    else if (/^X:(?:P(?:B|-)(?:M|-)(?:L|-)(?:C|-)|H[BRMXQLKC]|E----)$/.test(action)) translated = { playerId, action: "TRANSFER_READY" };
    else if (action === "READY") translated = { playerId, action: "READY" };
    else if ((item = action.match(/^SUB:((?:B|-)(?:M|-)(?:L|-)(?:C|-))$/))) submission = { playerId, plate: item[1] };
    if (submission) return this.ingestSubmission(submission, now);
    if (!translated) return { accepted: false, detail: "unsupported fixed-player event" };
    return this.ingestPlayerAction(translated, now);
  }

  ingestBadgeEvent(intent, now = this.now()) {
    this._tick(now);
    const sequenceKey = `${String(intent.senderMac || "").toUpperCase()}#${intent.sequence}`;
    if (this._seenEvents.has(sequenceKey)) return { accepted: false, duplicate: true, detail: "duplicate badge sequence ignored" };
    const value = String(intent.value || "");
    const isHostControl = intent.type === "H" && /^(START|END|RESET)$/.test(value);
    if (!isHostControl && this._state.timer.status !== "running") {
      this._state.health.gateway = { ...this._state.health.gateway, status: "healthy", lastSeenAt: iso(now), detail: "Host badge / USB online" };
      this._record("ignored-action", "Badge event ignored before game start", now, { badgeType: intent.type, value });
      this._touch(now);
      return { accepted: false, duplicate: false, ignored: true, detail: "badge event ignored before game start", stateVersion: this._state.version };
    }
    if (this.authoritativeEngine?.ingestBadgeEvent) {
      const result = this.authoritativeEngine.ingestBadgeEvent(intent, now);
      if (result?.state) this.applyAuthoritativeSnapshot(result.state, now);
      return result;
    }

    let result;
    if (intent.type === "H" && value === "START") result = this.ingestHostControl({ control: "START", durationSeconds: this.roundSeconds }, now);
    else if (intent.type === "H" && value === "END") result = this.ingestHostControl({ control: "END" }, now);
    else if (intent.type === "H" && value === "RESET") result = this.ingestHostControl({ control: "RESET" }, now);
    else if (intent.type === "E") result = this._legacyPlayerEvent(intent, now);
    else {
      const player = this._playerForIntent(intent);
      if (intent.type === "B" && /^SUBMIT[:=]/i.test(value)) {
        result = player
          ? this.ingestSubmission({ playerId: player.id, plate: value.replace(/^SUBMIT[:=]/i, "") }, now)
          : { accepted: false, detail: "legacy submission sender is not assigned to a fixed player" };
      }
      else if (intent.type === "B" && /^TIP[:=]/i.test(value)) {
        this._record("legacy-tip-ignored", "Legacy client tip ignored; tips are calculated by successful server submissions", now, { playerId: player?.id || null, claimedTip: numeric(value.split(/[:=]/)[1]) });
        this._publish(now);
        result = { accepted: false, ignored: true, detail: "legacy client tip ignored", stateVersion: this._state.version };
      } else if (player && intent.type === "M" && value === "CHOP") result = this.ingestPlayerAction({ playerId: player.id, action: "CHOP", phase: "START" }, now);
      else if (player && intent.type === "N" && value.startsWith("STN:")) result = this.ingestPlayerAction({ playerId: player.id, action: "AT_STATION", station: value.slice(4) }, now);
      else if (player && intent.type === "N") result = this.ingestPlayerAction({ playerId: player.id, action: "PICKUP", item: value.replace(/^ING:/, "").replace(/^ITEM:/, "").toUpperCase() }, now);
      else result = { accepted: false, detail: "unsupported legacy badge intent" };
    }

    this._seenEvents.add(sequenceKey);
    while (this._seenEvents.size > 512) this._seenEvents.delete(this._seenEvents.values().next().value);
    return { duplicate: false, ...result };
  }

  ingestGatewayStatus(status, now = this.now()) {
    this._state.health.gateway = {
      ...this._state.health.gateway,
      status: status.up ? "healthy" : "offline",
      lastSeenAt: iso(now),
      packetCount: status.packetCount,
      droppedCount: status.droppedCount,
      detail: status.up ? "Host badge / USB online" : "Gateway reported down",
    };
    this._record("gateway-status", status.up ? "Gateway is up" : "Gateway is down", now, { packetCount: status.packetCount, droppedCount: status.droppedCount });
    this._touch(now);
    return { accepted: true, detail: status.up ? "gateway healthy" : "gateway reported down", stateVersion: this._state.version };
  }
}

export const GAME_TIMINGS = Object.freeze({
  chopSeconds: CHOP_SECONDS,
  cookSeconds: COOK_SECONDS,
  doneSeconds: DONE_SECONDS,
  warningSeconds: WARNING_SECONDS,
});
export const MONEY_RULES = Object.freeze({ wrongOrderPenalty: WRONG_ORDER_PENALTY, expiredOrderPenalty: EXPIRED_ORDER_PENALTY });
export { plateSummary, itemsFromPlateSummary, patienceTier };
