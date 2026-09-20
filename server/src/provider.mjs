const LOCAL_MESSAGE =
  "Using the deterministic local floorplan fallback. Set OPENAI_API_KEY on the server to enable optional image review; the key is never sent to the browser.";

const STATIONS = [
  {
    id: "pantry",
    label: "PANTRY",
    kind: "ingredient",
    nfcTag: "pantry",
    x: 0.8,
    y: 0.8,
    width: 1.6,
    height: 1.4,
    instruction: "Place the pantry NFC sticker here (buns and lettuce).",
  },
  {
    id: "fridge",
    label: "FRIDGE",
    kind: "ingredient",
    nfcTag: "fridge",
    x: 7.6,
    y: 0.8,
    width: 1.6,
    height: 1.4,
    instruction: "Place the fridge NFC sticker here (cheese and meat).",
  },
  {
    id: "cutting-board",
    label: "CUTTING BOARD",
    kind: "chop",
    nfcTag: "cutting-board",
    x: 1.2,
    y: 7.4,
    width: 2.4,
    height: 1.5,
    instruction: "Keep the cutting-board NFC sticker stationary in this zone.",
  },
  {
    id: "stove",
    label: "STOVE",
    kind: "stove",
    nfcTag: "stove",
    x: 6.4,
    y: 7.4,
    width: 2.4,
    height: 1.5,
    instruction: "Place the stove NFC sticker here; use left/right logical stove positions.",
  },
];

function percent(value, extent) {
  return Number(((Number(value) / extent) * 100).toFixed(6));
}

function projectRectangle(rectangle, widthMeters, heightMeters) {
  return {
    ...rectangle,
    x: percent(rectangle.x, widthMeters),
    y: percent(rectangle.y, heightMeters),
    width: percent(rectangle.width, widthMeters),
    height: percent(rectangle.height, heightMeters),
  };
}

function localPlan(extra = {}) {
  const {
    accepted: _accepted,
    coordinateSpace: _coordinateSpace,
    height: suppliedHeight,
    placementInstructions: _placementInstructions,
    room: suppliedRoom,
    stations: suppliedStations,
    units: _units,
    walls: _walls,
    width: suppliedWidth,
    photoCount = 0,
    generatedAt = new Date().toISOString(),
    ...metadata
  } = extra;
  const widthMeters = Number(suppliedRoom?.widthMeters ?? suppliedWidth) || 10;
  const heightMeters = Number(suppliedRoom?.heightMeters ?? suppliedHeight) || 10;
  const stationMeters = Array.isArray(suppliedStations) ? suppliedStations : STATIONS;
  const stations = stationMeters.map((station) => projectRectangle(station, widthMeters, heightMeters));
  const wallThickness = 0.15;
  const walls = [
    { x: 0, y: 0, width: widthMeters, height: wallThickness },
    { x: 0, y: heightMeters - wallThickness, width: widthMeters, height: wallThickness },
    { x: 0, y: 0, width: wallThickness, height: heightMeters },
    { x: widthMeters - wallThickness, y: 0, width: wallThickness, height: heightMeters },
  ].map((wall) => projectRectangle(wall, widthMeters, heightMeters));
  return {
    accepted: false,
    provider: "local-fallback",
    mode: "deterministic",
    reviewMessage: LOCAL_MESSAGE,
    ...metadata,
    room: { widthMeters, heightMeters },
    width: 100,
    height: 100,
    units: "percent",
    coordinateSpace: "normalized-percent",
    walls,
    stations,
    placementInstructions: stations.map(({ id, label, instruction, x, y }) => ({ id, label, instruction, x, y })),
    photoCount: Number(photoCount || 0),
    generatedAt,
    accepted: false,
  };
}

function safeStation(station, index, roomWidth, roomHeight) {
  if (!station || typeof station !== "object") return null;
  const number = (key, fallback) => Number.isFinite(Number(station[key])) ? Number(station[key]) : fallback;
  const id = String(station.id || station.name || `station-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const width = Math.max(0.2, Math.min(roomWidth, 3, number("width", 1.5)));
  const height = Math.max(0.2, Math.min(roomHeight, 3, number("height", 1.4)));
  const x = Math.max(0, Math.min(roomWidth - width, number("x", STATIONS[index]?.x ?? 1)));
  const y = Math.max(0, Math.min(roomHeight - height, number("y", STATIONS[index]?.y ?? 1)));
  return {
    id,
    label: String(station.label || station.name || id).slice(0, 48).toUpperCase(),
    kind: String(station.kind || "station").slice(0, 24),
    nfcTag: String(station.nfcTag || id).slice(0, 48),
    x,
    y,
    width,
    height,
    instruction: String(station.instruction || "Place the matching station marker here.").slice(0, 200),
  };
}

export function normalizeFloorplan(candidate, { photoCount = 0, generatedAt } = {}) {
  const width = Number(candidate?.width ?? candidate?.room?.widthMeters);
  const height = Number(candidate?.height ?? candidate?.room?.heightMeters);
  const stations = Array.isArray(candidate?.stations)
    ? candidate.stations.map((station, index) => safeStation(station, index, width, height)).filter(Boolean)
    : [];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 8 || width > 20 || height < 8 || height > 20 || stations.length !== 4) {
    return null;
  }
  const plan = localPlan({
    ...candidate,
    accepted: false,
    provider: "openai",
    mode: "ai",
    reviewMessage: "OpenAI produced a reviewable station proposal. Approve it before play.",
    room: { widthMeters: width, heightMeters: height },
    stations,
    photoCount,
    generatedAt: generatedAt || new Date().toISOString(),
  });
  return plan;
}

export class LocalFloorplanProvider {
  constructor({ now = () => Date.now() } = {}) { this.now = now; }
  async propose({ photos = [] } = {}) {
    return localPlan({ photoCount: photos.length, generatedAt: new Date(this.now()).toISOString() });
  }
}

export function createFloorplanProvider({ now } = {}) {
  // The legacy floorplan endpoint is intentionally deterministic. AI room
  // generation lives exclusively in /api/layout/generate.
  return new LocalFloorplanProvider({ now });
}

export function localFallbackMessage() { return LOCAL_MESSAGE; }
export { localPlan };
