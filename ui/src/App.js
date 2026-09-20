import React from "react";
import {
  canRunAction,
  formatSeconds,
  isStale,
  playerPosition,
  progressPercent,
  GAME_ACTIONS,
  SETUP_PHASES,
  displayModeForPhase,
  UI_DISPLAY_MODES,
} from "./state.js";
import { validateFrontendSnapshot } from "./contracts.js";

const h = React.createElement;
const ASSETS = Object.freeze({
  BUN: "/assets/ingredient-bun.png",
  MEAT: "/assets/ingredient-meat.png",
  CHEESE: "/assets/ingredient-cheese.png",
  LETTUCE: "/assets/ingredient-lettuce.png",
});

const cx = (...values) => values.filter(Boolean).join(" ");
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, finite(value, min)));
const upper = (value) => String(value || "").replaceAll("-", " ").toUpperCase();
const ingredientKey = (value) => String(value || "").trim().toUpperCase().replaceAll(" ", "_");
const ingredientAsset = (value) => ASSETS[ingredientKey(value)] || null;

function phaseLabel(phase) {
  if (phase === SETUP_PHASES.SCANNING) return "SCANNING ROOM";
  if (phase === SETUP_PHASES.LAYOUT_PROPOSED) return "PROPOSED FLOOR PLAN";
  if (phase === SETUP_PHASES.BURGER_PLACEMENT) return "BURGER LEVEL PLACEMENT";
  if (phase === SETUP_PHASES.LAYOUT_ACCEPTED) return "BURGER LEVEL READY";
  if (phase === SETUP_PHASES.RUNNING) return "BURGER GAME RUNNING";
  if (phase === SETUP_PHASES.ENDED) return "GAME ENDED";
  return "HOST IDLE";
}

function orderTitle(order) {
  const dish = String(order?.dish || "BURGER").trim();
  if (!order?.toppings?.length || !dish.toUpperCase().includes("BURGER")) return dish;
  return `${order.toppings[0]} ${dish}`;
}

function activeOrdersFor(state) {
  const source = Array.isArray(state.orders) && state.orders.length ? state.orders : state.order ? [state.order] : [];
  return source.filter((order) => order?.status === "active").slice(0, 4);
}

function seconds(value) {
  if (value == null || !Number.isFinite(Number(value))) return "--:--";
  const amount = Math.max(0, Math.round(Number(value)));
  return `${String(Math.floor(amount / 60)).padStart(2, "0")}:${String(amount % 60).padStart(2, "0")}`;
}

function stageIndex(phase) {
  if (phase === SETUP_PHASES.RUNNING) return 4;
  if (phase === SETUP_PHASES.BURGER_PLACEMENT || phase === SETUP_PHASES.LAYOUT_ACCEPTED) return 3;
  if (phase === SETUP_PHASES.LAYOUT_PROPOSED) return 2;
  if (phase === SETUP_PHASES.SCANNING) return 1;
  return 0;
}

function StatusBadge({ status, label = status }) {
  const normalized = String(status || "unknown").toLowerCase();
  return h("span", { className: cx("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em]", `status-${normalized}`) },
    h("span", { className: "h-1.5 w-1.5 rounded-full bg-current", "aria-hidden": true }), upper(label));
}

function ActionButton({ state, action, label, onCommand, compact = false }) {
  const disabled = !canRunAction(state, action);
  return h("button", {
    type: "button",
    className: cx("game-action-button", compact && "game-action-button-compact"),
    disabled,
    "data-command": action,
    onClick: () => onCommand?.(action),
  }, label);
}

const STAGES = Object.freeze([
  { key: "host", label: "Wake the kitchen", description: "Turn on the game cameras", action: GAME_ACTIONS.START_HOST },
  { key: "scan", label: "Map the room", description: "Find a safe play area", action: GAME_ACTIONS.SCAN_ROOM },
  { key: "approve", label: "Choose the layout", description: "Check each station position", action: GAME_ACTIONS.APPROVE_LAYOUT },
  { key: "place", label: "Place the stations", description: "Match the pieces to the map", action: null },
  { key: "play", label: "Start cooking", description: "Begin the two-minute round", action: GAME_ACTIONS.START_GAME },
]);

