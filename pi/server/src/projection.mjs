import { LocalFloorplanProvider, localPlan } from "./provider.mjs";

const ROUND_SECONDS = 120;
const DEFAULT_ORDER_INTERVAL_SECONDS = 30;
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

function clone(value) { return structuredClone(value); }
function iso(ms) { return new Date(ms).toISOString(); }
function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function makeOrder(id = "order-1", recipe = BURGER_RECIPES[0], now = Date.now(), patienceSeconds = DEFAULT_ORDER_INTERVAL_SECONDS) {
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
    patience: { segments: 3, filledSegments: 3, remainingSeconds: patienceSeconds, totalSeconds: patienceSeconds },
    toppings: [...recipe.toppings],
    components: [...recipe.components],
    goldValue: recipe.gold,
  };
}

export function createInitialProjectionState(now = Date.now()) {
  const plan = localPlan({ generatedAt: iso(now), photoCount: 0 });
  return {
    version: 1,
    source: "pi-server",
    setup: { phase: "idle", message: "Upload 3-4 room photos, then review the proposed floorplan.", updatedAt: iso(now) },
    floorPlan: plan,
    burgerLevel: { status: "not-generated", recipe: "BURGER", placementInstructions: clone(plan.placementInstructions) },
    photos: [],
    players: DEFAULT_PLAYERS.map((player) => ({
      ...player,
      badgeMac: null,
      position: null,
      tracking: { status: "unknown", source: "badge-projection", lastSeenAt: null, staleAfterMs: 2000 },
      inventory: [],
      heldItem: "EMPTY",
      actionState: "idle",
    })),
    orders: [makeOrder("order-1", BURGER_RECIPES[0], now)],
    activeOrders: [makeOrder("order-1", BURGER_RECIPES[0], now)],
    order: makeOrder("order-1", BURGER_RECIPES[0], now),
    gold: { total: 0, earned: 0, lastChange: 0 },
    tips: { total: 0, earned: 0, lastChange: 0 },
    score: { value: 0, delivered: 0 },
    timer: { status: "ready", remainingSeconds: ROUND_SECONDS, totalSeconds: ROUND_SECONDS },
    clock: { status: "ready", remainingSeconds: ROUND_SECONDS, totalSeconds: ROUND_SECONDS },
    submissions: [],
    serving: { lastEvent: null, gooseQueue: 4, location: "SERVING" },
    stations: plan.stations.map((station) => ({ id: station.id, label: station.label, kind: station.kind, status: "idle", progress: 0, remainingSeconds: 0, item: null })),
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
    maxActiveOrders = 3, random = Math.random } = {}) {
    this.now = now;
    this.provider = provider || new LocalFloorplanProvider({ now });
    this.roundSeconds = roundSeconds;
    const fixedInterval = Number(orderIntervalSeconds);
    this.orderIntervalMinSeconds = Math.max(1, Math.min(120, Number.isFinite(fixedInterval) ? fixedInterval : Number(orderIntervalMinSeconds)));
    this.orderIntervalMaxSeconds = Math.max(this.orderIntervalMinSeconds, Math.min(180, Number.isFinite(fixedInterval) ? fixedInterval : Number(orderIntervalMaxSeconds)));
    this.maxActiveOrders = Math.max(1, Math.min(6, Number(maxActiveOrders) || 3));
    this.random = typeof random === "function" ? random : Math.random;
    this._nextOrderAt = null;
    this._orderSequence = 0;
    this._state = createInitialProjectionState(now());
    this._state.timer.totalSeconds = roundSeconds;
    this._state.timer.remainingSeconds = roundSeconds;
    this._state.clock = { ...this._state.timer };
    this._state.order = makeOrder("order-1", BURGER_RECIPES[0], now(), this._patienceSeconds());
    this._state.orders[0] = clone(this._state.order);
    this._orderSequence = 1;
    this._nextOrderAt = null;
    this._badges = new Map();
    this._seenEvents = new Set();
    this._listeners = new Set();
    this._roundStartedAt = null;
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

  _patienceSeconds() {
    const span = this.orderIntervalMaxSeconds - this.orderIntervalMinSeconds;
    return this.orderIntervalMinSeconds + Math.floor(Math.max(0, Math.min(0.999999, Number(this.random()) || 0)) * (span + 1));
  }

  _activeOrders() { return this._state.orders.filter((order) => order.status === "active"); }

  _syncActiveOrder() {
    const active = this._activeOrders();
    this._state.activeOrders = clone(active);
    this._state.order = active[0] || this._state.order;
  }

  _issueOrder(now = this.now()) {
    const recipe = BURGER_RECIPES[this._orderSequence % BURGER_RECIPES.length];
    this._orderSequence += 1;
    const order = makeOrder(`order-${this._orderSequence}`, recipe, now, this._patienceSeconds());
    this._state.orders.push(order);
    while (this._state.orders.length > 32) this._state.orders.shift();
    this._syncActiveOrder();
    return order;
  }

  _tick(now = this.now()) {
    if (this._state.timer.status !== "running" || this._roundStartedAt == null) return false;
    const remainingRound = Math.max(0, this.roundSeconds - Math.floor((now - this._roundStartedAt) / 1000));
    let changed = remainingRound !== this._state.timer.remainingSeconds;
    this._state.timer.remainingSeconds = remainingRound;
    this._state.clock.remainingSeconds = remainingRound;
    for (const order of this._activeOrders()) {
      const remaining = Math.max(0, Math.ceil((Date.parse(order.deadlineAt) - now) / 1000));
      const segment = Math.max(0, Math.min(3, Math.ceil((remaining / order.totalSeconds) * 3)));
      if (remaining !== order.remainingSeconds || segment !== order.patience.filledSegments) changed = true;
      order.remainingSeconds = remaining;
      order.patience.remainingSeconds = remaining;
      order.patience.filledSegments = segment;
      if (remaining === 0) {
        order.status = "expired";
        changed = true;
      }
    }
    const active = this._activeOrders();
    if (this._nextOrderAt == null) this._nextOrderAt = now + this._patienceSeconds() * 1000;
    if (remainingRound > 0 && active.length === 0) {
      this._issueOrder(now);
      this._nextOrderAt = now + this._patienceSeconds() * 1000;
      changed = true;
    } else if (remainingRound > 0 && now >= this._nextOrderAt && active.length < this.maxActiveOrders) {
      this._issueOrder(now);
      this._nextOrderAt = now + this._patienceSeconds() * 1000;
      changed = true;
    } else if (remainingRound > 0 && now >= this._nextOrderAt) {
      this._nextOrderAt = now + this._patienceSeconds() * 1000;
    }
    this._syncActiveOrder();
    if (remainingRound === 0) {
      for (const order of this._activeOrders()) order.status = "expired";
      this._state.timer.status = "ended";
      this._state.clock.status = "ended";
      this._state.setup.phase = "ended";
      this._state.setup.message = "Round ended. Reset to host another burger level.";
      this._roundStartedAt = null;
      changed = true;
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
        if (this._state.floorPlan.accepted !== true) throw new Error("approve the floorplan before starting the game");
        this._roundStartedAt = now;
        this._state.setup.phase = "running";
        this._state.setup.message = "Burger game running. Orders, gold, tips, timer, and submissions are server projections.";
        this._state.timer = { status: "running", remainingSeconds: this.roundSeconds, totalSeconds: this.roundSeconds };
        this._state.clock = { ...this._state.timer };
        this._orderSequence = 1;
        this._state.order = makeOrder("order-1", BURGER_RECIPES[0], now, this._patienceSeconds());
        this._state.orders = [clone(this._state.order)];
        this._state.activeOrders = [clone(this._state.order)];
        this._nextOrderAt = now + this._patienceSeconds() * 1000;
        this._state.burgerLevel.status = "in-play";
        this._state.submissions = [];
        this._state.serving.lastEvent = null;
        this._state.score = { value: 0, delivered: 0 };
        for (const player of this._state.players) {
          player.inventory = [];
          player.heldItem = "EMPTY";
          player.actionState = "idle";
        }
        this._touch(now);
        return this.snapshot(now);
      case "END_GAME":
        this.endGame(now);
        return this.snapshot(now);
      case "RESET_GAME":
        this._orderSequence = 1;
        this._state = createInitialProjectionState(now);
        this._state.timer.totalSeconds = this.roundSeconds;
        this._state.timer.remainingSeconds = this.roundSeconds;
        this._state.clock = { ...this._state.timer };
        this._state.order = makeOrder("order-1", BURGER_RECIPES[0], now, this._patienceSeconds());
        this._state.orders = [clone(this._state.order)];
        this._state.activeOrders = [clone(this._state.order)];
        this._roundStartedAt = null;
        this._nextOrderAt = null;
        this._seenEvents.clear();
        this._touch(now);
        return this.snapshot(now);
      default:
        throw new Error(`unsupported command: ${type}`);
    }
  }

  endGame(now = this.now()) {
    this._roundStartedAt = null;
    this._state.setup.phase = "ended";
    this._state.setup.message = "Game ended. Reset to host another burger level.";
    this._state.timer.status = "ended";
    this._state.clock.status = "ended";
    for (const player of this._state.players) {
      player.inventory = [];
      player.heldItem = "EMPTY";
      player.actionState = "idle";
    }
    this._touch(now);
  }

  _playerForIntent(intent) {
    if (intent.type === "H") return null;
    const mac = String(intent.senderMac || "").toUpperCase();
    const known = this._badges.get(mac);
    if (known) return this._state.players.find((player) => player.id === known) || null;
    const assigned = this.assignNextBadge(mac);
    return assigned ? this._state.players.find((player) => player.id === assigned) : null;
  }

  submit(player, value, now) {
    const raw = String(value || "").toUpperCase();
    const active = this._activeOrders();
    const current = active[0] || null;
    const claimed = raw.replace(/^SUBMIT[:=]/, "").replace(/^RECIPE[:=]/, "").split(/[|,;]/)[0];
    const compatibilitySuccess = claimed === "SUCCESS" || claimed === "OK";
    const explicitFailure = claimed === "FAILURE" || claimed === "FAIL" || claimed === "WRONG" || claimed === "REJECT";
    const claimedRecipe = compatibilitySuccess || explicitFailure || !claimed ? null : RECIPE_BY_ID.get(claimed);
    const target = claimedRecipe ? active.find((order) => order.recipe === claimedRecipe.id) : current;
    const success = this._state.timer.status === "running" && !explicitFailure && Boolean(target) && (compatibilitySuccess || (claimedRecipe && target.recipe === claimedRecipe.id));
    const recipe = target ? RECIPE_BY_ID.get(target.recipe) : null;
    const gold = success ? recipe.gold : 0;
    const tip = success ? Math.max(1, Math.round(gold * 0.1 + ((target.remainingSeconds / target.totalSeconds) * 5))) : 0;
    const event = {
      id: `submission-${this._state.submissions.length + 1}`,
      playerId: player?.id || null,
      status: success ? "success" : "failure",
      message: success ? "BURGER SERVED" : "WRONG BURGER",
      recipe: recipe?.id || claimed || null,
      expectedRecipe: current?.recipe || null,
      gold,
      tip,
      at: iso(now),
      raw: value,
      validation: success ? "server recipe and active-order match" : "recipe did not match an active order",
    };
    this._state.submissions.push(event);
    this._state.serving.lastEvent = event;
    if (success) {
      target.status = "completed";
      target.remainingSeconds = 0;
      target.patience.remainingSeconds = 0;
      target.patience.filledSegments = 0;
      this._state.gold.total += gold;
      this._state.gold.earned += gold;
      this._state.gold.lastChange = gold;
      this._state.tips.total += tip;
      this._state.tips.earned += tip;
      this._state.tips.lastChange = tip;
      this._state.score.value += gold;
      this._state.score.delivered += 1;
      this._syncActiveOrder();
      if (this._activeOrders().length === 0) this._issueOrder(now);
    } else {
      this._state.gold.lastChange = 0;
      this._state.tips.lastChange = 0;
    }
    if (player) {
      player.inventory = [];
      player.heldItem = "EMPTY";
      player.actionState = success ? "order served" : "submission rejected";
    }
    return event;
  }

  ingestBadgeEvent(intent, now = this.now()) {
    const sequenceKey = `${String(intent.senderMac || "").toUpperCase()}#${intent.sequence}`;
    if (this._seenEvents.has(sequenceKey)) return { accepted: false, duplicate: true, detail: "duplicate badge sequence ignored" };
    const player = this._playerForIntent(intent);
    const value = String(intent.value || "");
    let detail = "badge event projected";
    if (intent.type === "H" && value === "START") {
      if (this._state.floorPlan.accepted) this.command("START_GAME", {}, now);
      else this.command("START_HOST", {}, now);
    } else if (intent.type === "H" && value === "END") {
      this.endGame(now);
    } else if (intent.type === "B" && /^SUBMIT[:=]/i.test(value)) {
      this.submit(player, value, now);
    } else if (intent.type === "B" && /^TIP[:=]/i.test(value)) {
      const tip = numeric(value.split(/[:=]/)[1]);
      this._state.tips.total += tip;
      this._state.tips.earned += tip;
      this._state.tips.lastChange = tip;
    } else if (player && this._state.timer.status === "running") {
      if (intent.type === "M" && value === "CHOP") {
        player.actionState = "chopping";
        detail = `${player.id} chopping`;
      } else if (intent.type === "N") {
        if (value.startsWith("STN:")) {
          player.actionState = `at ${value.slice(4).toLowerCase()}`;
          detail = `${player.id} at ${value.slice(4)}`;
        } else {
          const item = value.replace(/^ING:/, "").replace(/^ITEM:/, "").toUpperCase();
          if (item) {
            player.heldItem = item;
            player.inventory = [item];
            player.actionState = `holding ${item.toLowerCase()}`;
            detail = `${player.id} picked up ${item}`;
          }
        }
      }
    }
    this._seenEvents.add(sequenceKey);
    while (this._seenEvents.size > 512) this._seenEvents.delete(this._seenEvents.values().next().value);
    this._state.health.gateway = { ...this._state.health.gateway, status: "healthy", lastSeenAt: iso(now), detail: "Host badge / USB online" };
    this._touch(now);
    return { accepted: true, duplicate: false, detail, stateVersion: this._state.version };
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
    this._touch(now);
    return { accepted: true, detail: status.up ? "gateway healthy" : "gateway reported down", stateVersion: this._state.version };
  }
}
