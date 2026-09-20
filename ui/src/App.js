import React from "react";
import {
  canRunAction,
  formatSeconds,
  isStale,
  timestampMs,
  matchRuntimeStations,
  playerPosition,
  progressPercent,
  stationProgressPercent,
  GAME_ACTIONS,
  SETUP_PHASES,
  displayModeForPhase,
  UI_DISPLAY_MODES,
} from "./state.js";
import { validateFrontendSnapshot } from "./contracts.js";
import { DEFAULT_MAX_STARS, calculateStarRating, summarizeOrders } from "./onboarding.js";
import {
  headingForPath,
  MAX_PLAYER_MOVE_MS,
  movementEase,
  planPlayerPaths,
  projectPointIntoWalkableRoom,
  routePlayerPath,
  separatePlayerPositions,
} from "./room-layout.js";
import { cookingStateLabel, cookingVisualState, plateableIngredientKeys } from "./food-rules.js";
import { INGREDIENT_KINDS, ingredientSprite, ingredientStage, platedStage, plateSprite } from "./ingredient-sprites.js";

const h = React.createElement;
const FIGMA_ASSETS = Object.freeze({
  CHEF: "/assets/chef-player.svg",
  PLATE: "/assets/player-plate.svg",
});
// A chef holding a plate is drawn in two layers — hands/arms/shoes (back),
// then the plate sprite, then hat/body (front) — so the plate is held like
// the original art: in front of the hands but tucked behind the hat.
const PLAYER_ASSETS = Object.freeze({
  green: Object.freeze({
    chef: FIGMA_ASSETS.CHEF,
    holdBack: "/assets/chef-player-with-plate-back.svg",
    holdFront: "/assets/chef-player-with-plate-front.svg",
  }),
  red: Object.freeze({
    chef: "/assets/chef-player-red.svg",
    holdBack: "/assets/chef-player-with-plate-back-red.svg",
    holdFront: "/assets/chef-player-with-plate-front-red.svg",
  }),
  blue: Object.freeze({
    chef: "/assets/chef-player-blue.svg",
    holdBack: "/assets/chef-player-with-plate-back-blue.svg",
    holdFront: "/assets/chef-player-with-plate-front-blue.svg",
  }),
});
const STATION_ASSETS = Object.freeze({
  PANTRY: "/assets/pantry.png",
  FRIDGE: "/assets/fridge (1).png",
  COUNTER: "/assets/counter.png",
  CHOP: "/assets/chop_station.png",
  STOVE: "/assets/stove.png",
});
const HAZARD_ASSET = "/assets/hazard-warning.svg";
const FIRE_ASSET = "/assets/fire.svg";

const cx = (...values) => values.filter(Boolean).join(" ");
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, finite(value, min)));
const upper = (value) => String(value || "").replaceAll("-", " ").toUpperCase();
const ingredientKey = (value) => String(value || "").trim().toUpperCase().replaceAll(" ", "_");
const playerTeam = (value) => Object.prototype.hasOwnProperty.call(PLAYER_ASSETS, String(value || "").toLowerCase())
  ? String(value).toLowerCase()
  : "green";
const playerChefAsset = (player) => PLAYER_ASSETS[playerTeam(player?.color)].chef;

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
  const source = Array.isArray(state.activeOrders) && state.activeOrders.length
    ? state.activeOrders
    : Array.isArray(state.orders) && state.orders.length
      ? state.orders
      : state.order ? [state.order] : [];
  return source.filter((order) => order?.status === "active").slice(0, 4);
}

const TOUR_PREVIEW_ORDER = Object.freeze({
  id: "tour-order",
  dish: "PLAIN MEAT BURGER",
  recipe: "PLAIN_MEAT",
  status: "active",
  toppings: [],
  components: ["BUN", "MEAT"],
  goldValue: 100,
  remainingSeconds: null,
  totalSeconds: null,
  patience: { segments: 3, filledSegments: 3 },
});

function tourPreviewState(state) {
  const order = activeOrdersFor(state)[0] || TOUR_PREVIEW_ORDER;
  const components = Array.isArray(order.components) && order.components.length
    ? [...order.components]
    : [...TOUR_PREVIEW_ORDER.components];
  const previewOrder = {
    ...TOUR_PREVIEW_ORDER,
    ...order,
    components,
    status: "active",
    // The tour is a paused preview. A customer timer must not count down while
    // somebody is still learning the room.
    remainingSeconds: null,
    totalSeconds: null,
    preview: true,
    patience: { ...TOUR_PREVIEW_ORDER.patience, ...order.patience, filledSegments: 3 },
  };
  const totalSeconds = Number(state.clock?.totalSeconds) > 0 ? Number(state.clock.totalSeconds) : 240;
  const previewStations = Array.isArray(state.stations)
    ? state.stations.map((station) => ({
      ...station,
      status: station.kind === "ingredient" ? "ready" : "idle",
      progress: 0,
      remainingSeconds: 0,
      totalSeconds: 0,
      item: "EMPTY",
      warning: false,
      warningMessage: undefined,
      actionState: undefined,
    }))
    : state.stations;
  const previewPlayers = Array.isArray(state.players)
    ? state.players.map((player) => ({
      ...player,
      inventory: [],
      plate: [],
      hasPlate: false,
      heldItem: null,
      actionState: undefined,
      actionStateAt: undefined,
    }))
    : state.players;
  return {
    ...state,
    orders: [previewOrder],
    activeOrders: [previewOrder],
    order: previewOrder,
    stations: previewStations,
    players: previewPlayers,
    score: { ...(state.score || {}), value: 0, delivered: 0 },
    gold: { ...(state.gold || {}), total: 0, earned: 0, lastChange: 0 },
    tips: { ...(state.tips || {}), total: 0, earned: 0, lastChange: 0 },
    serving: { ...(state.serving || {}), lastEvent: null },
    clock: { ...(state.clock || {}), status: "ready", remainingSeconds: totalSeconds, totalSeconds },
  };
}

function seconds(value) {
  if (value == null || !Number.isFinite(Number(value))) return "--:--";
  const amount = Math.max(0, Math.round(Number(value)));
  return `${String(Math.floor(amount / 60)).padStart(2, "0")}:${String(amount % 60).padStart(2, "0")}`;
}

function stageIndex(phase) {
  if (phase === SETUP_PHASES.RUNNING) return 3;
  if (phase === SETUP_PHASES.BURGER_PLACEMENT || phase === SETUP_PHASES.LAYOUT_ACCEPTED) return 2;
  if (phase === SETUP_PHASES.LAYOUT_PROPOSED) return 1;
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

function stagesForLayout(layoutFromImage) {
  return layoutFromImage ? [
    { key: "host", label: "Wake the kitchen", description: "Turn on the host and setup camera", action: GAME_ACTIONS.START_HOST },
    { key: "scan", label: "Map the room", description: "Use setup photos for the play area", action: GAME_ACTIONS.SCAN_ROOM },
    { key: "place", label: "Place the stations", description: "Match pieces to those spots", action: null },
    { key: "play", label: "Start cooking", description: "Begin the four-minute round", action: GAME_ACTIONS.START_GAME },
  ] : [
    { key: "host", label: "Wake the kitchen", description: "Turn on the host badge and display", action: GAME_ACTIONS.START_HOST },
    { key: "scan", label: "Load the room", description: "Use the standard kitchen layout", action: GAME_ACTIONS.SCAN_ROOM },
    { key: "place", label: "Place the stations", description: "Put the NFC zones at the illustrated counters", action: null },
    { key: "play", label: "Start cooking", description: "Begin the four-minute round", action: GAME_ACTIONS.START_GAME },
  ];
}

function StageTracker({ state, onCommand }) {
  const current = stageIndex(state.setup?.phase);
  const stages = stagesForLayout(state.floorPlan?.layoutFromImage === true);
  return h("ol", { className: "setup-stages", "aria-label": "Game setup stages" }, stages.map((stage, index) => {
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
  const stages = stagesForLayout(state.floorPlan?.layoutFromImage === true);
  return h("section", { className: "setup-card setup-progress", "aria-labelledby": "host-title" },
    h("div", { className: "setup-progress-heading" },
      h("div", null,
        h("p", { className: "setup-kicker" }, `Step ${stageIndex(phase) + 1} of ${stages.length}`),
        h("h2", { id: "host-title" }, stages[stageIndex(phase)]?.label || "Set up the kitchen"),
        h("p", null, state.setup?.message),
      ),
      h("div", { className: "setup-secondary-actions" },
        h(ActionButton, { state, action: GAME_ACTIONS.RESCAN, label: "Rescan", onCommand, compact: true }),
        h(ActionButton, { state, action: GAME_ACTIONS.RESET_GAME, label: "Reset", onCommand, compact: true }),
      ),
    ),
    h(StageTracker, { state, onCommand }),
    phase === SETUP_PHASES.LAYOUT_PROPOSED && h("button", {
      type: "button",
      className: "onboarding-button setup-approve-layout",
      disabled: !canRunAction(state, GAME_ACTIONS.APPROVE_LAYOUT),
      "data-command": GAME_ACTIONS.APPROVE_LAYOUT,
      onClick: () => onCommand?.(GAME_ACTIONS.APPROVE_LAYOUT),
    }, "Approve room layout"),
  );
}

function ingredientNames(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    const name = upper(item);
    return INGREDIENT_KINDS.filter((ingredient) => name.includes(ingredient));
  });
}

function ingredientItems(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item) => ingredientNames(item).length > 0);
}

function stationAsset(station) {
  const explicit = STATION_ASSETS[String(station?.assetKey || "").toUpperCase()];
  if (explicit) return explicit;
  if (station.kind === "chop") return STATION_ASSETS.CHOP;
  if (station.kind === "stove" || station.kind === "pot") return STATION_ASSETS.STOVE;
  if (station.kind === "delivery" || station.kind === "assembly") return STATION_ASSETS.COUNTER;
  return /BUN|LETTUCE/i.test(station.id || station.label) ? STATION_ASSETS.PANTRY : STATION_ASSETS.FRIDGE;
}