function StageTracker({ state, onCommand }) {
  const current = stageIndex(state.setup?.phase);
  return h("ol", { className: "setup-stages", "aria-label": "Game setup stages" }, STAGES.map((stage, index) => {
    const complete = index < current;
    const active = index === current;
    const locked = index > current;
    return h("li", { key: stage.key, className: cx("setup-stage", active && "is-active", complete && "is-complete", locked && "is-locked"), "aria-current": active ? "step" : undefined },
      h("div", { className: "setup-stage-copy" },
        h("span", { className: "setup-stage-number" }, complete ? "✓" : index + 1),
        h("div", { className: "min-w-0" },
          h("strong", null, stage.label),
          h("span", null, stage.description),
        ),
      ),
      stage.action && (active || canRunAction(state, stage.action)) && h(ActionButton, { state, action: stage.action, label: stage.label, onCommand, compact: true }),
    );
  }));
}

function HostPanel({ state, onCommand }) {
  const phase = state.setup?.phase;
  return h("section", { className: "setup-card setup-progress", "aria-labelledby": "host-title" },
    h("div", { className: "setup-progress-heading" },
      h("div", null,
        h("p", { className: "setup-kicker" }, `Step ${stageIndex(phase) + 1} of ${STAGES.length}`),
        h("h2", { id: "host-title" }, STAGES[stageIndex(phase)]?.label || "Set up the kitchen"),
        h("p", null, state.setup?.message),
      ),
      h("div", { className: "setup-secondary-actions" },
        h(ActionButton, { state, action: GAME_ACTIONS.RESCAN, label: "Rescan", onCommand, compact: true }),
        h(ActionButton, { state, action: GAME_ACTIONS.RESET_GAME, label: "Reset", onCommand, compact: true }),
      ),
    ),
    h(StageTracker, { state, onCommand }),
  );
}

function RoomSurface({ state, now, gameplay = false }) {
  const plan = state.floorPlan || {};
  const accepted = plan.accepted === true;
  const walls = (plan.walls || []).map((wall, index) => h("div", {
    key: `wall-${index}`,
    className: "absolute z-[1] rounded-sm border border-[#45647d]/40 bg-[#304a60]/20",
    style: rectStyle(wall),
    "aria-hidden": true,
  }));
  const stations = (plan.stations || []).map((station) => h("div", {
    key: station.id,
    className: cx("room-station absolute z-[2] flex items-center justify-center whitespace-nowrap border text-center font-black uppercase tracking-[0.05em] shadow-[0_5px_0_rgba(6,16,25,.45)]", gameplay ? "room-station-gameplay" : "room-station-setup", stationClass(station.kind)),
    style: rectStyle(station),
    "data-station": station.id,
  }, station.label || station.id));
  const players = (state.players || []).map((player) => {
    const position = playerPosition(player);
    const stale = !position || isStale(player, now);
    const label = player.label || player.id;
    return h("div", {
      key: player.id,
      className: cx("tracked-player absolute z-[12] -translate-x-1/2 -translate-y-1/2", stale && "opacity-80"),
      style: position ? { left: `${clamp(position.x)}%`, top: `${clamp(position.y)}%` } : undefined,
      "data-player": player.id,
      "data-stale": stale,
      "aria-label": `${player.name || label}, ${stale ? "tracking stale" : "tracking healthy"}`,
    }, h("div", { className: cx("player-marker border-2 shadow-[0_4px_0_rgba(6,16,25,.6)]", player.color === "cyan" ? "player-marker-cyan" : "player-marker-orange", stale && "player-marker-stale") }, h("strong", null, label), stale && h("span", null, position ? "TRACKING STALE" : "TRACKING LOST")), h("span", { className: "sr-only" }, stale ? (position ? "TRACKING STALE" : "TRACKING LOST") : "TRACKING HEALTHY"));
  });
  return h("div", {
    className: cx("floor-plan relative h-full min-h-0 w-full overflow-hidden bg-[#0c1824]", accepted ? "is-accepted" : "is-proposed", gameplay && "gameplay-surface"),
    style: accepted ? { backgroundImage: "linear-gradient(rgba(8,16,25,.08), rgba(8,16,25,.12)), url('/assets/game-room-background.png')" } : undefined,
    role: "img",
    "aria-label": `${accepted ? "Accepted burger" : "Proposed room"} top-down floor plan with live tracked players`,
  }, h("div", { className: "absolute inset-0 opacity-10", style: { backgroundImage: "linear-gradient(#274257 1px, transparent 1px), linear-gradient(90deg, #274257 1px, transparent 1px)", backgroundSize: "8% 12%" }, "aria-hidden": true }), walls, stations, players,
  !accepted && h("div", { className: "absolute inset-0 z-[6] grid place-items-center bg-[#081019]/70 p-5 text-center text-sm font-black uppercase tracking-[0.12em] text-[#ffd166]" }, "Approve floor plan to generate burger level"));
}

