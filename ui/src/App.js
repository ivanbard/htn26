import React from "react";
import {
  canRunAction,
  formatSeconds,
  isStale,
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
import {
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
  const source = Array.isArray(state.orders) && state.orders.length ? state.orders : state.order ? [state.order] : [];
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
  remainingSeconds: 120,
  totalSeconds: 120,
  patience: { segments: 3, filledSegments: 3 },
});

function tourPreviewState(state) {
  const order = activeOrdersFor(state)[0] || TOUR_PREVIEW_ORDER;
  const previewOrder = {
    ...TOUR_PREVIEW_ORDER,
    ...order,
    status: "active",
    remainingSeconds: Number(order.totalSeconds) > 0 ? Number(order.totalSeconds) : TOUR_PREVIEW_ORDER.totalSeconds,
    totalSeconds: Number(order.totalSeconds) > 0 ? Number(order.totalSeconds) : TOUR_PREVIEW_ORDER.totalSeconds,
    patience: { ...TOUR_PREVIEW_ORDER.patience, ...order.patience, filledSegments: 3 },
  };
  const totalSeconds = Number(state.clock?.totalSeconds) > 0 ? Number(state.clock.totalSeconds) : 240;
  return {
    ...state,
    orders: [previewOrder],
    order: previewOrder,
    score: { ...(state.score || {}), value: 0, delivered: 0 },
    gold: { ...(state.gold || {}), total: 0, earned: 0, lastChange: 0 },
    tips: { ...(state.tips || {}), total: 0, earned: 0, lastChange: 0 },
    clock: { ...(state.clock || {}), status: "ready", remainingSeconds: totalSeconds, totalSeconds },
  };
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

function stagesForLayout(layoutFromImage) {
  return layoutFromImage ? [
    { key: "host", label: "Wake the kitchen", description: "Turn on the host and setup camera", action: GAME_ACTIONS.START_HOST },
    { key: "scan", label: "Map the room", description: "Use setup photos for the play area", action: GAME_ACTIONS.SCAN_ROOM },
    { key: "approve", label: "Choose the layout", description: "Review the image-based placement", action: GAME_ACTIONS.APPROVE_LAYOUT },
    { key: "place", label: "Place the stations", description: "Match pieces to those spots", action: null },
    { key: "play", label: "Start cooking", description: "Begin the four-minute round", action: GAME_ACTIONS.START_GAME },
  ] : [
    { key: "host", label: "Wake the kitchen", description: "Turn on the host badge and display", action: GAME_ACTIONS.START_HOST },
    { key: "scan", label: "Load the room", description: "Use the standard kitchen layout", action: GAME_ACTIONS.SCAN_ROOM },
    { key: "approve", label: "Confirm the layout", description: "Review the fixed station positions", action: GAME_ACTIONS.APPROVE_LAYOUT },
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
  const stateLabel = station.kind === "ingredient"
    ? "SOURCE"
    : isWarning && visualState !== "burnt" ? "WARNING" : cookingStateLabel(visualState);
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
    isWarning && h("div", { className: "station-hazard", role: "img", "aria-label": runtimeStation.warningMessage || "Cooking warning: remove the food soon" },
      h("img", { src: HAZARD_ASSET, alt: "Cooking warning" }),
      h("span", { className: "station-steam", "aria-hidden": true }, h("i"), h("i"), h("i")),
    ),
    isWorkstation && ingredients.length > 0 && h("span", { className: "station-item-label", title: ingredients.join(" + "), "data-station-item": ingredients.join("+") }, ingredients.join(" + ")),
    h("span", { className: "room-station-state" }, stateLabel, timingLabel),
    !isSource && h("div", { className: "station-caption" },
      h("span", { className: "room-station-label" }, station.label || station.id),
      timingStation && h("span", { className: "station-progress-track", role: "meter", "aria-label": `${station.label || station.id} progress`, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(progress), "data-progress": progress, "data-total-seconds": Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : undefined, "data-remaining-seconds": Number.isFinite(Number(remaining)) ? remaining : undefined }, h("span", { style: { width: `${progress}%` } })),
    ),
  );
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

function AnimatedPlayer({ player, position, walls, stale, plannedPath, delayMs = 0, pathStrategy = "single-agent" }) {
  const target = projectPointIntoWalkableRoom(position, walls, position);
  const targetKey = `${target.x.toFixed(3)}:${target.y.toFixed(3)}`;
  const wallKey = (walls || []).map((wall) => `${wall.x}:${wall.y}:${wall.width}:${wall.height}:${wall.blocksMovement}`).join("|");
  const plannedPathKey = Array.isArray(plannedPath) ? plannedPath.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join("|") : "";
  const previousPoint = React.useRef(target);
  const frame = React.useRef(0);
  const [visualPosition, setVisualPosition] = React.useState(target);
  const [moving, setMoving] = React.useState(false);
  const plateItems = plateableIngredientKeys(playerPlateItems(player));
  const heldItems = playerHeldItems(player, plateItems);
  const hasPlate = Array.isArray(player?.plate) || (Array.isArray(player?.inventory) && player.inventory.some((item) => ingredientKey(item) === "PLATE"));
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
    const duration = Math.min(1_150, Math.max(460, distance * 19));
    let delayTimer;
    const start = () => {
      const startedAt = performance.now();
      setMoving(true);
      const tick = (time) => {
        const linear = Math.min(1, (time - startedAt) / duration);
        const accelerated = linear * linear * (3 - (2 * linear));
        const next = playerPointAlongPath(path, accelerated);
        previousPoint.current = next;
        setVisualPosition(next);
        if (linear < 1) frame.current = requestAnimationFrame(tick);
        else {
          previousPoint.current = destination;
          setVisualPosition(destination);
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
    className: cx("tracked-player", `player-team-${team}`, hasPlate && "has-plate", moving && "is-moving", stale && "is-stale"),
    style: { left: `${visualPosition.x}%`, top: `${visualPosition.y}%` },
    "data-player": player.id,
    "data-stale": stale,
    "data-player-path": "barrier-safe",
    "data-path-strategy": pathStrategy,
    "aria-label": `${player.name || label}, ${locationLabel}`,
  },
  h("div", { className: "player-token" },
    h("div", { className: "player-avatar" },
      h("img", { className: "player-chef-art", src: hasPlate ? chefArt.holdBack : playerChefAsset(player), alt: "" }),
      hasPlate && plateArt && h("img", { className: "player-plate-sprite", "data-plate-sprite": plateCombo ? "combo" : "base", src: plateArt, alt: `${label} plate: ${plateItems.join(", ") || "empty"}` }),
      hasPlate && h("img", { className: "player-chef-art player-chef-hold-front", src: chefArt.holdFront, alt: "" }),
      hasPlate && !plateCombo && h(PlateIngredients, { ingredients: plateItems, stage: "plated", className: "player-plate-ingredients", label: `${label} plate: ${plateItems.join(", ") || "empty"}` }),
      !hasPlate && heldItems.length > 0 && h("div", { className: "player-held-item", "aria-label": `${label} is holding ${heldItems[0]}` }, h(IngredientIcon, { value: heldItems[0], stage: "plated" })),
    ),
    h("span", { className: "player-tag" }, label),
  ));
}

function RoomSurface({ state, now, gameplay = false }) {
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
  const stations = (plan.stations || []).map((station) => h("div", {
      key: station.id,
      className: cx("room-station", gameplay ? "room-station-gameplay" : "room-station-setup", stationClass(station.kind), stationGridClass(station, plan.grid)),
      style: rectStyle(station.display || station),
      "data-station": station.id,
      "data-grid-cell": station.grid ? `${station.grid.column}:${station.grid.row}` : undefined,
    }, h(StationContents, { station, runtimeStation: runtimeStations.get(station.id), serving: state.serving })));
  const positionedPlayers = separatePlayerPositions(state.players || [], movementWalls);
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
      plannedPath: pathPlan?.path,
      delayMs: pathPlan?.delayMs,
      pathStrategy: pathPlan?.strategy,
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
  }, !layoutFromImage && h("div", { className: "kitchen-floor", "aria-hidden": true }), !gameplay && h("div", { className: "room-plan-grid", "aria-hidden": true }), walls, stations, players,
  !accepted && h("div", { className: "room-approval-overlay" }, "Approve floor plan to generate burger level"));
}

function RoomStage({ state, now, gameplay = false }) {
  return h("div", { className: cx("room-stage", gameplay && "room-stage-gameplay") }, h(RoomSurface, { state, now, gameplay }));
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

function OrderTimerIcon() {
  return h("span", { className: "hud-order-time-icon", "aria-hidden": true },
    h("svg", { viewBox: "0 0 32 32", focusable: "false" },
      h("rect", { x: "11", y: "2.5", width: "10", height: "4", rx: "2", fill: "none" }),
      h("path", { d: "M8.5 9 5.8 6.3M23.5 9l2.7-2.7", fill: "none" }),
      h("circle", { cx: "16", cy: "18", r: "10.5", fill: "none" }),
      h("line", { x1: "16", y1: "18", x2: "16", y2: "11.5" }),
      h("line", { x1: "16", y1: "18", x2: "21.5", y2: "21" }),
      h("circle", { cx: "16", cy: "18", r: "1.5", fill: "currentColor", stroke: "none" }),
    ),
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

function OrderCard({ order, compact = false }) {
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
  const titleId = `hud-title-${String(order.id || "order").replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
  return h("section", { className: cx("hud-order", compact && "hud-order-compact", urgency), "data-node-id": "39:26", "data-order-id": order.id, "aria-labelledby": titleId },
    h(BurgerPreview, { order, components }),
    h("div", { className: "hud-order-main" },
      h("div", { className: "hud-order-heading" },
        h("h2", { id: titleId }, orderTitle(order)),
        h("span", { className: "hud-order-recipe-count" }, `${components.length || 1} ITEMS`),
      ),
      h("div", { className: "hud-ingredient-slots", "aria-label": `Assembly order: ${components.map((item) => upper(item)).join(", ")}` }, components.map((item, index) => h("div", { key: `${item}-${index}`, className: "hud-ingredient-slot", "data-ingredient-slot": index + 1, "aria-label": `${index + 1}. ${upper(item)}` }, h(IngredientIcon, { value: item, stage: "plated" })))),
    ),
    h("div", { className: "hud-order-time", "aria-label": `${seconds(order.remainingSeconds)} remaining` },
      h(OrderTimerIcon),
      h("strong", null, seconds(order.remainingSeconds)),
    ),
    h("div", { className: "hud-order-progress", role: "progressbar", "aria-label": `${orderTitle(order)} time remaining`, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(progress) }, h("span", { style: { width: `${progress}%` } })),
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
  return h("div", { className: "board-score", "data-node-id": "31:25", "aria-label": `${score.value ?? 0} WatCoins, ${score.delivered ?? 0} burgers served` },
    h("img", { src: "/assets/score-coin-counter.png", alt: "", "aria-hidden": true }),
    h("strong", { className: "board-score-value" }, score.value ?? 0),
  );
}

// Short enough to read well under 30 seconds: five labeled steps, no
// paragraphs. Grounded in the actual v1 rules (README.md / UPDATE_v1.1.md) —
// pantry/fridge pickups, cutting-board chopping, stove cooking, plating, and
// the three-player simultaneous-shake submission.
const HOW_IT_WORKS_STEPS = Object.freeze([
  { icon: "🧺", text: "Grab buns/lettuce at the pantry, cheese/meat at the fridge" },
  { icon: "🔪", text: "Hold A at the cutting board to chop it" },
  { icon: "🔥", text: "Cook cut meat on a stove (15s)" },
  { icon: "🍽️", text: "Pick up a plate and stack the order's ingredients on it" },
  { icon: "🤝", text: "All 3 players shake at once to submit the plate" },
]);

// Local UI-only: this never calls onCommand or touches authoritative state.
// It appears once per gameplay mount (a fresh round re-mounts GameplayBoard,
// so it naturally reappears next round) and only a viewer's own dismiss click
// closes it early; the round timer underneath keeps running regardless.
function HowItWorksOverlay() {
  const [open, setOpen] = React.useState(true);
  if (!open) return null;
  return h("div", { className: "how-it-works", role: "dialog", "aria-label": "How this game works" },
    h("div", { className: "how-it-works-card" },
      h("p", { className: "how-it-works-kicker" }, "How this works"),
      h("ol", { className: "how-it-works-steps" }, HOW_IT_WORKS_STEPS.map((step, index) => h("li", { key: index },
        h("span", { className: "how-it-works-icon", "aria-hidden": true }, step.icon),
        h("span", null, step.text),
      ))),
      h("button", {
        type: "button",
        className: "how-it-works-dismiss",
        "data-dismiss": "how-it-works",
        onClick: () => setOpen(false),
      }, "Got it — start cooking"),
    ),
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
// the live, in-round version of that result; ServingPanel (ResultsView)
// still shows the final round's last event after the round ends.
function DeliveryToast({ state, now }) {
  const event = state.serving?.lastEvent;
  if (!event) return null;
  const age = Number(now) - Number(event.at);
  if (!(age >= 0) || age > DELIVERY_TOAST_LIFETIME_MS) return null;
  const success = event.status === "success";
  const segments = Math.max(0, Math.min(3, Number(event.patienceSegments) || 0));
  return h("div", {
    key: event.at,
    className: cx("delivery-toast", success ? "is-success" : "is-failure"),
    role: "status",
    "aria-live": "polite",
  },
    h("strong", { className: "delivery-toast-message" }, event.message),
    success
      ? h("div", { className: "delivery-toast-breakdown" },
        h("span", { className: "delivery-toast-gold" }, `+${event.gold} WATCOINS`),
        h("span", { className: "delivery-toast-tip" }, `+${event.tip} TIP`),
        h("span", { className: "delivery-toast-patience", "aria-label": `Served with ${segments} of 3 patience segments remaining` },
          [0, 1, 2].map((index) => h("i", { key: index, className: cx("delivery-toast-pip", index < segments && "is-filled") }))),
      )
      : h("div", { className: "delivery-toast-breakdown" }, h("span", { className: "delivery-toast-penalty" }, `${event.penalty ? "-" : ""}${event.penalty || 0} PENALTY`)),
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
      h(HowItWorksOverlay),
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
      h("section", { className: "setup-card map-card", "aria-labelledby": "map-title" }, h("div", { className: "map-heading" }, h("div", null, h("p", { className: "setup-kicker" }, accepted ? "Layout ready" : "Room preview"), h("h2", { id: "map-title" }, accepted ? "Your burger kitchen" : "Check the play area")), h("span", { className: cx("map-state", accepted && "is-ready") }, accepted ? "Ready to place" : "Needs approval")), h("p", null, accepted ? "Match each printed ingredient and station to its labelled spot on the map below. Keep chopping boards and stoves still once the round begins." : "Approve the layout to see where every station belongs."), transportKind === "http" && h("div", { className: "server-photo-upload" }, h("label", { htmlFor: "room-photo-input" }, "Room photos are uploaded from the phone to the master Pi"), h("input", { id: "room-photo-input", type: "file", accept: "image/*", multiple: true, onChange: (event) => onUploadPhotos?.(event.target.files) }), uploadStatus && h("span", { role: "status" }, uploadStatus)), h("div", { className: "map-frame" }, h(RoomStage, { state, now }))),
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

function playerIsReady(player) {
  if (!player) return false;
  if (Object.prototype.hasOwnProperty.call(player, "ready")) return player.ready === true;
  if (Object.prototype.hasOwnProperty.call(player, "connected")) return player.connected === true;
  if (Object.prototype.hasOwnProperty.call(player, "badgeMac")) return Boolean(player.badgeMac);
  const status = String(player.status || player.connection?.status || "").toLowerCase();
  if (status) return ["ready", "connected", "online", "healthy"].includes(status);
  return true;
}

function playersForSlots(state) {
  const players = Array.isArray(state?.players) ? state.players : [];
  return [1, 2, 3].map((slot) => players.find((player) => playerSlotNumber(player) === slot) || null);
}

function roomPhotoCount(state) {
  const photoCount = Array.isArray(state?.photos) ? state.photos.length : Number(state?.photoCount ?? state?.setup?.photoCount);
  return Number.isFinite(photoCount) ? Math.max(0, Math.floor(photoCount)) : 0;
}

function PlayerReadinessCard({ slot, player }) {
  const ready = playerIsReady(player);
  const label = player?.name || `PLAYER ${slot}`;
  return h("div", {
    className: cx("player-readiness-card", !ready && "is-unavailable"),
    "data-player-slot": String(slot),
    "data-player-ready": ready ? "true" : "false",
    role: "status",
    "aria-label": `${label}: ${ready ? "ready" : "waiting for player"}`,
  },
    h("div", { className: "player-readiness-main" },
      h("span", { className: "player-readiness-icon" }, h("img", { src: playerChefAsset(player || { color: "green" }), alt: "" })),
      h("span", { className: "player-readiness-copy" },
        h("strong", null, `PLAYER ${slot}`),
        h("span", null, ready ? "READY" : "WAITING FOR PLAYER"),
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

function PlayerSetupView({ state, onCommand, transportKind, onUploadPhotos, uploadStatus }) {
  const players = playersForSlots(state);
  const readyCount = players.filter(playerIsReady).length;
  const photoCount = roomPhotoCount(state);
  const hasMinimumPlayers = readyCount >= 1;
  const hasPhotos = transportKind !== "http" || photoCount >= 3;
  const canScan = canRunAction(state, GAME_ACTIONS.SCAN_ROOM) && hasMinimumPlayers && hasPhotos;
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
      h("button", {
        type: "button",
        className: "onboarding-button player-setup-continue",
        disabled: !canScan,
        "data-command": GAME_ACTIONS.SCAN_ROOM,
        onClick: () => onCommand?.(GAME_ACTIONS.SCAN_ROOM),
      }, "Continue"),
    ),
  );
}

function TourWalkthrough({ state, onCommand, onClose }) {
  const [step, setStep] = React.useState(0);
  const finalStep = step === HOW_IT_WORKS_STEPS.length - 1;
  const current = HOW_IT_WORKS_STEPS[step];
  return h("div", { className: "tour-welcome-layer", role: "dialog", "aria-labelledby": "tour-step-title" },
    h("div", { className: "tour-step-content" },
      h("p", { className: "tour-kicker" }, `Tour ${step + 1} of ${HOW_IT_WORKS_STEPS.length}`),
      h("div", { className: "tour-step-icon", "aria-hidden": true }, current.icon),
      h("h1", { id: "tour-step-title" }, current.text),
      h("div", { className: "tour-actions" },
        h("button", {
          type: "button",
          className: "tour-primary-button",
          onClick: () => finalStep ? onCommand?.(GAME_ACTIONS.START_GAME) : setStep((value) => value + 1),
        }, finalStep ? "Start Cooking" : "Continue"),
        h("button", { type: "button", className: "tour-secondary-button", onClick: onClose }, "Back"),
        h("button", { type: "button", className: "tour-skip-button", "data-command": GAME_ACTIONS.START_GAME, onClick: () => onCommand?.(GAME_ACTIONS.START_GAME) }, "Skip to the Game"),
      ),
    ),
  );
}

function TourIntroView({ state, now, onCommand }) {
  const [tourStarted, setTourStarted] = React.useState(false);
  const preview = tourPreviewState(state);
  return h("main", { className: "tour-screen", "data-onboarding": "tour", "aria-labelledby": "tour-title" },
    h("div", { className: "tour-game-board" },
      h(RoomStage, { state: preview, now, gameplay: true }),
      h(OrdersHud, { state: preview }),
      h("div", { className: "game-board-score" }, h(ScoreCard, { state: preview })),
      h("div", { className: "game-board-timer" }, h(TimerCard, { state: preview, compact: true })),
      tourStarted
        ? h(TourWalkthrough, { state: preview, onCommand, onClose: () => setTourStarted(false) })
        : h("div", { className: "tour-welcome-layer", role: "dialog", "aria-labelledby": "tour-title" },
          h("div", { className: "tour-welcome-content" },
            h("img", { className: "tour-burger", src: "/assets/order-burger.png", alt: "" }),
            h("h1", { id: "tour-title" }, "Welcome to ", h("strong", null, "UnderCooked Interactive Tour")),
            h("div", { className: "tour-actions" },
              h("button", { type: "button", className: "tour-primary-button", "data-tour-action": "start", onClick: () => setTourStarted(true) }, "Start Tour"),
              h("button", { type: "button", className: "tour-skip-button", "data-command": GAME_ACTIONS.START_GAME, onClick: () => onCommand?.(GAME_ACTIONS.START_GAME) }, "Skip to the Game"),
            ),
          ),
        ),
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

export function App({ state, now = Date.now(), connectionError = "", uploadStatus = "", transportKind, onCommand, onUploadPhotos }) {
  if (!state) return h("section", { className: "mx-auto mt-24 max-w-2xl border border-[#2a435a] bg-[#101c29] p-8 text-center" }, h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-[#a9bac9]" }, "Burger level"), h("h1", { className: "mt-2 text-3xl font-black text-white" }, "Waiting for authoritative state…"), connectionError && h("div", { id: "ui-error", className: "ui-error", role: "alert" }, connectionError));
  const validation = validateFrontendSnapshot(state);
  if (!validation.valid) return h("section", { className: "mx-auto mt-24 max-w-3xl border border-[#ff6f6f] bg-[#2c1820] p-8", role: "alert" }, h("p", { className: "text-xs font-black uppercase tracking-[0.16em] text-[#ff6f6f]" }, "Burger level"), h("h1", { className: "mt-2 text-3xl font-black text-white" }, "Authoritative state unavailable"), h("p", { className: "mt-3 text-[#a9bac9]" }, "The received snapshot does not match the frontend contract. No game values were rendered."), h("p", { className: "mt-3 text-white" }, validation.errors.map((error) => error.message).join(" ")));
  const mode = displayModeForPhase(state.setup?.phase);
  const onboarding = state.setup?.phase === SETUP_PHASES.IDLE;
  const playerSetup = state.setup?.phase === SETUP_PHASES.SCANNING;
  const tour = [SETUP_PHASES.BURGER_PLACEMENT, SETUP_PHASES.LAYOUT_ACCEPTED].includes(state.setup?.phase);
  const content = onboarding
    ? h(OnboardingView, { state, onCommand })
    : playerSetup
      ? h(PlayerSetupView, { state, onCommand, transportKind, onUploadPhotos, uploadStatus })
      : tour
        ? h(TourIntroView, { state, now, onCommand })
      : mode === UI_DISPLAY_MODES.GAMEPLAY
      ? h(GameplayView, { state, now, onCommand })
      : mode === UI_DISPLAY_MODES.RESULTS
        ? h(ResultsView, { state, now, onCommand })
        : h(SetupView, { state, now, onCommand, transportKind, onUploadPhotos, uploadStatus });
  const gameplay = mode === UI_DISPLAY_MODES.GAMEPLAY;
  const setupMode = mode === UI_DISPLAY_MODES.SETUP;
  return h("div", { className: cx("app-shell", gameplay && "is-gameplay", setupMode && "is-setup", onboarding && "is-onboarding", playerSetup && "is-player-setup", tour && "is-tour"), "data-display-mode": mode },
    connectionError && h("div", { id: "ui-error", className: "ui-error mb-4", role: "alert" }, connectionError),
    content,
  );
}