function PlateIngredients({ ingredients, className, label, stage }) {
  const visible = ingredients.slice(0, 4);
  if (!visible.length) return null;
  return h("div", { className: cx(className, visible.length === 1 && "is-single"), "aria-label": label }, visible.map((ingredient, index) => h(IngredientIcon, {
    key: `${ingredient}-${index}`,
    value: ingredient,
    stage,
  })));
}

function stationWarning(runtimeStation, progress) {
  if (!runtimeStation) return false;
  const status = upper(runtimeStation.status || runtimeStation.phase || runtimeStation.processing);
  if (/BURNT|BURNED/.test(status)) return false;
  const explicitWarning = runtimeStation.warning === true
    || runtimeStation.danger === true
    || runtimeStation.hazard === true;
  const statusWarning = /WARNING|DANGER|BURN|OVERCOOK/.test(status);
  const thresholdValue = Number(runtimeStation.warningProgress ?? runtimeStation.dangerAtProgress);
  const threshold = Number.isFinite(thresholdValue)
    ? (thresholdValue <= 1 ? thresholdValue * 100 : thresholdValue)
    : null;
  return explicitWarning || statusWarning || (threshold != null && progress >= threshold);
}

function StationContents({ station, runtimeStation, serving }) {
  const runtimeItem = runtimeStation?.contents ?? runtimeStation?.item ?? runtimeStation?.heldItem;
  const sourceItem = station.kind === "ingredient" ? station.contents || station.label : station.contents;
  const servingItem = station.kind === "delivery" ? serving?.item : null;
  const displayItem = ingredientKey(runtimeItem) === "PLATE" ? sourceItem : runtimeItem || sourceItem || servingItem;
  const ingredients = ingredientNames(displayItem);
  const status = runtimeStation?.status || (station.kind === "ingredient" ? "source" : "empty");
  const remaining = runtimeStation?.remainingSeconds;
  const progress = stationProgressPercent(runtimeStation);
  const visualState = station.kind === "ingredient" || station.kind === "assembly"
    ? "ready"
    : cookingVisualState({ status, item: displayItem, progress });
  const contentLabel = ingredients.length ? ingredients.join("+") : "EMPTY";
  const items = ingredientItems(displayItem);
  const isWorkstation = station.kind === "stove" || station.kind === "chop";
  // Source stations (fridge/crate) are self-describing art: no ingredient icon
  // on top and no name caption. The accessible label names them.
  const isSource = station.kind === "ingredient";
  // The stage decides which sprite variant an item shows: raw at sources,
  // raw while a chop is in progress, chopped afterwards, chopped meat on a
  // stove until it is cooked or burnt, and everything else as plated food.
  const iconStage = isSource
    ? "raw"
    : station.kind === "chop"
      ? (visualState === "chopping" ? "raw" : "chopped")
      : station.kind === "stove"
        ? (visualState === "burnt" ? "burnt" : visualState === "cooked" ? "cooked" : "chopped")
        : "plated";
  // An assembly plate with drawn art for its exact mix renders as one sprite.
  const comboSprite = station.kind === "assembly" ? plateSprite(ingredients) : null;
  const hasComboPlate = Boolean(comboSprite);
  const isWarning = isWorkstation && stationWarning(runtimeStation, progress);
  const isBurnt = isWorkstation && visualState === "burnt";
  const stateLabel = station.kind === "ingredient"
    ? "SOURCE"
    : isWarning ? "WARNING" : cookingStateLabel(visualState);
  const timingLabel = Number.isFinite(Number(remaining)) && Number(remaining) > 0 ? ` · ${seconds(remaining)}` : "";
  // Only stoves and chopping boards run timers, so only they get a progress
  // bar: never pantry/fridge/ingredient sources or the assembly counter, even
  // if a snapshot carries a progress value for them. An idle workstation with
  // nothing on it shows no bar until it holds an item or is cooking, chopping,
  // done, warning, or burnt.
  const workstationBusy = /COOK|CHOP|DONE|WARN|BURN/.test(upper(status));
  const timingStation = Boolean(runtimeStation) && isWorkstation && (ingredients.length > 0 || workstationBusy);
  const totalSeconds = Number(runtimeStation?.totalSeconds ?? runtimeStation?.durationSeconds);
  return h("div", { className: cx("station-visual", `station-visual-${station.kind}`, `station-state-${visualState}`, isWarning && "station-state-warning"), "data-station-content": contentLabel, "data-station-phase": visualState, "data-cook-progress": isWorkstation ? progress : undefined, "data-station-warning": isWarning ? "true" : "false", "aria-label": `${station.label || station.id}: ${contentLabel}, ${stateLabel}${timingLabel}` },
    h("img", { className: "station-art", src: stationAsset(station), alt: "" }),
    hasComboPlate
      ? h("img", { className: "station-plate-art is-combo", src: comboSprite, alt: "", "data-plate-sprite": "combo" })
      : h(React.Fragment, null,
        (station.kind === "delivery" || station.kind === "assembly") && h("img", { className: "station-plate-art", src: FIGMA_ASSETS.PLATE, alt: "" }),
        !isSource && h(PlateIngredients, { ingredients: items, stage: iconStage, className: "station-ingredients", label: `${station.label || station.id} contents: ${contentLabel}` }),
      ),
    // The knife is baked into the chop board art, which would put it *under* the
    // ingredient. A cut-out copy of it is layered above the item so the knife
    // reads as cutting it.
    station.kind === "chop" && ingredients.length > 0 && h("img", { className: "station-knife", src: "/assets/chop-knife.png", alt: "" }),
    isWarning && h("div", { className: "station-hazard station-hazard-warning", role: "img", "aria-label": runtimeStation.warningMessage || "Cooking warning: remove the food soon" },
      h("img", { src: HAZARD_ASSET, alt: "Cooking warning" }),
    ),
    isBurnt && h("div", { className: "station-hazard station-hazard-fire", role: "img", "aria-label": "Food burnt" },
      h("img", { src: FIRE_ASSET, alt: "Food burnt" }),
    ),
    isWorkstation && ingredients.length > 0 && h("span", { className: "station-item-label", title: ingredients.join(" + "), "data-station-item": ingredients.join("+") }, ingredients.join(" + ")),
    h("span", { className: "room-station-state" }, stateLabel, timingLabel),
    !isSource && h("div", { className: "station-caption" },
      h("span", { className: "room-station-label" }, station.label || station.id),
      timingStation && h("span", { className: "station-progress-track", role: "meter", "aria-label": `${station.label || station.id} progress`, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(progress), "data-progress": progress, "data-total-seconds": Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : undefined, "data-remaining-seconds": Number.isFinite(Number(remaining)) ? remaining : undefined }, h("span", { style: { width: `${progress}%` } })),
    ),
  );
}

// The authoritative server sends `plate: []` for a player with NO plate and
// says so explicitly through `hasPlate` / `heldItem`, while the offline mock
// uses `plate: []` for an empty plate in hand. Trust the explicit fields first
// and only fall back to the legacy array convention when they are absent.
function playerHasPlate(player) {
  if (typeof player?.hasPlate === "boolean") return player.hasPlate;
  if (player?.heldItem != null && String(player.heldItem).trim() !== "") return ingredientKey(player.heldItem) === "PLATE";
  return Array.isArray(player?.plate)
    || (Array.isArray(player?.inventory) && player.inventory.some((item) => ingredientKey(item) === "PLATE"));
}

function playerPlateItems(player) {
  if (Array.isArray(player?.plate)) return player.plate;
  const inventory = Array.isArray(player?.inventory) ? player.inventory : [];
  return inventory.some((item) => ingredientKey(item) === "PLATE")
    ? inventory.filter((item) => ingredientKey(item) !== "PLATE")
    : [];
}

function playerHeldItems(player, plateItems) {
  const inventory = Array.isArray(player?.inventory) ? player.inventory : [];
  return plateItems.length ? [] : ingredientItems(inventory).slice(0, 1);
}

function stationGridClass(station, grid) {
  const row = Number(station?.grid?.row);
  const rows = Number(grid?.rows);
  if (!Number.isFinite(row) || !Number.isFinite(rows)) return "";
  if (row <= 1) return "station-edge-top";
  if (row >= rows - 2) return "station-edge-bottom";
  return "";
}

function playerPointAlongPath(path, progress) {
  if (path.length < 2) return path[0] || { x: 50, y: 88 };
  const segments = path.slice(1).map((point, index) => ({ from: path[index], to: point, length: Math.hypot(point.x - path[index].x, point.y - path[index].y) }));
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let remaining = total * progress;
  for (const segment of segments) {
    if (remaining <= segment.length || segment === segments.at(-1)) {
      const amount = segment.length ? remaining / segment.length : 1;
      return {
        x: segment.from.x + ((segment.to.x - segment.from.x) * amount),
        y: segment.from.y + ((segment.to.y - segment.from.y) * amount),
      };
    }
    remaining -= segment.length;
  }
  return path.at(-1);
}

// The server's free-text `actionState`; only moments a player needs to notice
// get a bubble (routine "holding ..." states are already visible as the item).
const ACTION_BUBBLES = Object.freeze([
  [/cut failed/i, "CUT FAILED", "bad"],
  [/submission rejected|consensus expired/i, "REJECTED", "bad"],
  [/order served/i, "SERVED!", "good"],
  [/ready to submit/i, "SHAKE!", "info"],
  [/no transfer/i, "NO SWAP", "bad"],
  [/transferred/i, "SWAPPED", "good"],
  [/dropped/i, "DROPPED", "info"],
]);
const ACTION_BUBBLE_LIFETIME_MS = 6000;

