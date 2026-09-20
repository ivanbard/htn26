export const REQUIRED_STATION_TYPES = Object.freeze([
  "pantry",
  "fridge",
  "cutting_board",
  "stove",
]);

const RECTANGLE_PROPERTIES = {
  center: {
    type: "object",
    additionalProperties: false,
    required: ["x", "y"],
    properties: { x: { type: "number" }, y: { type: "number" } },
  },
  width: { type: "number" },
  height: { type: "number" },
  rotationDeg: { type: "number" },
};

const rectangleSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["center", "width", "height", "rotationDeg"],
  properties: RECTANGLE_PROPERTIES,
});

export const ROOM_LAYOUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["presentationArea", "objects", "playArea", "stations"],
  properties: {
    presentationArea: rectangleSchema(),
    objects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "usableSurface", "center", "width", "height", "rotationDeg"],
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          usableSurface: { type: "boolean" },
          ...RECTANGLE_PROPERTIES,
        },
      },
    },
    playArea: rectangleSchema(),
    stations: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "supportObjectId", "center", "width", "height", "rotationDeg"],
        properties: {
          type: { type: "string", enum: [...REQUIRED_STATION_TYPES] },
          supportObjectId: { anyOf: [{ type: "string" }, { type: "null" }] },
          ...RECTANGLE_PROPERTIES,
        },
      },
    },
  },
});

function finite(value) {
  return Number.isFinite(Number(value));
}

function number(value, fallback) {
  return finite(value) ? Number(value) : fallback;
}

export function normalizeRotation(rotationDeg) {
  const value = number(rotationDeg, 0) % 180;
  return Object.is(value, -0) ? 0 : value < 0 ? value + 180 : value;
}

/**
 * Keep a rotated rectangle wholly inside the normalized unit square. A scale
 * is applied when the requested rotated extents cannot fit; this preserves
 * its center and rotation while avoiding renderer-specific clipping.
 */
export function sanitizeRotatedRect(candidate, fallback = { x: 0.5, y: 0.5, width: 0.2, height: 0.2, rotationDeg: 0 }) {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  const fallbackCenter = fallback.center && typeof fallback.center === "object" ? fallback.center : fallback;
  let width = Math.max(0.01, Math.min(1, number(source.width, fallback.width)));
  let height = Math.max(0.01, Math.min(1, number(source.height, fallback.height)));
  const rotationDeg = normalizeRotation(source.rotationDeg ?? fallback.rotationDeg);
  const radians = rotationDeg * Math.PI / 180;
  let extentX = (Math.abs(Math.cos(radians)) * width + Math.abs(Math.sin(radians)) * height) / 2;
  let extentY = (Math.abs(Math.sin(radians)) * width + Math.abs(Math.cos(radians)) * height) / 2;
  const scale = Math.min(1, 0.5 / Math.max(extentX, extentY));
  width *= scale;
  height *= scale;
  extentX *= scale;
  extentY *= scale;
  const x = Math.max(extentX, Math.min(1 - extentX, number(source.center?.x, fallbackCenter.x)));
  const y = Math.max(extentY, Math.min(1 - extentY, number(source.center?.y, fallbackCenter.y)));
  return { center: { x, y }, width, height, rotationDeg };
}

function cleanId(value, fallback) {
  const id = String(value ?? "").trim().slice(0, 80);
  return id || fallback;
}

function fallbackRect(index, total = 4) {
  const angle = (index * 37) % 180;
  return sanitizeRotatedRect({ center: { x: 0.5, y: 0.5 }, width: 0.12, height: 0.12, rotationDeg: angle });
}

function stationCandidate(stations, type) {
  return stations.find((station) => station?.type === type) || {};
}

/**
 * Convert an untrusted model value into the only layout shape the renderer
 * and API expose. Unknown properties are intentionally discarded here.
 */
export function sanitizeRoomLayout(candidate) {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  const presentationArea = sanitizeRotatedRect(source.presentationArea, { x: 0.5, y: 0.12, width: 0.8, height: 0.16, rotationDeg: 0 });
  const playArea = sanitizeRotatedRect(source.playArea, { x: 0.5, y: 0.58, width: 0.8, height: 0.65, rotationDeg: 0 });
  const rawObjects = Array.isArray(source.objects) ? source.objects : [];
  const objects = [];
  const ids = new Set();
  for (let index = 0; index < rawObjects.length; index += 1) {
    const raw = rawObjects[index];
    if (!raw || typeof raw !== "object") continue;
    const id = cleanId(raw.id, `object-${index + 1}`);
    if (ids.has(id)) continue;
    ids.add(id);
    objects.push({
      id,
      type: String(raw.type || "furniture").trim().slice(0, 48) || "furniture",
      usableSurface: raw.usableSurface === true,
      ...sanitizeRotatedRect(raw, fallbackRect(index)),
    });
  }
  const rawStations = Array.isArray(source.stations) ? source.stations : [];
  const stations = REQUIRED_STATION_TYPES.map((type, index) => {
    const raw = stationCandidate(rawStations, type);
    const supportObjectId = typeof raw.supportObjectId === "string" && ids.has(raw.supportObjectId)
      ? raw.supportObjectId
      : null;
    return {
      type,
      supportObjectId,
      ...sanitizeRotatedRect(raw, fallbackRect(index)),
    };
  });
  return { presentationArea, objects, playArea, stations };
}

export function validateRoomLayout(layout) {
  const errors = [];
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) return ["layout must be an object"];
  if (Object.keys(layout).sort().join(",") !== "objects,playArea,presentationArea,stations") errors.push("layout has unexpected top-level properties");
  if (!layout.presentationArea || !layout.playArea) errors.push("presentationArea and playArea are required");
  if (!Array.isArray(layout.objects)) errors.push("objects must be an array");
  if (!Array.isArray(layout.stations) || layout.stations.length !== 4) errors.push("stations must contain four entries");
  if (Array.isArray(layout.objects)) {
    const ids = new Set();
    for (const object of layout.objects) {
      if (!object?.id || ids.has(object.id)) errors.push("object IDs must be unique and non-empty");
      ids.add(object?.id);
      if (!["boolean"].includes(typeof object?.usableSurface)) errors.push("usableSurface must be boolean");
    }
  }
  if (Array.isArray(layout.stations)) {
    const types = layout.stations.map((station) => station?.type);
    for (const type of REQUIRED_STATION_TYPES) if (types.filter((value) => value === type).length !== 1) errors.push(`station type ${type} must occur exactly once`);
    const ids = new Set(layout.objects?.map((object) => object.id) || []);
    for (const station of layout.stations) if (station.supportObjectId !== null && !ids.has(station.supportObjectId)) errors.push("station supportObjectId must reference an object or null");
  }
  for (const rect of [layout.presentationArea, layout.playArea, ...(layout.objects || []), ...(layout.stations || [])]) {
    if (!rect?.center || ![rect.center.x, rect.center.y, rect.width, rect.height, rect.rotationDeg].every(finite)) errors.push("rectangles must contain finite geometry");
  }
  return errors;
}
