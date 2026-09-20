import { ROOM_COORDINATE_SPACE } from "./contracts.js";

const SERVER_UNITS = Object.freeze({ width: 10, height: 10 });
const TEAM_ALIASES = Object.freeze({ orange: "red", cyan: "blue", violet: "green" });

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function sourceDimensions(plan) {
  const width = finite(plan?.width ?? plan?.room?.widthMeters, SERVER_UNITS.width);
  const height = finite(plan?.height ?? plan?.room?.heightMeters, SERVER_UNITS.height);
  return {
    width: width > 0 ? width : SERVER_UNITS.width,
    height: height > 0 ? height : SERVER_UNITS.height,
  };
}

function isNormalizedPlan(plan) {
  return plan?.coordinateSpace === ROOM_COORDINATE_SPACE || String(plan?.units || "").toLowerCase() === "percent";
}

function normalizeRect(rect, dimensions, normalized) {
  const width = normalized ? 100 : dimensions.width;
  const height = normalized ? 100 : dimensions.height;
  const x = clamp(rect?.x, 0, width);
  const y = clamp(rect?.y, 0, height);
  const rectWidth = clamp(rect?.width, 0, width - x);
  const rectHeight = clamp(rect?.height, 0, height - y);
  return normalized
    ? { x, y, width: rectWidth, height: rectHeight }
    : {
        x: (x / dimensions.width) * 100,
        y: (y / dimensions.height) * 100,
        width: (rectWidth / dimensions.width) * 100,
        height: (rectHeight / dimensions.height) * 100,
      };
}

function normalizePoint(point, dimensions, normalized) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
  if (normalized) return { ...point, x: clamp(point.x), y: clamp(point.y) };
  return {
    ...point,
    x: clamp((Number(point.x) / dimensions.width) * 100),
    y: clamp((Number(point.y) / dimensions.height) * 100),
  };
}

function assetKeyForStation(station) {
  const identity = `${station?.id || ""} ${station?.nfcTag || ""} ${station?.kind || ""}`.toLowerCase();
  if (identity.includes("stove") || station?.kind === "pot") return "STOVE";
  if (identity.includes("cut") || station?.kind === "chop") return "CHOP";
  if (identity.includes("pantry")) return "PANTRY";
  if (identity.includes("fridge")) return "FRIDGE";
  if (station?.kind === "delivery") return "COUNTER";
  return "COUNTER";
}

function sourceContentsForStation(station) {
  const identity = `${station?.id || ""} ${station?.nfcTag || ""}`.toLowerCase();
  if (identity.includes("pantry")) return ["BUN", "LETTUCE"];
  if (identity.includes("fridge")) return ["CHEESE", "MEAT"];
  return undefined;
}

function normalizedDisplayRect(rect, tileSize = 18) {
  const centerX = finite(rect.x) + finite(rect.width) / 2;
  const centerY = finite(rect.y) + finite(rect.height) / 2;
  const width = Math.min(tileSize, 100);
  const height = Math.min(tileSize, 100);
  return {
    x: clamp(centerX - width / 2, 0, 100 - width),
    y: clamp(centerY - height / 2, 0, 100 - height),
    width,
    height,
  };
}

function normalizeStation(station, index, dimensions, normalized) {
  const rect = normalizeRect(station, dimensions, normalized);
  const id = String(station?.id || station?.name || `station-${index + 1}`);
  const kind = String(station?.kind || "station").toLowerCase();
  // Keep the visual appliance tile identical even when an AI/image plan has
  // different source rectangles. The original rectangles remain in the
  // normalized plan for review/collision data; `display` is presentation-only.
  const display = normalizedDisplayRect(rect);
  return {
    ...station,
    id,
    label: String(station?.label || station?.name || id).toUpperCase(),
    kind,
    ...rect,
    display,
    assetKey: station?.assetKey || assetKeyForStation(station),
    contents: station?.contents || station?.ingredients || sourceContentsForStation(station),
  };
}

function normalizeFloorPlan(plan) {
  const dimensions = sourceDimensions(plan);
  const normalized = isNormalizedPlan(plan);
  const walls = (Array.isArray(plan?.walls) ? plan.walls : []).map((wall, index) => ({
    ...wall,
    id: wall?.id || `wall-${index + 1}`,
    ...normalizeRect(wall, dimensions, normalized),
    blocksMovement: wall?.blocksMovement !== false,
  }));
  const stations = (Array.isArray(plan?.stations) ? plan.stations : [])
    .map((station, index) => normalizeStation(station, index, dimensions, normalized));
  const placementInstructions = (Array.isArray(plan?.placementInstructions) ? plan.placementInstructions : stations)
    .map((instruction, index) => ({
      ...instruction,
      id: instruction?.id || stations[index]?.id || `station-${index + 1}`,
      ...normalizeRect(instruction, dimensions, normalized),
    }));

  return {
    ...plan,
    coordinateSpace: ROOM_COORDINATE_SPACE,
    width: 100,
    height: 100,
    units: "percent",
    layoutFromImage: plan?.layoutFromImage === true,
    walls,
    stations,
    placementInstructions,
    room: { widthMeters: dimensions.width, heightMeters: dimensions.height },
  };
}

function normalizePlayer(player, dimensions, normalized) {
  const color = String(player?.color || "green").toLowerCase();
  const position = normalizePoint(player?.position, dimensions, normalized);
  return {
    ...player,
    color: TEAM_ALIASES[color] || color,
    position,
  };
}

function activeOrders(snapshot) {
  if (Array.isArray(snapshot?.activeOrders) && snapshot.activeOrders.length) return snapshot.activeOrders;
  if (Array.isArray(snapshot?.orders)) return snapshot.orders;
  return snapshot?.order ? [snapshot.order] : [];
}

/**
 * Adapt the Pi projection only at the network boundary.
 *
 * The Pi remains authoritative for timer/order/station values. This function
 * only converts its metre-based room geometry and v1 envelope to the stable
 * display contract consumed by the browser.
 */
export function normalizeServerSnapshot(snapshot) {
  if (!snapshot || !["pi-server", "root-server", "pi-server-simulator", "root-server-simulator"].includes(snapshot.source)) return snapshot;
  const sourcePlan = snapshot.floorPlan || {};
  const dimensions = sourceDimensions(sourcePlan);
  const normalized = isNormalizedPlan(sourcePlan);
  const orders = activeOrders(snapshot).slice(0, 4);
  const primaryOrder = orders.find((order) => order?.status === "active") || orders[0] || snapshot.order;
  return {
    ...snapshot,
    version: 2,
    floorPlan: normalizeFloorPlan(sourcePlan),
    players: (Array.isArray(snapshot.players) ? snapshot.players : [])
      .map((player) => normalizePlayer(player, dimensions, normalized)),
    orders,
    order: primaryOrder || snapshot.order || {},
    stations: Array.isArray(snapshot.stations) ? snapshot.stations.map((station) => ({ ...station })) : [],
  };
}

export function isPiServerSnapshot(snapshot) {
  return Boolean(snapshot && snapshot.source === "pi-server");
}