function actionBubble(player, now) {
  const state = String(player?.actionState || "");
  const match = ACTION_BUBBLES.find(([pattern]) => pattern.test(state));
  if (!match) return null;
  // actionState persists until the player's next action, so fade it out using
  // `actionStateAt` (stamped in the browser by action-tracker.js). With no stamp its age is unknown; hide it
  // rather than leave a stale callout on screen.
  const changedAt = timestampMs(player?.actionStateAt);
  if (changedAt == null || !Number.isFinite(Number(now))) return null;
  if (Number(now) - changedAt > ACTION_BUBBLE_LIFETIME_MS) return null;
  return { text: match[1], tone: match[2] };
}

function AnimatedPlayer({ player, position, walls, stale, plannedPath, delayMs = 0, pathStrategy = "single-agent", now, tourTarget = false }) {
  const target = projectPointIntoWalkableRoom(position, walls, position);
  const targetKey = `${target.x.toFixed(3)}:${target.y.toFixed(3)}`;
  const wallKey = (walls || []).map((wall) => `${wall.x}:${wall.y}:${wall.width}:${wall.height}:${wall.blocksMovement}`).join("|");
  const plannedPathKey = Array.isArray(plannedPath) ? plannedPath.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join("|") : "";
  const previousPoint = React.useRef(target);
  const facingRef = React.useRef(0);
  const frame = React.useRef(0);
  const [visualPosition, setVisualPosition] = React.useState(target);
  const [facing, setFacing] = React.useState(0);
  const [moving, setMoving] = React.useState(false);
  const plateItems = plateableIngredientKeys(playerPlateItems(player));
  const heldItems = playerHeldItems(player, plateItems);
  const hasPlate = playerHasPlate(player);
  // The chef art no longer carries its own plate: one ready-made plate sprite
  // (plate + food in a single image) fills the plate region instead, so items
  // can never spill off. Only combos without drawn art (cheese+lettuce) keep
  // the loose icon grid, laid on the empty-plate art.
  const plateCombo = hasPlate && plateItems.length > 0 ? plateSprite(plateItems) : null;
  const plateArt = hasPlate ? plateCombo || plateSprite([]) : null;
  const team = playerTeam(player?.color);
  const chefArt = PLAYER_ASSETS[team];

  React.useEffect(() => {
    const from = previousPoint.current;
    const plannedStart = plannedPath?.[0];
    const plannedStartIsCurrent = plannedStart
      && Math.hypot(plannedStart.x - from.x, plannedStart.y - from.y) < 1;
    const path = plannedStartIsCurrent && plannedPath.length > 0
      ? plannedPath
      : routePlayerPath(from, target, walls);
    const destination = path.at(-1) || from;
    if (from.x === destination.x && from.y === destination.y) return undefined;

    const distance = path.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - path[index].x, point.y - path[index].y), 0);
    const duration = Math.min(MAX_PLAYER_MOVE_MS, Math.max(460, distance * 19));
    let delayTimer;
    const start = () => {
      const startedAt = performance.now();
      const initialFacing = headingForPath(path, 0, facingRef.current);
      facingRef.current = initialFacing;
      setFacing(initialFacing);
      setMoving(true);
      const tick = (time) => {
        const linear = Math.min(1, (time - startedAt) / duration);
        const eased = movementEase(linear);
        const next = playerPointAlongPath(path, eased);
        const nextFacing = headingForPath(path, linear, facingRef.current);
        facingRef.current = nextFacing;
        previousPoint.current = next;
        setVisualPosition(next);
        setFacing(nextFacing);
        if (linear < 1) frame.current = requestAnimationFrame(tick);
        else {
          previousPoint.current = destination;
          setVisualPosition(destination);
          setFacing(headingForPath(path, 1, nextFacing));
          setMoving(false);
        }
      };
      frame.current = requestAnimationFrame(tick);
    };
    if (delayMs > 0) delayTimer = setTimeout(start, delayMs);
    else start();
    return () => {
      if (delayTimer) clearTimeout(delayTimer);
      cancelAnimationFrame(frame.current);
    };
  }, [targetKey, wallKey, plannedPathKey, delayMs]);

  const label = player.label || player.id;
  const locationLabel = !position ? "location unavailable" : stale ? "last scan is stale" : "last scan confirmed";
  return h("div", {
    className: cx("tracked-player", `player-team-${team}`, hasPlate && "has-plate", moving && "is-moving", stale && "is-stale", tourTarget && "is-tour-target"),
    style: { left: `${visualPosition.x}%`, top: `${visualPosition.y}%` },
    "data-player": player.id,
    "data-tour-target": tourTarget ? "player" : undefined,
    "data-stale": stale,
    "data-player-path": "barrier-safe",
    "data-path-strategy": pathStrategy,
    "aria-label": `${player.name || label}, ${locationLabel}`,
  },
    h("div", { className: "player-token" },
    h("div", { className: "player-avatar", style: { transform: `rotate(${facing}deg)` } },
      h("img", { className: "player-chef-art", src: hasPlate ? chefArt.holdBack : playerChefAsset(player), alt: "" }),
      hasPlate && plateArt && h("img", { className: "player-plate-sprite", "data-plate-sprite": plateCombo ? "combo" : "base", src: plateArt, alt: `${label} plate: ${plateItems.join(", ") || "empty"}` }),
      hasPlate && h("img", { className: "player-chef-art player-chef-hold-front", src: chefArt.holdFront, alt: "" }),
      hasPlate && !plateCombo && h(PlateIngredients, { ingredients: plateItems, stage: "plated", className: "player-plate-ingredients", label: `${label} plate: ${plateItems.join(", ") || "empty"}` }),
      !hasPlate && heldItems.length > 0 && h("div", { className: "player-held-item", "aria-label": `${label} is holding ${heldItems[0]}` }, h(IngredientIcon, { value: heldItems[0], stage: "plated" })),
    ),
    (() => {
      const bubble = actionBubble(player, now);
      return bubble && h("span", { className: cx("player-action-bubble", `is-${bubble.tone}`), role: "status", "data-player-action": bubble.text }, bubble.text);
    })(),
    h("span", { className: "player-tag" }, label),
  ));
}

function RoomSurface({ state, now, gameplay = false, tourFocus = [] }) {
  const plan = state.floorPlan || {};
  const accepted = plan.accepted === true;
  const layoutFromImage = plan.layoutFromImage === true;
  // Exact id first; a Pi `stove` tile falls back to `stove-left`/`stove-right`, etc.
  const runtimeStations = matchRuntimeStations(plan.stations, state.stations);
  const movementWalls = [
    ...(plan.walls || []),
    ...(plan.stations || [])
      .filter((station) => station?.blocksMovement !== false)
      .map((station) => ({
        ...station,
        // The adapter keeps the source rectangle for review, but the equal
        // display tile is what the player can actually see and must avoid.
        ...(station.display || {}),
        id: `${station.id || "station"}-collision`,
      })),
  ];
  const previousTargets = React.useRef(new Map());
  const walls = (plan.walls || []).map((wall, index) => h("div", {
    key: `wall-${index}`,
    className: cx("kitchen-barrier", /-wall$/.test(wall.id || "") && "is-room-wall"),
    style: rectStyle(wall),
    "data-barrier": wall.id || index,
    "aria-hidden": true,
  }));
  const stations = (plan.stations || []).map((station) => {
    const tourTarget = tourFocus.some((target) => target === station.id || target === station.kind || target === station.assetKey?.toLowerCase());
    return h("div", {
      key: station.id,
      className: cx("room-station", gameplay ? "room-station-gameplay" : "room-station-setup", stationClass(station.kind), stationGridClass(station, plan.grid), tourTarget && "is-tour-target"),
      style: rectStyle(station.display || station),
      "data-station": station.id,
      "data-tour-target": tourTarget ? "station" : undefined,
      "data-grid-cell": station.grid ? `${station.grid.column}:${station.grid.row}` : undefined,
    }, h(StationContents, { station, runtimeStation: runtimeStations.get(station.id), serving: state.serving }));
  });
  const playersAreTourTarget = tourFocus.includes("players") || tourFocus.includes("player");
  const activePlayerCount = Math.max(1, Math.min(3, Math.floor(Number(state.playerCount) || 3)));
  const displayedPlayers = gameplay ? (state.players || []).slice(0, activePlayerCount) : (state.players || []);
  const positionedPlayers = separatePlayerPositions(displayedPlayers, movementWalls);
  const planningPlayers = positionedPlayers
    .filter((player) => player?.position)
    .map((player) => ({
      ...player,
      position: previousTargets.current.get(player.id) || player.position,
      targetPosition: player.position,
    }));
  const pathPlans = planPlayerPaths(planningPlayers, movementWalls);
  positionedPlayers.forEach((player) => {
    if (player?.position) previousTargets.current.set(player.id, player.position);
  });
  const players = positionedPlayers.map((player) => {
    const position = playerPosition(player);
    const stale = !position || isStale(player, now);
    const pathPlan = pathPlans.get(player.id);
    return position ? h(AnimatedPlayer, {
      key: player.id,
      player,
      position,
      walls: movementWalls,
      stale,
      tourTarget: playersAreTourTarget,
      plannedPath: pathPlan?.path,
      delayMs: pathPlan?.delayMs,
      pathStrategy: pathPlan?.strategy,
      now,
    }) : h("div", {
      key: player.id,
      className: "tracked-player is-stale",
      "data-player": player.id,
      "data-stale": true,
      "aria-label": `${player.name || player.label || player.id}, location unavailable`,
    });
  });
  return h("div", {
    className: cx("floor-plan", layoutFromImage ? "image-derived-layout" : "standard-layout", accepted ? "is-accepted" : "is-proposed", gameplay && "gameplay-surface"),
    style: layoutFromImage && accepted ? { backgroundImage: "linear-gradient(rgba(8,16,25,.08), rgba(8,16,25,.12)), url('/assets/game-room-background.png')" } : undefined,
    "data-layout-source": layoutFromImage ? "image" : "fixed",
    "data-grid-columns": plan.grid?.columns,
    "data-grid-rows": plan.grid?.rows,
    role: "img",
    "aria-label": `${accepted ? "Accepted burger" : "Proposed room"} top-down kitchen with scan-animated players`,
  }, !layoutFromImage && h("div", { className: "kitchen-floor", "aria-hidden": true }), !gameplay && h("div", { className: "room-plan-grid", "aria-hidden": true }), walls, stations, players);
}