function rectStyle(item) {
  const x = clamp(item?.x);
  const y = clamp(item?.y);
  const width = Math.min(clamp(item?.width, 1, 100), Math.max(1, 100 - x));
  const height = Math.min(clamp(item?.height, 1, 100), Math.max(1, 100 - y));
  return { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` };
}

function stationClass(kind) {
  if (kind === "ingredient") return "border-[#ff9d45] bg-[#55341f]/85 text-[#fff2e3]";
  if (kind === "chop") return "border-[#5bd8ee] bg-[#16404d]/85 text-white";
  if (kind === "stove" || kind === "pot") return "border-[#ffd166] bg-[#4b3b1d]/85 text-white";
  return "border-[#57e389] bg-[#1b4b35]/85 text-white";
}

function TimerCard({ state, compact = false }) {
  const clock = state.clock || {};
  return h("div", { className: cx("hud-timer", compact && "hud-timer-compact"), "data-node-id": "20:2", "aria-label": `Round timer ${seconds(clock.remainingSeconds)}` },
    h("div", { className: "hud-timer-rail", "aria-hidden": true }, h("div", { className: "hud-timer-bezel" }), h("div", { className: "hud-timer-sheen" })),
    h("img", { className: "hud-timer-icon", src: "/assets/timer-stopwatch.svg", alt: "" }),
    h("strong", { className: "hud-timer-value" }, seconds(clock.remainingSeconds)),
  );
}

function IngredientIcon({ value, small = false }) {
  const source = ingredientAsset(value);
  return source ? h("img", { className: cx("object-contain", small ? "h-8 w-8" : "h-12 w-12"), src: source, alt: upper(value), loading: "lazy" }) : h("span", { className: "text-xs font-black text-[#8e7664]" }, upper(value).slice(0, 3));
}

function OrderCard({ order, compact = false }) {
  const components = Array.isArray(order.components) ? order.components.slice(0, 4) : [];
  const remaining = Number(order.remainingSeconds);
  const total = Number(order.totalSeconds);
  const progress = Number.isFinite(remaining) && Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  const titleId = `hud-title-${String(order.id || "order").replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
  return h("section", { className: cx("hud-order", compact && "hud-order-compact"), "data-node-id": "39:26", "data-order-id": order.id, "aria-labelledby": titleId },
    h("div", { className: "hud-order-preview" }, h("div", { className: "hud-order-art", "aria-label": "Burger order marker" }, h(IngredientIcon, { value: "BUN" }))),
    h("div", { className: "hud-order-main" },
      h("h2", { id: titleId }, orderTitle(order)),
      h("div", { className: "hud-ingredient-slots" }, components.map((item, index) => h("div", { key: `${item}-${index}`, className: "hud-ingredient-slot", "data-ingredient-slot": index + 1 }, h(IngredientIcon, { value: item, small: false })))),
    ),
    h("div", { className: "hud-order-time", "aria-label": `${seconds(order.remainingSeconds)} remaining` },
      h("img", { src: "/assets/hud-stopwatch.svg", alt: "" }),
      h("strong", null, seconds(order.remainingSeconds)),
      h("div", { className: "hud-order-progress", role: "progressbar", "aria-label": "Order time remaining", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(progress) }, h("span", { style: { width: `${progress}%` } })),
    ),
  );
}

function OrdersHud({ state }) {
  const orders = activeOrdersFor(state);
  return h("div", { className: cx("game-board-orders", `orders-${orders.length}`), "data-order-count": orders.length, "aria-label": `${orders.length} active orders` },
    orders.length
      ? orders.map((order) => h(OrderCard, { key: order.id, order, compact: orders.length > 1 }))
      : h("div", { className: "orders-empty" }, "All orders served!"),
  );
}

function ScoreCard({ state }) {
  const score = state.score || {};
  return h("div", { className: "board-score", "data-node-id": "31:25", "aria-label": `Score ${score.value ?? 0}, ${score.delivered ?? 0} burgers served` },
    h("img", { src: "/assets/score-coin-counter.png", alt: "", "aria-hidden": true }),
    h("strong", { className: "board-score-value" }, score.value ?? 0),
  );
}

function notificationsFor(state) {
  const notifications = [];
  const event = state.serving?.lastEvent;
  if (event) notifications.push({ tone: event.status === "success" ? "success" : "failure", title: event.message || "SERVING UPDATE", detail: event.detail || "Serving badge update", meta: event.status === "success" ? `+${event.points ?? 0}` : "CHECK ORDER" });
  (state.stations || []).filter((station) => {
    const status = String(station.status || "").toLowerCase();
    const item = String(station.item || "").toUpperCase();
    return item && item !== "EMPTY" && !["ready", "completed", "idle"].includes(status);
  }).slice(0, 4).forEach((station) => notifications.push({ tone: station.status === "cooking" ? "cooking" : "chopping", title: `${station.label || station.id} · ${station.item}`, detail: upper(station.status || "active"), meta: station.remainingSeconds == null ? "ACTIVE" : seconds(station.remainingSeconds) }));
  return notifications;
}

function NotificationStack({ state }) {
  const notifications = notificationsFor(state);
  if (!notifications.length) return null;
  return h("aside", { className: "board-notifications", "aria-label": "Live game notifications" },
    h("div", { className: "px-1 text-right text-[10px] font-black uppercase tracking-[0.14em] text-white drop-shadow" }, "LIVE ACTIVITY"),
    notifications.map((item, index) => h("div", { key: `${item.title}-${index}`, className: cx("board-notification grid grid-cols-[auto_1fr_auto] items-center gap-2 border border-[#7890a6] border-l-4 bg-[#081019]/90 px-2.5 py-2 text-white", `notification-${item.tone}`) },
      h("span", { className: "h-2 w-2 rounded-full bg-current", "aria-hidden": true }),
      h("span", { className: "min-w-0" }, h("strong", { className: "block truncate text-xs" }, item.title), h("small", { className: "block text-[10px] font-bold uppercase tracking-[0.08em] text-[#c1ced9]" }, item.detail)),
      h("strong", { className: "text-xs" }, item.meta),
    )),
  );
}

function GameplayBoard({ state, now }) {
  return h("section", { className: "game-board panel overflow-hidden border border-[#2a435a] bg-[#0c1824]", "aria-labelledby": "game-board-title" },
    h("h2", { id: "game-board-title", className: "sr-only" }, "Live burger game board"),
    h("div", { className: "relative aspect-[1672/941] min-h-[520px] w-full overflow-hidden bg-[#0c1824]" },
      h(RoomSurface, { state, now, gameplay: true }),
      h(OrdersHud, { state }),
      h("div", { className: "game-board-score" }, h(ScoreCard, { state })),
      h("div", { className: "game-board-timer" }, h(TimerCard, { state, compact: true })),
      h(NotificationStack, { state }),
    ),
  );
}

function PlacementPanel({ state }) {
  const instructions = state.burgerLevel?.placementInstructions || [];
  return h("section", { className: "setup-card placement-card", "aria-labelledby": "placement-title" },
    h("div", { className: "placement-heading" }, h("div", null, h("p", { className: "setup-kicker" }, "Kitchen pieces"), h("h2", { id: "placement-title" }, "Put every station in place")), h("span", { className: "placement-count" }, `${instructions.length} pieces`)),
    h("p", null, "Match each printed ingredient and station to the room map. Keep chopping boards and stoves still once the round begins."),
    h("ul", { className: "placement-list" }, instructions.map((item, index) => h("li", { key: item.id }, h("span", null, index + 1), h("div", null, h("strong", null, item.label), h("small", null, item.instruction))))),
  );
}

function SetupView({ state, now, onCommand }) {
  const accepted = state.floorPlan?.accepted === true;
  return h("div", { className: "setup-flow" },
    h(HostPanel, { state, onCommand }),
    h("div", { className: "setup-workspace" },
      h("section", { className: "setup-card map-card", "aria-labelledby": "map-title" }, h("div", { className: "map-heading" }, h("div", null, h("p", { className: "setup-kicker" }, accepted ? "Layout ready" : "Room preview"), h("h2", { id: "map-title" }, accepted ? "Your burger kitchen" : "Check the play area")), h("span", { className: cx("map-state", accepted && "is-ready") }, accepted ? "Ready to place" : "Needs approval")), h("div", { className: "map-frame" }, h(RoomSurface, { state, now }))),
      h(PlacementPanel, { state }),
    ),
  );
}

function StationsPanel({ state }) {
  const cards = (state.stations || []).map((station) => {
    const progress = progressPercent(station.progress);
    return h("article", { key: station.id, className: "border border-[#2a435a] bg-[#0c1824] p-3" },
      h("div", { className: "flex items-center justify-between gap-2" },
        h("h3", { className: "font-extrabold text-white" }, station.label || station.id),
        h(StatusBadge, { status: station.status || "unknown", label: station.status || "unknown" }),
      ),
      h("p", { className: "my-3 text-sm text-[#a9bac9]" }, station.item || "EMPTY"),
      h("div", { className: "h-2 overflow-hidden bg-[#071019]" }, h("span", { className: "block h-full bg-[#ffd166]", style: { width: `${progress}%` } })),
      h("div", { className: "mt-2 flex justify-between text-xs font-bold text-[#a9bac9]" },
        h("span", null, `${progress.toFixed(0)}%`),
        h("span", null, station.remainingSeconds == null ? "--:--" : `${formatSeconds(station.remainingSeconds)} remaining`),
      ),
    );
  });
  return h("section", { className: "border border-[#2a435a] bg-[#101c29] p-5", "aria-labelledby": "stations-title" },
    h("div", { className: "mb-4 flex items-center justify-between" },
      h("div", null, h("p", { className: "mb-1 text-xs font-black uppercase tracking-[0.16em] text-[#a9bac9]" }, "Authoritative station state"), h("h2", { id: "stations-title", className: "text-xl font-black text-white" }, "Cut, cook & assemble")),
      h(StatusBadge, { status: "running", label: "Live" }),
    ),
    h("div", { className: "grid gap-3 sm:grid-cols-2" }, cards),
  );
}

function ServingPanel({ state }) {
  const queue = Math.max(0, Number(state.serving?.gooseQueue || 0));
  const event = state.serving?.lastEvent;
  return h("section", { className: cx("delivery-panel serving-panel border bg-[#101c29] p-5", event?.status === "success" ? "delivery-success border-[#57e389]" : event ? "delivery-failure border-[#ff6f6f]" : "border-[#2a435a]"), "aria-labelledby": "serving-title" }, h("p", { className: "mb-1 text-xs font-black uppercase tracking-[0.16em] text-[#a9bac9]" }, event ? "Serving result" : "Serving / Waterloo geese"), h("h2", { id: "serving-title", className: "text-xl font-black text-white" }, event?.message || `${queue} geese waiting`), h("div", { className: "my-4 flex flex-wrap gap-2" }, Array.from({ length: Math.min(queue, 8) }, (_, index) => h("span", { key: index, className: "border border-[#d6dce3] bg-[#f5f7fa] px-2 py-1 text-[10px] font-black text-[#16212b]" }, "GOOSE"))), h("p", { className: "text-sm text-[#a9bac9]" }, event?.detail || "Bring a completed burger to the serving badge. No washing dishes."), event && h("strong", { className: cx("delivery-points mt-5 block text-3xl", event.status === "success" ? "text-[#57e389]" : "text-[#ff6f6f]") }, event.status === "success" ? `+${event.points ?? 0}` : "NO SCORE"));
}

function GameplayView({ state, now }) {
  return h(GameplayBoard, { state, now });
}

function ResultsView({ state, now, onCommand }) {
  return h(React.Fragment, null, h("section", { className: "flex flex-col justify-between gap-4 border border-[#ffd166] bg-[#2a2415] p-5 md:flex-row md:items-center" }, h("div", null, h("p", { className: "mb-1 text-xs font-black uppercase tracking-[0.16em] text-[#ffd166]" }, "Round complete"), h("h2", { className: "text-2xl font-black text-white" }, phaseLabel(state.setup?.phase)), h("p", { className: "mt-1 text-sm text-[#a9bac9]" }, state.setup?.message)), h(ActionButton, { state, action: GAME_ACTIONS.RESET_GAME, label: "Reset game", onCommand })), h("div", { className: "mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.85fr)]" }, h("section", { className: "border border-[#2a435a] bg-[#101c29] p-5" }, h("div", { className: "mb-4 flex items-center justify-between" }, h("h2", { className: "text-xl font-black text-white" }, "Room mirror"), h(StatusBadge, { status: "healthy", label: "Final layout" })), h("div", { className: "aspect-[1672/941] overflow-hidden border border-[#45647d]" }, h(RoomSurface, { state, now }))), h(ServingPanel, { state })));
}

export function App({ state, now = Date.now(), connectionError = "", onCommand }) {
  if (!state) return h("section", { className: "mx-auto mt-24 max-w-2xl border border-[#2a435a] bg-[#101c29] p-8 text-center" }, h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-[#a9bac9]" }, "Burger level"), h("h1", { className: "mt-2 text-3xl font-black text-white" }, "Waiting for authoritative state…"), connectionError && h("div", { id: "ui-error", className: "ui-error", role: "alert" }, connectionError));
  const validation = validateFrontendSnapshot(state);
  if (!validation.valid) return h("section", { className: "mx-auto mt-24 max-w-3xl border border-[#ff6f6f] bg-[#2c1820] p-8", role: "alert" }, h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-[#ff6f6f]" }, "Burger level"), h("h1", { className: "mt-2 text-3xl font-black text-white" }, "Authoritative state unavailable"), h("p", { className: "mt-3 text-[#a9bac9]" }, "The received snapshot does not match the frontend contract. No game values were rendered."), h("p", { className: "mt-3 text-white" }, validation.errors.map((error) => error.message).join(" ")));
  const mode = displayModeForPhase(state.setup?.phase);
  const content = mode === UI_DISPLAY_MODES.GAMEPLAY ? h(GameplayView, { state, now, onCommand }) : mode === UI_DISPLAY_MODES.RESULTS ? h(ResultsView, { state, now, onCommand }) : h(SetupView, { state, now, onCommand });
  const gameplay = mode === UI_DISPLAY_MODES.GAMEPLAY;
  return h("div", { className: cx("app-shell", gameplay && "is-gameplay"), "data-display-mode": mode },
    !gameplay && h("header", { className: "setup-hero" }, h("div", null, h("p", { className: "setup-kicker" }, "Waterloo Goose Kitchen"), h("h1", null, mode === UI_DISPLAY_MODES.RESULTS ? "Round complete" : "Set up the burger level"), h("p", null, mode === UI_DISPLAY_MODES.RESULTS ? "See how the kitchen performed." : "Map the room, place each station, then start cooking.")), h("div", { className: "connection-pill" }, h("span", null), "Kitchen connected")),
    connectionError && h("div", { id: "ui-error", className: "ui-error mb-4", role: "alert" }, connectionError),
    content,
  );
}
