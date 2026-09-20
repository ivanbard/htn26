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

function inferredStationPosition(stationId, floorPlan) {
  const requested = String(stationId || "center").toLowerCase();
  const stations = Array.isArray(floorPlan?.stations) ? floorPlan.stations : [];
  const byId = (id) => stations.find((candidate) => String(candidate?.id || "").toLowerCase() === id);
  // An exact tile wins (the per-stove tiles stove-left / stove-right); only a plan
  // with one shared `stove` tile falls back to it.
  const exact = byId(requested) || (requested.startsWith("stove-") ? byId("stove") : null);
  const indexed = (kind, index = 0) => stations.filter((candidate) => candidate?.kind === kind)[index] || null;
  const station = exact
    || (requested === "pantry" ? stations.find((candidate) => /pantry|bun|lettuce/i.test(`${candidate?.id} ${candidate?.label} ${candidate?.nfcTag}`)) : null)
    || (requested === "fridge" ? stations.find((candidate) => /fridge|meat|cheese/i.test(`${candidate?.id} ${candidate?.label} ${candidate?.nfcTag}`)) : null)
    || (requested === "cutting-board" ? indexed("chop") : null)
    || (requested === "stove-left" ? (stations.find((candidate) => /stove1|left/i.test(`${candidate?.id} ${candidate?.label}`)) || indexed("stove")) : null)
    || (requested === "stove-right" ? (stations.find((candidate) => /stove2|right/i.test(`${candidate?.id} ${candidate?.label}`)) || indexed("stove", 1)) : null)
    || (requested === "serving" ? stations.find((candidate) => ["assembly", "delivery", "serving"].includes(candidate?.kind) || /assembly|serv/i.test(`${candidate?.id} ${candidate?.label}`)) : null);
  // The server reported a location this plan has nothing to draw for (for example
  // "serving": v1 has no serving station). Show the chef at the room's default
  // spot rather than making them disappear.
  if (!station) return { x: 50, y: 50 };
  const rect = [station.display?.x, station.display?.y, station.display?.width, station.display?.height].every((value) => Number.isFinite(Number(value)))
    ? station.display
    : station;
  return {
    x: Number(rect.x) + (Number(rect.width) / 2),
    y: Number(rect.y) + (Number(rect.height) / 2),
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

// Percent lengths are of the floor plan's width horizontally and of its height
// vertically. The floor plan is the 1672:941 board minus its wooden frame, about
// 2.1:1, and a station tile is a CSS square sized by its width. So a tile that
// is square on screen and `tileSize`% tall must be tileSize / PLAN_ASPECT % wide.
// Using the same percentage on both axes made tiles ~2x too wide, and the
// collision model (which uses these rectangles) disagreed with what was drawn.
const PLAN_ASPECT = 2.12;

function normalizedDisplayRect(rect, tileSize = 18) {
  const centerX = finite(rect.x) + finite(rect.width) / 2;
  const centerY = finite(rect.y) + finite(rect.height) / 2;
  const height = Math.min(tileSize, 100);
  const width = Math.min(tileSize / PLAN_ASPECT, 100);
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

/**
 * The server's floor plan has one physical `stove` NFC zone but two logical
 * stoves (LEFT/RIGHT) that the badges select between. Draw both so the second
 * stove's contents and cooking progress are visible: split the single tile into
 * two adjacent tiles whose ids match the runtime `stove-left`/`stove-right`
 * stations. Placement instructions are intentionally left as the one physical
 * NFC zone. A plan that already has several stoves is returned untouched.
 */
function splitSingleStove(stations) {
  const stoves = stations.filter((station) => station.kind === "stove");
  if (stoves.length !== 1 || /left|right/i.test(stoves[0].id)) return stations;
  const [stove] = stoves;
  const tile = stove.display || normalizedDisplayRect(stove);
  const centerX = tile.x + tile.width / 2;
  const leftX = clamp(centerX - tile.width, 0, Math.max(0, 100 - tile.width * 2));
  const half = (id, label, side, x) => ({ ...stove, id, label, side, display: { ...tile, x } });
  return stations.flatMap((station) => station === stove
    ? [half("stove-left", "STOVE 1", "LEFT", leftX), half("stove-right", "STOVE 2", "RIGHT", leftX + tile.width)]
    : [station]);
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
    stations: splitSingleStove(stations),
    placementInstructions,
    room: { widthMeters: dimensions.width, heightMeters: dimensions.height },
  };
}

// A server player has no `tracking.lastSeenAt` when the position is inferred from
// their latest action (there is no live tracking in v1), and the UI reads a
// missing timestamp as "stale", which drew every chef at 62% opacity for a whole
// round. An inferred spot is current until something says otherwise, so keep it
// fresh; only a dead gateway dims it.
const INFERRED_LOCATION_FRESH_MS = 60 * 60 * 1000;

function normalizePlayer(player, dimensions, normalized, floorPlan, gatewayDown = false) {
  const color = String(player?.color || "green").toLowerCase();
  const explicitPosition = normalizePoint(player?.position, dimensions, normalized);
  const stationId = player?.simulatedLocation?.stationId || player?.currentStation;
  const inferredPosition = explicitPosition || inferredStationPosition(stationId, floorPlan);
  const inferred = Boolean(inferredPosition) && !explicitPosition;
  return {
    ...player,
    color: TEAM_ALIASES[color] || color,
    position: inferredPosition,
    ...(inferred ? {
      tracking: {
        ...player?.tracking,
        status: gatewayDown ? "lost" : "inferred",
        source: player?.tracking?.source || "action-inference",
        lastSeenAt: player?.simulatedLocation?.sinceAt || player?.tracking?.lastSeenAt || null,
        staleAfterMs: INFERRED_LOCATION_FRESH_MS,
      },
    } : {}),
    ...(inferredPosition && !explicitPosition ? {
      location: player?.simulatedLocation?.label || stationId,
      positionSource: player?.simulatedLocation?.source || "action-inference",
    } : {}),
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
  if (!isPiServerSnapshot(snapshot)) return snapshot;
  const sourcePlan = snapshot.floorPlan || {};
  const dimensions = sourceDimensions(sourcePlan);
  const normalized = isNormalizedPlan(sourcePlan);
  const normalizedPlan = normalizeFloorPlan(sourcePlan);
  const orders = activeOrders(snapshot).slice(0, 4);
  const primaryOrder = orders.find((order) => order?.status === "active") || orders[0] || snapshot.order;
  return {
    ...snapshot,
    version: 2,
    floorPlan: normalizedPlan,
    players: (Array.isArray(snapshot.players) ? snapshot.players : [])
      .map((player) => normalizePlayer(player, dimensions, normalized, normalizedPlan, snapshot.health?.gateway?.status === "offline")),
    orders,
    // Completed/expired orders are dropped from `orders` (active only); keep the
    // history so the results screen can summarize the round.
    orderHistory: Array.isArray(snapshot.orders) ? snapshot.orders.slice(-64) : [],
    order: primaryOrder || snapshot.order || {},
    stations: Array.isArray(snapshot.stations) ? snapshot.stations.map((station) => ({ ...station })) : [],
  };
}

export function isPiServerSnapshot(snapshot) {
  return Boolean(snapshot && [
    "pi-server",
    "pi-server-simulator",
    "root-server",
    "root-server-simulator",
  ].includes(snapshot.source));
}