function RoomStage({ state, now, gameplay = false, tourFocus = [] }) {
  return h("div", { className: cx("room-stage", gameplay && "room-stage-gameplay") }, h(RoomSurface, { state, now, gameplay, tourFocus }));
}

function rectStyle(item) {
  const x = clamp(item?.x);
  const y = clamp(item?.y);
  const width = Math.min(clamp(item?.width, 1, 100), Math.max(1, 100 - x));
  const height = Math.min(clamp(item?.height, 1, 100), Math.max(1, 100 - y));
  return { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` };
}

function stationClass(kind) {
  if (kind === "ingredient") return "station-ingredient";
  if (kind === "chop") return "station-chop";
  if (kind === "stove" || kind === "pot") return "station-stove";
  if (kind === "assembly") return "station-assembly";
  return "station-delivery";
}

function TimerCard({ state, compact = false }) {
  const clock = state.clock || {};
  return h("div", { className: cx("hud-timer", compact && "hud-timer-compact"), "data-node-id": "20:2", "aria-label": `Round timer ${seconds(clock.remainingSeconds)}` },
    h("div", { className: "hud-timer-rail", "aria-hidden": true }, h("div", { className: "hud-timer-bezel" }), h("div", { className: "hud-timer-sheen" })),
    h("img", { className: "hud-timer-icon", src: "/assets/timer-stopwatch.svg", alt: "" }),
    h("strong", { className: "hud-timer-value" }, seconds(clock.remainingSeconds)),
  );
}

function IngredientIcon({ value, stage = "raw" }) {
  // Every caller (.station-plate img, .hud-ingredient-slot img) already sets
  // its own explicit width/height/object-fit for this <img> based on its own
  // slot, so this intentionally sets no size of its own (a fixed Tailwind
  // h-*/w-* class here previously fought that per-slot sizing).
  const kind = ingredientNames(value)[0];
  const resolved = ingredientStage(value, stage === "plated" ? platedStage(kind) : stage);
  const source = kind ? ingredientSprite(kind, resolved) : null;
  return source ? h("img", { className: "object-contain", src: source, alt: upper(value), "data-ingredient-stage": resolved, loading: "lazy" }) : h("span", { className: "text-xs font-black text-[#8e7664]" }, upper(value).slice(0, 3));
}

// A single pre-drawn burger icon (not an assembled stack of the individual
// ingredient PNGs) — this card is a "this order is a burger" glance icon;
// the exact required components are already listed explicitly right next to
// it in .hud-ingredient-slots, so the preview doesn't need to reconstruct the
// recipe pixel-by-pixel. Art: Kenney "Pixel Platformer: Food Expansion"
// (kenney.nl), CC0.
const BURGER_PREVIEW_SRC = "/assets/order-burger.png";

function BurgerPreview({ order, components }) {
  const title = orderTitle(order);
  const recipe = components.length ? components.map((item) => upper(item)).join(", ") : "BUN";
  return h(
    "div",
    {
      className: "hud-order-preview",
      "data-burger-preview": order.id,
      role: "img",
      "aria-label": `${title} assembled burger: ${recipe}`,
    },
    h("img", { className: "burger-preview-art", src: BURGER_PREVIEW_SRC, alt: "" }),
  );
}

function OrderCard({ order, compact = false, tourTarget = false }) {
  const components = Array.isArray(order.components) ? order.components.slice(0, 4) : [];
  const remaining = Number(order.remainingSeconds);
  const total = Number(order.totalSeconds);
  const progress = Number.isFinite(remaining) && Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  // Urgency is a share of this order's own patience (the Pi's orders run 8-35 s,
  // the mock's 120 s): the last third is critical, the middle third a warning.
  // Falls back to the Pi's 3-segment meter only when no total is supplied.
  const segments = Number(order.patience?.filledSegments);
  const urgency = total > 0 && Number.isFinite(remaining)
    ? remaining * 3 <= total ? "is-critical" : remaining * 3 <= total * 2 ? "is-warning" : "is-healthy"
    : order.patience?.filledSegments != null && Number.isFinite(segments)
      ? segments <= 1 ? "is-critical" : segments === 2 ? "is-warning" : "is-healthy"
      : "is-healthy";
  return h("section", { className: cx("hud-order", compact && "hud-order-compact", urgency, tourTarget && "is-tour-target"), "data-node-id": "39:26", "data-order-id": order.id, "data-tour-target": tourTarget ? "order" : undefined, "aria-label": `${orderTitle(order)} order` },
    h(BurgerPreview, { order, components }),
    h("div", { className: "hud-order-main" },
      h("div", { className: "hud-ingredient-slots", "aria-label": `Assembly order: ${components.map((item) => upper(item)).join(", ")}` }, components.map((item, index) => h("div", { key: `${item}-${index}`, className: "hud-ingredient-slot", "data-ingredient-slot": index + 1, "aria-label": `${index + 1}. ${upper(item)}` }, h(IngredientIcon, { value: item, stage: "plated" })))),
    ),
    h("div", { className: "hud-order-progress", role: "progressbar", "aria-label": `${orderTitle(order)} time remaining`, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(progress) }, h("span", { style: { width: `${progress}%` } })),
  );
}

// The strip always has four slots, so a card is the same size whether one order
// or four are open; cards fill from the left and the rest stay empty.
function OrdersHud({ state, tourTarget = false }) {
  const orders = activeOrdersFor(state);
  return h("div", { className: "game-board-orders orders-4", "data-order-count": orders.length, "aria-label": `${orders.length} active orders` },
    orders.length
      ? orders.map((order, index) => h(OrderCard, { key: order.id, order, compact: true, tourTarget: tourTarget && index === 0 }))
      : h("div", { className: "orders-empty" }, "All orders served!"),
  );
}

function ScoreCard({ state }) {
  const score = state.score || {};
  const value = Number(score.value) || 0;
  return h("div", { className: "board-score", "data-node-id": "31:25", "aria-label": `${value} WatCoins, ${score.delivered ?? 0} burgers served` },
    h("img", { src: "/assets/score-coin-counter.png", alt: "", "aria-hidden": true }),
    h("strong", { className: cx("board-score-value", value < 0 && "is-negative") }, value),
  );
}

// How long a submission result stays on screen. Purely a display-lifetime
// constant — computed from `now` vs. the event's own timestamp rather than
// local state, so it needs no timers and just stops rendering once stale.
const DELIVERY_TOAST_LIFETIME_MS = 3200;

// The two submission outcomes documented in README.md ("Submission
// behavior"): a correct plate reports gold plus a tip that scales with how
// much patience was left (the order's 3-segment meter — see
// mock-transport.js's orderTip()/patience.filledSegments, ported from
// pi/server's projection.mjs), or a wrong plate applies a penalty. This is
// the live, in-round version of that result; The results screen shows the round's
// totals after it ends.
// An order that ran out of patience is charged a penalty by the server and
// simply leaves the active list; without a cue the card just vanishes.
const orderExpiredAt = (order) => timestampMs(order?.expiredAt ?? order?.deadlineAt);

function recentlyExpiredOrder(state, now) {
  const history = Array.isArray(state.orderHistory) && state.orderHistory.length ? state.orderHistory : (state.orders || []);
  let latest = null;
  let latestAt = -Infinity;
  for (const order of history) {
    if (String(order?.status || "").toLowerCase() !== "expired") continue;
    const at = orderExpiredAt(order);
    const age = at == null ? NaN : Number(now) - at;
    if (age >= 0 && age <= DELIVERY_TOAST_LIFETIME_MS && at > latestAt) {
      latest = order;
      latestAt = at;
    }
  }
  return latest;
}

// The newest thing that just changed the WatCoin total (a served burger, a wrong
// plate, or an expired order), with its signed amount. The toast explains it and
// the coin counter floats the same amount, so a penalty is visibly coins lost.
function latestScoreEvent(state, now) {
  const found = [];
  const event = state.serving?.lastEvent;
  const eventAt = timestampMs(event?.at);
  const age = eventAt == null ? NaN : Number(now) - eventAt;
  if (event && age >= 0 && age <= DELIVERY_TOAST_LIFETIME_MS) {
    const success = event.status === "success";
    found.push({ kind: "submission", at: eventAt, event, delta: success ? (Number(event.gold) || 0) + (Number(event.tip) || 0) : -(Number(event.penalty) || 0) });
  }
  const expired = recentlyExpiredOrder(state, now);
  if (expired) found.push({ kind: "expired", at: orderExpiredAt(expired), order: expired, delta: -(Number(expired.penalty) || 0) });
  return found.sort((a, b) => b.at - a.at)[0] || null;
}

// "BURGER SERVED" -> "Burger served": the server shouts, the screen shouldn't.
const sentenceCase = (text) => {
  const value = String(text || "").toLowerCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
};

// Bottom-centre announcement, styled like the WatCoin and clock pills it sits
// between. It always names the coins ("+100 WatCoins", "-25 WatCoins"); a served
// burger adds its tip as a smaller second figure.
function DeliveryToast({ state, now }) {
  const latest = latestScoreEvent(state, now);
  if (!latest) return null;
  const expired = latest.kind === "expired";
  const success = !expired && latest.event.status === "success";
  const message = expired ? "Order expired" : sentenceCase(latest.event.message);
  const key = expired ? `expired-${latest.order.id}` : latest.event.at;
  const coins = success ? Number(latest.event.gold) || 0 : -Math.abs(Number(expired ? latest.order.penalty : latest.event.penalty) || 0);
  const tip = success ? Number(latest.event.tip) || 0 : 0;
  return h("div", { className: "game-board-toast" },
    h("div", { key, className: cx("delivery-toast", success ? "is-success" : "is-failure", expired && "is-expired"), role: "status", "aria-live": "polite" },
      h("span", { className: "delivery-toast-message" }, message),
      coins !== 0 && h("span", { className: "delivery-toast-amount" }, `${coins > 0 ? "+" : "-"}${Math.abs(coins)} WatCoins`),
      tip > 0 && h("span", { className: "delivery-toast-tip" }, `+${tip} tip`),
    ),
  );
}

function GameplayBoard({ state, now }) {
  return h("section", { className: "game-board panel overflow-hidden bg-[#0c1824]", "aria-labelledby": "game-board-title" },
    h("h2", { id: "game-board-title", className: "sr-only" }, "Live burger game board"),
    h("div", { className: "game-board-canvas relative h-full min-h-0 w-full overflow-hidden bg-[#0c1824]" },
      h(RoomStage, { state, now, gameplay: true }),
      h(OrdersHud, { state }),
      h(DeliveryToast, { state, now }),
      h("div", { className: "game-board-score" }, h(ScoreCard, { state })),
      h("div", { className: "game-board-timer" }, h(TimerCard, { state, compact: true })),
    ),
  );
}

function SetupView({ state, now, onCommand, transportKind, onUploadPhotos, uploadStatus }) {
  const accepted = state.floorPlan?.accepted === true;
  // The room map already draws every station at its approved position with
  // its own label (see RoomSurface), so a separate "Kitchen pieces" checklist
  // next to it was just restating the same nine labels as a plain text list —
  // dropped in favor of letting the map be the single placement reference.
  return h("div", { className: "setup-flow" },
    h(HostPanel, { state, onCommand }),
    h("div", { className: "setup-workspace" },
      h("section", { className: "setup-card map-card", "aria-labelledby": "map-title" }, h("div", { className: "map-heading" }, h("div", null, h("p", { className: "setup-kicker" }, accepted ? "Layout ready" : "Room map"), h("h2", { id: "map-title" }, accepted ? "Your burger kitchen" : "Room map loading")), h("span", { className: cx("map-state", accepted && "is-ready") }, accepted ? "Ready to place" : "Mapping")), h("p", null, accepted ? "Match each printed ingredient and station to its labelled spot on the map below. Keep chopping boards and stoves still once the round begins." : "The room map is being prepared. Follow the floor walkthrough when it is ready."), transportKind === "http" && h("div", { className: "server-photo-upload" }, h("label", { htmlFor: "room-photo-input" }, "Room photos are uploaded from the phone to the game server"), h("input", { id: "room-photo-input", type: "file", accept: "image/*", multiple: true, onChange: (event) => onUploadPhotos?.(event.target.files) }), uploadStatus && h("span", { role: "status" }, uploadStatus)), h("div", { className: "map-frame" }, h(RoomStage, { state, now }))),
    ),
  );
}

function OnboardingView({ state, onCommand }) {
  return h("main", { className: "onboarding-screen", "data-onboarding": "welcome", "aria-labelledby": "onboarding-title" },
    h("div", { className: "onboarding-content" },
      h("div", { className: "onboarding-copy" },
        h("h1", { id: "onboarding-title", className: "onboarding-logo" },
          h("img", { src: "/assets/undercooked-logo.png", alt: "UnderCooked!" }),
        ),
        h("p", null, "Overcooked, but IRL (and with geese)"),
        h("strong", null, "A Cooperative Burger Game!"),
      ),
      h("button", {
        type: "button",
        className: "onboarding-button",
        disabled: !canRunAction(state, GAME_ACTIONS.START_HOST),
        "data-command": GAME_ACTIONS.START_HOST,
        onClick: () => onCommand?.(GAME_ACTIONS.START_HOST),
      }, "Get Started"),
    ),
  );
}

function playerSlotNumber(player) {
  const raw = player?.playerNumber ?? player?.slot ?? player?.id ?? player?.label;
  const match = String(raw || "").match(/[123]/);
  return match ? Number(match[0]) : null;
}

function playerConnectionStatus(player) {
  if (!player) return "waiting";
  const explicit = String(player?.connection?.status || "").toLowerCase();
  if (explicit) return explicit;
  if (Object.prototype.hasOwnProperty.call(player || {}, "ready")) return player.ready === true ? "ready" : "waiting";
  if (Object.prototype.hasOwnProperty.call(player || {}, "connected")) return player.connected === true ? "connected" : "waiting";
  if (Object.prototype.hasOwnProperty.call(player || {}, "badgeMac")) return player.badgeMac ? "connected" : "waiting";
  const legacy = String(player?.status || "").toLowerCase();
  if (legacy) return legacy;
  return "legacy-ready";
}

function playerIsReady(player) {
  return ["ready", "connected", "online", "healthy", "legacy-ready"].includes(playerConnectionStatus(player));
}

function playersForSlots(state) {
  const players = Array.isArray(state?.players) ? state.players : [];
  return [1, 2, 3].map((slot) => players.find((player) => playerSlotNumber(player) === slot) || null);
}

function roomPhotoCount(state) {
  const floorPlanCount = Number(state?.floorPlan?.photoCount);
  if (Number.isFinite(floorPlanCount) && floorPlanCount > 0) return Math.floor(floorPlanCount);
  const photosCount = Array.isArray(state?.photos) ? state.photos.length : Number.NaN;
  if (Number.isFinite(photosCount) && photosCount > 0) return photosCount;
  const setupCount = Number(state?.setup?.photoCount);
  return Number.isFinite(setupCount) && setupCount > 0 ? Math.floor(setupCount) : 0;
}

function PlayerReadinessCard({ slot, player }) {
  const status = playerConnectionStatus(player);
  const ready = playerIsReady(player);
  const label = player?.name || `PLAYER ${slot}`;
  const statusLabel = status === "offline" || status === "lost" || status === "failed"
    ? "CONNECTION LOST"
    : status === "connected" || status === "online" || status === "healthy"
      ? "CONNECTED"
      : status === "ready" || status === "legacy-ready"
        ? "READY"
        : "WAITING FOR CONTROLLER";
  return h("div", {
    className: cx("player-readiness-card", !ready && "is-unavailable", `is-${status}`),
    "data-player-slot": String(slot),
    "data-player-ready": ready ? "true" : "false",
    "data-player-status": status,
    role: "status",
    "aria-label": `${label}: ${statusLabel.toLowerCase()}`,
  },
    h("div", { className: "player-readiness-main" },
      h("span", { className: "player-readiness-icon" }, h("img", { src: playerChefAsset(player || { color: "green" }), alt: "" })),
      h("span", { className: "player-readiness-copy" },
        h("strong", null, `PLAYER ${slot}`),
        h("span", null, statusLabel),
      ),
    ),
  );
}

function RoomPhotoUpload({ state, uploadStatus }) {
  const count = roomPhotoCount(state);
  return h("section", { className: "room-upload", "aria-labelledby": "room-upload-title" },
    h("div", { className: "room-upload-copy" },
      h("h2", { id: "room-upload-title" }, "Room photos"),
      h("p", null, count >= 3 ? `${count} photos received. The server is ready to map the room.` : `${count} photos received. Waiting for the room upload.`),
      uploadStatus && h("span", { className: "room-upload-status", role: "status" }, uploadStatus),
    ),
  );
}

function PlayerSetupView({ state, onCommand, onGenerateLayout, onUseDefaultLayout, transportKind, onUploadPhotos, uploadStatus, connectionError }) {
  const players = playersForSlots(state);
  const readyCount = players.filter(playerIsReady).length;
  const photoCount = roomPhotoCount(state);
  const hasMinimumPlayers = readyCount >= 1;
  const personalizedReady = transportKind === "http" && photoCount >= 3;
  const failed = Boolean(connectionError) || /failed|unavailable|error/i.test(String(uploadStatus || ""));
  const personalizedFirst = personalizedReady && !failed;
  const canScan = canRunAction(state, GAME_ACTIONS.SCAN_ROOM);
  const canContinue = hasMinimumPlayers && canScan;
  const personalizedAction = onGenerateLayout || (() => onCommand?.(GAME_ACTIONS.SCAN_ROOM));
  const defaultAction = onUseDefaultLayout || (() => onCommand?.(GAME_ACTIONS.SCAN_ROOM));
  const primaryAction = () => personalizedFirst ? personalizedAction() : defaultAction();
  return h("main", { className: "onboarding-screen player-setup-screen", "data-onboarding": "players", "aria-labelledby": "player-setup-title" },
    h("div", { className: "player-setup-content" },
      h("div", { className: "onboarding-copy player-setup-heading" },
        h("h1", { id: "player-setup-title" }, "Get your kitchen ready"),
      ),
      h("section", { className: "player-readiness", "aria-label": "Player readiness" },
        h("p", null, `${readyCount} of 3 players connected · minimum 1`),
        h("div", { className: "player-readiness-list" }, players.map((player, index) => h(PlayerReadinessCard, { key: index, slot: index + 1, player }))),
      ),
      h(RoomPhotoUpload, { state, uploadStatus }),
      h("div", { className: "player-setup-layout-actions" },
        h("button", {
          type: "button",
          className: "onboarding-button player-setup-continue",
          disabled: !canContinue,
          "data-command": GAME_ACTIONS.SCAN_ROOM,
          onClick: primaryAction,
        }, personalizedFirst ? "Continue with Personalized Room Layout" : "Continue with Normal Room Layout"),
        personalizedFirst && h("button", {
          type: "button",
          className: "onboarding-button onboarding-button-secondary player-setup-default-layout",
          disabled: !canContinue,
          onClick: () => defaultAction(),
        }, "Use Normal Room Layout"),
        // The personalized layout failed: the normal one is offered first, but the
        // personalized one is never taken away, so it can be retried.
        personalizedReady && failed && h("button", {
          type: "button",
          className: "onboarding-button onboarding-button-secondary player-setup-retry-personalized",
          disabled: !canContinue,
          onClick: () => personalizedAction(),
        }, "Try the personalized layout again"),
        // Waiting for badges must never be the only way forward: the round starts from
        // the host badge anyway, so players can connect after this screen.
        !hasMinimumPlayers && canScan && h("p", { className: "player-setup-note" }, "No badges are connected yet. You can continue now and connect them before pressing START on the host badge."),
        !hasMinimumPlayers && canScan && h("button", {
          type: "button",
          className: "onboarding-button onboarding-button-secondary player-setup-continue-anyway",
          "data-command": GAME_ACTIONS.SCAN_ROOM,
          onClick: primaryAction,
        }, "Continue anyway"),
      ),
    ),
  );
}

const TOUR_SOURCE_IDS = Object.freeze({
  BUN: "buns-source",
  LETTUCE: "lettuce-source",
  CHEESE: "cheese-source",
  MEAT: "meat-source",
});

const TOUR_INGREDIENT_LABELS = Object.freeze({ BUN: "bun", LETTUCE: "lettuce", CHEESE: "cheese", MEAT: "meat" });

function tourIngredients(order) {
  const components = Array.isArray(order?.components) && order.components.length ? order.components : TOUR_PREVIEW_ORDER.components;
  return [...new Set(components.map(ingredientKey).filter((key) => TOUR_INGREDIENT_LABELS[key]))];
}

function stationIdsForTour(plan, kind, fallback) {
  const ids = (plan?.stations || []).filter((station) => station.kind === kind).map((station) => station.id);
  return ids.length ? ids : fallback;
}

function sourceIdsForTour(plan, ingredients) {
  const stations = Array.isArray(plan?.stations) ? plan.stations : [];
  const resolved = ingredients.flatMap((ingredient) => {
    const exactId = TOUR_SOURCE_IDS[ingredient];
    if (stations.some((station) => station.id === exactId)) return [exactId];
    const assetKey = ["BUN", "LETTUCE"].includes(ingredient) ? "PANTRY" : "FRIDGE";
    return stations
      .filter((station) => station.kind === "ingredient"
        && (String(station.assetKey || "").toUpperCase() === assetKey
          || String(station.id || "").toLowerCase() === assetKey.toLowerCase()))
      .map((station) => station.id);
  });
  return [...new Set(resolved)];
}

export function tourStepsForOrder(order, plan) {
  const ingredients = tourIngredients(order);
  const pantry = ingredients.filter((item) => ["BUN", "LETTUCE"].includes(item)).map((item) => TOUR_INGREDIENT_LABELS[item]);
  const fridge = ingredients.filter((item) => ["CHEESE", "MEAT"].includes(item)).map((item) => TOUR_INGREDIENT_LABELS[item]);
  const sourceFocus = sourceIdsForTour(plan, ingredients);
  const fallbackSources = (plan?.stations || []).filter((station) => station.kind === "ingredient").map((station) => station.id);
  // The server's rooms have no assembly counter: per the v1 rules a plate is taken
  // at the pantry (Down + scan), so that is where this step points.
  const assemblyStations = stationIdsForTour(plan, "assembly", null);
  const pantryStations = (plan?.stations || [])
    .filter((station) => station.kind === "ingredient" && /PANTRY/i.test(`${station.assetKey || ""} ${station.id || ""}`))
    .map((station) => station.id);
  return [
    {
      key: "orders",
      title: "Read the order",
      detail: "The leftmost card is your recipe. Its icons show what to grab.",
      control: "Start with the first card at the top.",
      focus: [],
      target: "order",
    },
    {
      key: "sources",
      title: "Grab ingredients",
      detail: `${pantry.length ? `Pantry: ${pantry.join(" + ")}` : ""}${pantry.length && fridge.length ? " · " : ""}${fridge.length ? `Fridge: ${fridge.join(" + ")}` : ""}` || "Use the sources named by the order.",
      control: "In game: choose with Left / Right, then scan the source.",
      focus: sourceFocus.length ? sourceFocus : fallbackSources.length ? fallbackSources : ["pantry", "fridge"],
      target: "station",
    },
    {
      key: "chop",
      title: "Chop what needs chopping",
      detail: "Bring the raw ingredient to a cutting board.",
      control: "In game: hold A while scanning the board.",
      focus: stationIdsForTour(plan, "chop", ["cutting-board"]),
      target: "station",
    },
    {
      key: "stove",
      title: "Cook the meat",
      detail: "Only chopped meat goes on a stove.",
      control: "In game: choose a burner, scan it, and cook for 15 seconds.",
      focus: stationIdsForTour(plan, "stove", ["stove-left", "stove-right", "stove"]),
      target: "station",
    },
    {
      key: "assembly",
      title: "Build the order",
      detail: assemblyStations ? "Use a plate and match the leftmost card." : "Take a plate at the pantry and match the leftmost card.",
      control: assemblyStations
        ? "In game: scan the plate to add the order's ingredients."
        : "In game: press Down while scanning the pantry for a plate, then add the ingredients.",
      focus: assemblyStations || (pantryStations.length ? pantryStations : fallbackSources.length ? fallbackSources : ["pantry"]),
      target: "station",
    },
    {
      key: "submit",
      title: "Submit together",
      detail: "The plate-holder holds A and shakes. Everyone else shakes too.",
      control: "In game: all connected players shake at the same time.",
      focus: ["players"],
      target: "players",
    },
  ];
}

export function measureTourTargets(board, step) {
  if (!board || typeof board.getBoundingClientRect !== "function") return null;
  const boardRect = board.getBoundingClientRect();
  if (!(boardRect.width > 0) || !(boardRect.height > 0)) return null;
  const selector = step.target === "order"
    ? '[data-tour-target="order"]'
    : step.target === "players"
      ? '[data-tour-target="player"]'
      : '[data-tour-target="station"]';
  const padding = step.target === "order" ? 8 : 10;
  const rects = [...board.querySelectorAll(selector)]
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: Math.max(0, rect.left - boardRect.left - padding),
        top: Math.max(0, rect.top - boardRect.top - padding),
        right: Math.min(boardRect.width, rect.right - boardRect.left + padding),
        bottom: Math.min(boardRect.height, rect.bottom - boardRect.top + padding),
      };
    })
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
  if (!rects.length) return { stepKey: step.key, width: boardRect.width, height: boardRect.height, rects: [], bounds: null, signature: "empty" };
  const bounds = rects.reduce((result, rect) => ({
    left: Math.min(result.left, rect.left),
    top: Math.min(result.top, rect.top),
    right: Math.max(result.right, rect.right),
    bottom: Math.max(result.bottom, rect.bottom),
  }), { left: boardRect.width, top: boardRect.height, right: 0, bottom: 0 });
  const signature = `${Math.round(boardRect.width)}:${Math.round(boardRect.height)}:${rects.map((rect) => Object.values(rect).map((value) => Math.round(value)).join(",")).join("|")}`;
  return { stepKey: step.key, width: boardRect.width, height: boardRect.height, rects, bounds, signature };
}

// What the tour uses when a step cannot be measured (board is 0x0, hidden, or
// measuring threw): "nothing to point at", which shows the card centred.
export function unmeasuredTargetInfo(step) {
  return { stepKey: step.key, width: 1, height: 1, rects: [], bounds: null, signature: `unmeasured:${step.key}` };
}

// Never lets a failed measurement leave the tour without an answer: the card's
// buttons only appear once the step has *some* target info.
export function resolveTourTargetInfo(board, step) {
  let measured = null;
  try {
    measured = measureTourTargets(board, step);
  } catch {
    measured = null;
  }
  return measured || unmeasuredTargetInfo(step);
}

// If neither a measurement nor a placement has revealed the card by now, show it
// anyway (centred): the buttons are inside it.
export const TOUR_REVEAL_FALLBACK_MS = 600;

function rectanglesOverlap(left, right) {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function nearestTourRect(rects, point) {
  return rects.reduce((best, rect) => {
    const center = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    const distance = Math.hypot(center.x - point.x, center.y - point.y);
    return !best || distance < best.distance ? { rect, distance } : best;
  }, null)?.rect || rects[0];
}

function placeTourCard(targetInfo, cardWidth, cardHeight) {
  if (!targetInfo?.bounds || !targetInfo.rects?.length) return null;
  const { width: boardWidth, height: boardHeight, bounds } = targetInfo;
  const gap = 16;
  const margin = 16;
  const targetCenter = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
  const preferred = targetCenter.x < boardWidth * .45 ? "right" : targetCenter.x > boardWidth * .55 ? "left" : targetCenter.y < boardHeight * .5 ? "bottom" : "top";
  const candidates = [
    { side: "right", x: bounds.right + gap, y: targetCenter.y - cardHeight / 2 },
    { side: "left", x: bounds.left - gap - cardWidth, y: targetCenter.y - cardHeight / 2 },
    { side: "bottom", x: targetCenter.x - cardWidth / 2, y: bounds.bottom + gap },
    { side: "top", x: targetCenter.x - cardWidth / 2, y: bounds.top - gap - cardHeight },
  ].map((candidate) => {
    const x = Math.max(margin, Math.min(boardWidth - cardWidth - margin, candidate.x));
    const y = Math.max(margin, Math.min(boardHeight - cardHeight - margin, candidate.y));
    const cardRect = { left: x, top: y, right: x + cardWidth, bottom: y + cardHeight };
    const overflow = Math.max(0, margin - candidate.x) + Math.max(0, candidate.x + cardWidth - boardWidth + margin)
      + Math.max(0, margin - candidate.y) + Math.max(0, candidate.y + cardHeight - boardHeight + margin);
    const overlap = rectanglesOverlap(cardRect, bounds) ? 10_000 : 0;
    const preference = candidate.side === preferred ? 0 : 160;
    return { ...candidate, x, y, score: overflow * 40 + overlap + preference };
  }).sort((left, right) => left.score - right.score)[0];
  if (!candidates) return null;
  const anchorRect = nearestTourRect(targetInfo.rects, { x: candidates.x + cardWidth / 2, y: candidates.y + cardHeight / 2 });
  const anchor = { x: (anchorRect.left + anchorRect.right) / 2, y: (anchorRect.top + anchorRect.bottom) / 2 };
  const pointerOffset = candidates.side === "right" || candidates.side === "left"
    ? Math.max(28, Math.min(cardHeight - 28, anchor.y - candidates.y))
    : Math.max(28, Math.min(cardWidth - 28, anchor.x - candidates.x));
  const pointerSide = candidates.side === "right" ? "left" : candidates.side === "left" ? "right" : candidates.side === "bottom" ? "top" : "bottom";
  return { ...candidates, pointerSide, pointerOffset };
}

function tourOverlayPath(targetInfo) {
  const width = targetInfo?.width || 1;
  const height = targetInfo?.height || 1;
  const outer = `M0 0H${width}V${height}H0Z`;
  const holes = (targetInfo?.rects || []).map((rect) => `M${rect.left} ${rect.top}H${rect.right}V${rect.bottom}H${rect.left}Z`).join(" ");
  return `${outer} ${holes}`;
}

function TourWalkthrough({ steps, step, targetInfo, onStepChange, onCommand }) {
  const current = steps[step] || steps[0];
  const finalStep = step === steps.length - 1;
  const activeTargetInfo = targetInfo?.stepKey === current.key ? targetInfo : null;
  const cardRef = React.useRef(null);
  const [placement, setPlacement] = React.useState(null);
  const [revealed, setRevealed] = React.useState(false);

  React.useEffect(() => {
    setRevealed(false);
    const timer = setTimeout(() => setRevealed(true), TOUR_REVEAL_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [step]);

  React.useEffect(() => {
    const card = cardRef.current;
    const board = card?.closest(".tour-game-board");
    if (!card || !board || !activeTargetInfo?.bounds) {
      setPlacement(null);
      return undefined;
    }
    const cardRect = card.getBoundingClientRect();
    const next = placeTourCard(activeTargetInfo, cardRect.width, cardRect.height);
    setPlacement(next);
    return undefined;
  }, [step, activeTargetInfo?.signature]);

  const renderPlacement = activeTargetInfo?.bounds ? placement : null;
  // Measured but nothing to point at: show the card centred rather than keeping it
  // hidden (its buttons are inside it, so a hidden card strands the tour).
  const noTarget = Boolean(activeTargetInfo) && !activeTargetInfo.bounds;
  const ready = Boolean(renderPlacement) || noTarget || revealed;

  // Put keyboard focus on the main button once the card is showing, so Enter works.
  React.useEffect(() => {
    if (ready) cardRef.current?.querySelector(".tour-primary-button")?.focus?.({ preventScroll: true });
  }, [ready, step]);
  const cardStyle = renderPlacement
    ? { left: `${renderPlacement.x}px`, top: `${renderPlacement.y}px`, "--tour-pointer-offset": `${renderPlacement.pointerOffset}px` }
    : undefined;
  const path = tourOverlayPath(activeTargetInfo);
  return h("div", { className: "tour-guide-layer", role: "dialog", "aria-modal": "true", "aria-labelledby": "tour-step-title", "aria-describedby": "tour-step-detail" },
    h("div", { className: "tour-guide-wash", "aria-hidden": true },
      h("svg", { className: "tour-guide-wash-svg", viewBox: `0 0 ${activeTargetInfo?.width || 1} ${activeTargetInfo?.height || 1}`, preserveAspectRatio: "none" },
        h("path", { d: path, fill: "#e6f0f4", fillOpacity: activeTargetInfo?.rects?.length ? "0.56" : "0.48", fillRule: "evenodd" }),
      ),
    ),
    h("div", {
      ref: cardRef,
      className: "tour-guide-card",
      style: cardStyle,
      "data-tour-step": current.key,
      "data-tour-placement": renderPlacement?.pointerSide || "center",
      "data-tour-region": "anchored",
      "data-tour-ready": ready ? "true" : "false",
    },
      h("p", { className: "tour-kicker" }, `Tour ${step + 1} of ${steps.length}`),
      h("h1", { id: "tour-step-title" }, current.title),
      h("p", { className: "tour-step-detail", id: "tour-step-detail" }, current.detail),
      h("p", { className: "tour-step-control" }, h("strong", null, "In game: "), current.control.replace(/^In game:\s*/i, "")),
      h("div", { className: "tour-actions tour-guide-actions" },
        h("button", {
          type: "button",
          className: "tour-primary-button",
          onClick: () => finalStep ? onCommand?.(GAME_ACTIONS.START_GAME) : onStepChange(step + 1),
        }, finalStep ? "Start Cooking" : "Next"),
        step > 0 && h("button", { type: "button", className: "tour-secondary-button", onClick: () => onStepChange(step - 1) }, "Back"),
        h("button", { type: "button", className: "tour-skip-button", "data-command": GAME_ACTIONS.START_GAME, onClick: () => onCommand?.(GAME_ACTIONS.START_GAME) }, "Skip Tour"),
      ),
    ),
    // A second way out that does not live inside the card: shown while the card
    // is not yet showing, and always on very short windows where the card can
    // be taller than the screen.
    h("button", {
      type: "button",
      className: cx("tour-escape-skip", ready && "is-redundant"),
      "data-tour-escape": "skip",
      "data-command": GAME_ACTIONS.START_GAME,
      onClick: () => onCommand?.(GAME_ACTIONS.START_GAME),
    }, "Skip tour"),
  );
}

function TourIntroView({ state, now, onCommand }) {
  const [tourStarted, setTourStarted] = React.useState(false);
  const [tourStep, setTourStep] = React.useState(0);
  const [targetInfo, setTargetInfo] = React.useState(null);
  const boardRef = React.useRef(null);
  const preview = tourPreviewState(state);
  const steps = tourStepsForOrder(preview.order, preview.floorPlan);
  const currentStep = steps[Math.min(tourStep, steps.length - 1)];

  React.useEffect(() => {
    if (!tourStarted) {
      setTargetInfo(null);
      return undefined;
    }
    const measure = () => {
      const next = resolveTourTargetInfo(boardRef.current, currentStep);
      setTargetInfo((previous) => previous && previous.stepKey === next.stepKey && previous.signature === next.signature ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === "function" && boardRef.current
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(boardRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tourStarted, tourStep, currentStep.key, currentStep.target]);

  const startTour = () => {
    setTourStep(0);
    setTourStarted(true);
  };
  return h("main", { className: "tour-screen", "data-onboarding": "tour", "aria-label": "UnderCooked interactive tour" },
    h("div", { ref: boardRef, className: cx("tour-game-board", tourStarted && "is-tour-active") },
      h(RoomStage, { state: preview, now, gameplay: true, tourFocus: tourStarted ? currentStep.focus : [] }),
      h(OrdersHud, { state: preview, tourTarget: tourStarted && currentStep.target === "order" }),
      h("div", { className: "game-board-score" }, h(ScoreCard, { state: preview })),
      h("div", { className: "game-board-timer" }, h(TimerCard, { state: preview, compact: true })),
      tourStarted
        ? h(TourWalkthrough, { steps, step: tourStep, targetInfo, onStepChange: setTourStep, onCommand })
        : h("div", { className: "tour-welcome-layer", role: "dialog", "aria-labelledby": "tour-title", "aria-modal": "true" },
          h("div", { className: "tour-welcome-content" },
            h("img", { className: "tour-burger", src: "/assets/order-burger.png", alt: "" }),
            h("h1", { id: "tour-title" }, "Welcome to ", h("strong", null, "UnderCooked Interactive Tour")),
            h("div", { className: "tour-actions" },
              h("button", { type: "button", className: "tour-primary-button", "data-tour-action": "start", autoFocus: true, onClick: startTour }, "Start Tour"),
              h("button", { type: "button", className: "tour-skip-button", "data-command": GAME_ACTIONS.START_GAME, onClick: () => onCommand?.(GAME_ACTIONS.START_GAME) }, "Skip to the Game"),
              h("button", { type: "button", className: "tour-skip-button", "data-command": GAME_ACTIONS.RESET_TO_OPENING, onClick: () => onCommand?.(GAME_ACTIONS.RESET_TO_OPENING) }, "Back to start"),
            ),
          ),
        ),
    ),
  );
}

function GameplayView({ state, now }) {
  return h(GameplayBoard, { state, now });
}

function ResultStat({ label, value, tone }) {
  return h("div", { className: cx("results-stat", tone && `is-${tone}`), "data-result-stat": label.toLowerCase().replaceAll(" ", "-") },
    h("strong", null, value),
    h("span", null, label),
  );
}

// The final card. Score, gold, tips and order outcomes are read from the
// authoritative snapshot; only the star rating is a presentation rule.
function ResultsView({ state, onCommand }) {
  const history = Array.isArray(state.orderHistory) && state.orderHistory.length ? state.orderHistory : (state.orders || []);
  const summary = summarizeOrders(history);
  const score = Number(state.score?.value) || 0;
  const served = Number(state.score?.delivered ?? summary.served) || 0;
  const maxStars = Number(state.level?.maxStars) || DEFAULT_MAX_STARS;
  const stars = calculateStarRating({ score, maxScore: summary.maxScore, maxStars });
  const penalties = state.penalties?.total;
  return h("main", { className: "onboarding-screen results-screen", "data-onboarding": "results", "aria-labelledby": "results-title" },
    h("div", { className: "results-content" },
      h("div", { className: "onboarding-copy" },
        h("h1", { id: "results-title" }, "Round complete"),
        h("p", null, state.serving?.lastEvent?.message ? `Last order: ${state.serving.lastEvent.message}` : "Great teamwork!"),
      ),
      h("div", { className: "results-stars", role: "img", "aria-label": `${stars} of ${maxStars} stars`, "data-stars": stars },
        Array.from({ length: maxStars }, (_, index) => h("span", { key: index, className: cx("results-star", index < stars && "is-earned"), "aria-hidden": true }, "★"))),
      h("div", { className: "results-score", "aria-label": `${score} WatCoins` },
        h("img", { src: "/assets/order-burger.png", alt: "" }),
        h("strong", null, score),
        h("span", null, "WatCoins"),
      ),
      h("div", { className: "results-stats" },
        h(ResultStat, { label: "Burgers served", value: served, tone: "good" }),
        summary.expired > 0 && h(ResultStat, { label: "Orders missed", value: summary.expired, tone: "bad" }),
        state.gold?.total != null && h(ResultStat, { label: "Gold", value: state.gold.total }),
        state.tips?.total != null && h(ResultStat, { label: "Tips", value: state.tips.total }),
        penalties != null && Number(penalties) > 0 && h(ResultStat, { label: "Penalties", value: `-${penalties}`, tone: "bad" }),
      ),
      h("button", {
        type: "button",
        className: "onboarding-button",
        disabled: !canRunAction(state, GAME_ACTIONS.RESET_GAME),
        "data-command": GAME_ACTIONS.RESET_GAME,
        onClick: () => onCommand?.(GAME_ACTIONS.RESET_GAME),
      }, "Play again"),
    ),
  );
}

// Shown after the UI's START_GAME while the server waits for the physical host
// badge. The round (and its timer) starts from the badge, so this screen has no
// start button of its own: it only tells the operator what to do next.
export const WAITING_HINT_MS = 20_000;

function hostConnectionCopy(state) {
  const status = String(state?.health?.gateway?.status || "unknown").toLowerCase();
  if (status === "healthy") {
    return {
      label: "Host badge connected",
      detail: "Press START on the badge. The game will begin here automatically.",
      className: "is-connected",
    };
  }
  if (["offline", "lost", "failed"].includes(status)) {
    return {
      label: "Host badge connection lost",
      detail: "Reconnect its USB cable and leave the badge in host mode. The server will keep listening.",
      className: "is-disconnected",
    };
  }
  return {
    label: "Waiting for the host badge connection",
    detail: "Connect the badge over USB, start the server with --serial DEVICE, and leave host mode open.",
    className: "is-unknown",
  };
}

function WaitingForHostView({ state, onCommand }) {
  const [slow, setSlow] = React.useState(false);
  const host = hostConnectionCopy(state);
  React.useEffect(() => {
    const timer = setTimeout(() => setSlow(true), WAITING_HINT_MS);
    return () => clearTimeout(timer);
  }, []);
  return h("main", { className: "onboarding-screen waiting-host-screen", "data-onboarding": "waiting", "aria-labelledby": "waiting-title" },
    h("div", { className: "onboarding-content" },
      h("img", { className: "onboarding-burger", src: "/assets/order-burger.png", alt: "" }),
      h("div", { className: "onboarding-copy" },
        h("h1", { id: "waiting-title" }, "Ready when you are"),
        h("p", { className: "waiting-host-pulse", role: "status" }, "Press START on the host badge"),
        h("p", null, "The four-minute round begins from the badge."),
        h("p", { className: cx("waiting-host-status", host.className), role: "status", "data-gateway-status": host.className }, host.label),
        h("p", { className: "waiting-host-detail" }, host.detail),
        slow && h("p", { className: "waiting-host-hint", role: "status" }, "Still listening. You can reconnect the badge without cancelling this round."),
      ),
      h("button", {
        type: "button",
        className: "onboarding-button onboarding-button-secondary",
        "data-command": GAME_ACTIONS.START_GAME,
        onClick: () => onCommand?.(GAME_ACTIONS.START_GAME),
      }, "Check host connection"),
      h("button", {
        type: "button",
        className: "onboarding-button onboarding-button-secondary",
        "data-command": GAME_ACTIONS.RESET_GAME,
        onClick: () => onCommand?.(GAME_ACTIONS.RESET_GAME),
      }, "Cancel and reset"),
    ),
  );
}

// Every screen the app can land on needs a way out. These are the buttons that the
// dead-end screens (no state yet, unreadable state, a render error) share.
function EscapeActions({ onCommand, onRetry, onTryAgain, offlineLink = false }) {
  return h("div", { className: "escape-actions" },
    onRetry && h("button", { type: "button", className: "escape-button", "data-escape": "retry", onClick: onRetry }, "Try again now"),
    onTryAgain && h("button", { type: "button", className: "escape-button", "data-escape": "try-again", onClick: onTryAgain }, "Try again"),
    h("button", { type: "button", className: "escape-button", "data-escape": "reload", onClick: () => globalThis.location?.reload?.() }, "Reload the page"),
    onCommand && h("button", { type: "button", className: "escape-button", "data-escape": "reset", "data-command": GAME_ACTIONS.RESET_GAME, onClick: () => onCommand(GAME_ACTIONS.RESET_GAME) }, "Reset the game"),
    offlineLink && h("a", { className: "escape-link", "data-escape": "offline", href: "?transport=mock" }, "Open the offline demo"),
  );
}

// A render exception must never leave a blank page. It shows what happened and
// the same way out, and clears itself when a newer snapshot arrives (`resetKey`).
export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
    this.tryAgain = () => this.setState({ error: null });
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error) {
    console.error("UI render error:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return h("section", { className: "mx-auto mt-24 max-w-2xl border border-[#ff6f6f] bg-[#2c1820] p-8", role: "alert", "data-render-error": "true" },
      h("h1", { className: "text-2xl font-black text-white" }, "Something went wrong drawing this screen"),
      h("p", { className: "mt-3 text-[#a9bac9]" }, "The game itself is not affected. Try again, reload the page, or reset the game."),
      h(EscapeActions, { onCommand: this.props.onCommand, onTryAgain: this.tryAgain }),
    );
  }
}

export function App(props) {
  const { state } = props;
  const resetKey = `${state?.setup?.phase ?? ""}:${state?.revision ?? state?.setup?.updatedAt ?? ""}`;
  return h(AppErrorBoundary, { resetKey, onCommand: props.onCommand }, h(AppContent, props));
}

function AppContent({ state, now = Date.now(), connectionError = "", uploadStatus = "", transportKind, onCommand, onGenerateLayout, onUseDefaultLayout, onUploadPhotos, onRetryConnect, onDismissError }) {
  if (!state) return h("section", { className: "mx-auto mt-24 max-w-2xl border border-[#2a435a] bg-[#101c29] p-8 text-center" }, h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-[#a9bac9]" }, "Burger level"), h("h1", { className: "mt-2 text-3xl font-black text-white" }, "Waiting for authoritative state…"), connectionError && h("div", { id: "ui-error", className: "ui-error", role: "alert" }, connectionError), h(EscapeActions, { onRetry: onRetryConnect, offlineLink: true }));
  const validation = validateFrontendSnapshot(state);
  if (!validation.valid) return h("section", { className: "mx-auto mt-24 max-w-3xl border border-[#ff6f6f] bg-[#2c1820] p-8", role: "alert" }, h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-[#ff6f6f]" }, "Burger level"), h("h1", { className: "mt-2 text-3xl font-black text-white" }, "Authoritative state unavailable"), h("p", { className: "mt-3 text-[#a9bac9]" }, "The received snapshot does not match the frontend contract. No game values were rendered."), h("p", { className: "mt-3 text-white" }, validation.errors.map((error) => error.message).join(" ")), h(EscapeActions, { onCommand }));
  const mode = displayModeForPhase(state.setup?.phase);
  const onboarding = state.setup?.phase === SETUP_PHASES.IDLE;
  const playerSetup = state.setup?.phase === SETUP_PHASES.SCANNING;
  const tour = [SETUP_PHASES.BURGER_PLACEMENT, SETUP_PHASES.LAYOUT_ACCEPTED].includes(state.setup?.phase);
  const waitingForHost = state.setup?.phase === SETUP_PHASES.WAITING_FOR_HOST;
  const results = mode === UI_DISPLAY_MODES.RESULTS;
  const content = onboarding
    ? h(OnboardingView, { state, onCommand })
    : waitingForHost
      ? h(WaitingForHostView, { state, onCommand })
    : playerSetup
      ? h(PlayerSetupView, { state, onCommand, onGenerateLayout, onUseDefaultLayout, transportKind, onUploadPhotos, uploadStatus, connectionError })
      : tour
        ? h(TourIntroView, { state, now, onCommand })
      : mode === UI_DISPLAY_MODES.GAMEPLAY
      ? h(GameplayView, { state, now, onCommand })
      : mode === UI_DISPLAY_MODES.RESULTS
        ? h(ResultsView, { state, now, onCommand })
        : h(SetupView, { state, now, onCommand, transportKind, onUploadPhotos, uploadStatus });
  const gameplay = mode === UI_DISPLAY_MODES.GAMEPLAY;
  const setupMode = mode === UI_DISPLAY_MODES.SETUP;
  return h("div", { className: cx("app-shell", gameplay && "is-gameplay", setupMode && "is-setup", (onboarding || waitingForHost || results) && "is-onboarding", playerSetup && "is-player-setup", tour && "is-tour"), "data-display-mode": mode },
    connectionError && h("div", { id: "ui-error", className: "ui-error mb-4", role: "alert" },
      h("span", null, connectionError),
      onDismissError && h("button", { type: "button", className: "ui-error-dismiss", "data-dismiss-error": "true", onClick: onDismissError }, "Dismiss"),
    ),
    content,
  );
}
