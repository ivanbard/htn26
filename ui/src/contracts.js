import { SETUP_PHASES } from "./state.js";

/**
 * The schema version shared by the laptop server and offline mock.
 */
export const FRONTEND_SNAPSHOT_VERSION = 2;
export const SNAPSHOT_VERSION = FRONTEND_SNAPSHOT_VERSION;
export const ROOM_COORDINATE_SPACE = "normalized-percent";

export const FRONTEND_SNAPSHOT_FIELDS = Object.freeze([
  "setup",
  "floorPlan",
  "burgerLevel",
  "players",
  "order",
  "stations",
  "score",
  "clock",
  "serving",
  "health",
]);

export const REQUIRED_SNAPSHOT_FIELDS = FRONTEND_SNAPSHOT_FIELDS;

export const FRONTEND_SNAPSHOT_FIELD_CONTRACT = Object.freeze({
  setup: "object",
  floorPlan: "object",
  burgerLevel: "object",
  players: "array",
  order: "object-or-null",
  stations: "array",
  score: "object",
  clock: "object",
  serving: "object",
  health: "object",
  orders: "array",
  gold: "object",
  tips: "object",
});

export const FRONTEND_SNAPSHOT_CONTRACT = Object.freeze({
  schemaVersion: FRONTEND_SNAPSHOT_VERSION,
  requiredTopLevelFields: FRONTEND_SNAPSHOT_FIELDS,
  fields: FRONTEND_SNAPSHOT_FIELD_CONTRACT,
  optionalTopLevelFields: Object.freeze(["orders", "gold", "tips"]),
  maxActiveOrders: 4,
  floorPlan: Object.freeze({
    coordinateSpace: ROOM_COORDINATE_SPACE,
    dimensions: Object.freeze({ width: "finite-positive", height: "finite-positive" }),
    layoutFromImage: "optional-boolean",
  }),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeValue(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function fieldIsValid(value, expectedType) {
  if (expectedType === "object-or-null") return value === null || isRecord(value);
  return expectedType === "array" ? Array.isArray(value) : isRecord(value);
}

function invalidField(field, expected, actual, message) {
  return { field, expected, actual, message };
}

function isFinitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function coordinateErrors(item, path) {
  const errors = [];
  if (!isRecord(item)) {
    return [invalidField(path, "object", describeValue(item), `${path} must be an object.`)];
  }

  for (const coordinate of ["x", "y"]) {
    if (!Number.isFinite(Number(item[coordinate])) || Number(item[coordinate]) < 0 || Number(item[coordinate]) > 100) {
      errors.push(invalidField(
        `${path}.${coordinate}`,
        "number between 0 and 100",
        describeValue(item[coordinate]),
        `${path}.${coordinate} must be normalized to 0-100.`,
      ));
    }
  }

  for (const dimension of ["width", "height"]) {
    if (!isFinitePositive(item[dimension]) || Number(item[dimension]) > 100) {
      errors.push(invalidField(
        `${path}.${dimension}`,
        "positive number up to 100",
        describeValue(item[dimension]),
        `${path}.${dimension} must be a normalized positive size.`,
      ));
    }
  }

  if (Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.width))
    && Number(item.x) >= 0 && Number(item.x) <= 100
    && isFinitePositive(item.width) && Number(item.width) <= 100
    && Number(item.x) + Number(item.width) > 100) {
    errors.push(invalidField(
      `${path}.width`,
      "rectangle contained within 0-100",
      describeValue(item.width),
      `${path} must fit within normalized horizontal bounds.`,
    ));
  }

  if (Number.isFinite(Number(item.y)) && Number.isFinite(Number(item.height))
    && Number(item.y) >= 0 && Number(item.y) <= 100
    && isFinitePositive(item.height) && Number(item.height) <= 100
    && Number(item.y) + Number(item.height) > 100) {
    errors.push(invalidField(
      `${path}.height`,
      "rectangle contained within 0-100",
      describeValue(item.height),
      `${path} must fit within normalized vertical bounds.`,
    ));
  }

  return errors;
}

function pointErrors(point, path) {
  if (!isRecord(point)) {
    return [invalidField(path, "object", describeValue(point), `${path} must be an object.`)];
  }

  return ["x", "y"].flatMap((coordinate) => {
    if (Number.isFinite(Number(point[coordinate])) && Number(point[coordinate]) >= 0 && Number(point[coordinate]) <= 100) return [];
    return [invalidField(
      `${path}.${coordinate}`,
      "number between 0 and 100",
      describeValue(point[coordinate]),
      `${path}.${coordinate} must be normalized to 0-100.`,
    )];
  });
}

export function validateFloorPlanContract(floorPlan) {
  if (!isRecord(floorPlan)) return [];
  const errors = [];

  if (Object.prototype.hasOwnProperty.call(floorPlan, "layoutFromImage")
    && typeof floorPlan.layoutFromImage !== "boolean") {
    errors.push(invalidField(
      "floorPlan.layoutFromImage",
      "boolean",
      describeValue(floorPlan.layoutFromImage),
      "floorPlan.layoutFromImage must be a boolean when supplied.",
    ));
  }

  if (floorPlan.coordinateSpace !== ROOM_COORDINATE_SPACE) {
    errors.push(invalidField(
      "floorPlan.coordinateSpace",
      ROOM_COORDINATE_SPACE,
      describeValue(floorPlan.coordinateSpace),
      `Invalid floor plan coordinate space: expected ${ROOM_COORDINATE_SPACE}.`,
    ));
  }

  for (const dimension of ["width", "height"]) {
    if (!isFinitePositive(floorPlan[dimension])) {
      errors.push(invalidField(
        `floorPlan.${dimension}`,
        "finite positive number",
        describeValue(floorPlan[dimension]),
        `Invalid floor plan ${dimension}: expected a finite positive number.`,
      ));
    }
  }

  for (const collection of ["walls", "stations"]) {
    if (!Array.isArray(floorPlan[collection])) {
      errors.push(invalidField(
        `floorPlan.${collection}`,
        "array",
        describeValue(floorPlan[collection]),
        `floorPlan.${collection} must be an array.`,
      ));
      continue;
    }
    floorPlan[collection].forEach((item, index) => {
      errors.push(...coordinateErrors(item, `floorPlan.${collection}[${index}]`));
    });
  }

  return errors;
}

/**
 * Validate only the stable top-level boundary of a snapshot.
 * Nested payloads remain extensible so existing laptop-server data is preserved.
 */
export function validateFrontendSnapshot(snapshot) {
  const missing = [];
  const invalid = [];
  const errors = [];

  if (!isRecord(snapshot)) {
    const actual = describeValue(snapshot);
    const error = invalidField("snapshot", "object", actual, "Snapshot must be a non-null object.");
    invalid.push(error);
    errors.push(error);
    return { valid: false, missing, invalid, errors };
  }

  for (const field of FRONTEND_SNAPSHOT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, field)) {
      missing.push(field);
      errors.push({ field, code: "missing", message: `Missing required top-level field: ${field}.` });
      continue;
    }

    const expected = FRONTEND_SNAPSHOT_FIELD_CONTRACT[field];
    if (!fieldIsValid(snapshot[field], expected)) {
      const error = invalidField(
        field,
        expected,
        describeValue(snapshot[field]),
        `Invalid top-level field: ${field} must be a ${expected}.`,
      );
      invalid.push(error);
      errors.push(error);
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, "orders")) {
    if (!Array.isArray(snapshot.orders)) {
      const error = invalidField("orders", "array", describeValue(snapshot.orders), "Invalid optional field: orders must be an array.");
      invalid.push(error);
      errors.push(error);
    } else {
      const activeOrderCount = snapshot.orders.filter((order) => isRecord(order) && order.status === "active").length;
      if (activeOrderCount > FRONTEND_SNAPSHOT_CONTRACT.maxActiveOrders) {
        const error = invalidField("orders", "array with at most 4 active items", `${activeOrderCount} active orders`, "orders must contain at most 4 active orders.");
        invalid.push(error);
        errors.push(error);
      }
      const ids = new Set();
      snapshot.orders.forEach((order, index) => {
        if (!isRecord(order)) {
          const error = invalidField(`orders[${index}]`, "object", describeValue(order), `orders[${index}] must be an object.`);
          invalid.push(error);
          errors.push(error);
          return;
        }
        if (typeof order.id !== "string" || order.id.trim() === "") {
          const error = invalidField(`orders[${index}].id`, "non-empty string", describeValue(order.id), `orders[${index}].id must be a non-empty string.`);
          invalid.push(error);
          errors.push(error);
          return;
        }
        if (ids.has(order.id)) {
          const error = invalidField(`orders[${index}].id`, "unique string", order.id, `orders contains duplicate id: ${order.id}.`);
          invalid.push(error);
          errors.push(error);
        }
        ids.add(order.id);
      });
    }
  }

  for (const field of ["gold", "tips"]) {
    if (Object.prototype.hasOwnProperty.call(snapshot, field) && !isRecord(snapshot[field])) {
      const error = invalidField(field, "object", describeValue(snapshot[field]), `Invalid optional field: ${field} must be an object.`);
      invalid.push(error);
      errors.push(error);
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, "schemaVersion")
    && (snapshot.schemaVersion !== FRONTEND_SNAPSHOT_VERSION
      || !Number.isInteger(snapshot.schemaVersion))) {
    const error = invalidField(
      "schemaVersion",
      FRONTEND_SNAPSHOT_VERSION,
      describeValue(snapshot.schemaVersion),
      `Unsupported snapshot version: expected ${FRONTEND_SNAPSHOT_VERSION}.`,
    );
    invalid.push(error);
    errors.push(error);
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, "version")
    && (!Number.isInteger(snapshot.version) || snapshot.version < 1)) {
    const error = invalidField("version", "positive integer revision", describeValue(snapshot.version), "Snapshot revision must be a positive integer.");
    invalid.push(error);
    errors.push(error);
  }

  if (isRecord(snapshot.setup)
    && Object.prototype.hasOwnProperty.call(snapshot.setup, "phase")
    && !Object.values(SETUP_PHASES).includes(snapshot.setup.phase)) {
    const error = invalidField(
      "setup.phase",
      Object.values(SETUP_PHASES),
      snapshot.setup.phase,
      "Invalid setup phase.",
    );
    invalid.push(error);
    errors.push(error);
  }

  const floorPlanErrors = validateFloorPlanContract(snapshot.floorPlan);
  invalid.push(...floorPlanErrors);
  errors.push(...floorPlanErrors);

  if (Array.isArray(snapshot.players)) {
    snapshot.players.forEach((player, index) => {
      if (isRecord(player) && player.position != null) {
        const playerErrors = pointErrors(player.position, `players[${index}].position`);
        invalid.push(...playerErrors);
        errors.push(...playerErrors);
      }
    });
  }

  return { valid: errors.length === 0, missing, invalid, errors };
}

function normalizedRectangle(item, scaleX, scaleY) {
  if (!isRecord(item)) return item;
  return {
    ...item,
    x: Number(item.x) * scaleX,
    y: Number(item.y) * scaleY,
    width: Number(item.width) * scaleX,
    height: Number(item.height) * scaleY,
  };
}

function normalizedPoint(item, scaleX, scaleY) {
  if (!isRecord(item)) return item;
  return { ...item, x: Number(item.x) * scaleX, y: Number(item.y) * scaleY };
}

function isServerSnapshot(snapshot) {
  return ["pi-server", "root-server", "pi-server-simulator", "root-server-simulator"].includes(snapshot?.source)
    || (snapshot?.floorPlan?.units === "m" && snapshot?.players?.some((player) => isRecord(player?.simulatedLocation)));
}

function normalizeLaptopFloorPlan(floorPlan) {
  if (floorPlan?.coordinateSpace != null) return floorPlan;
  const width = Number(floorPlan?.width);
  const height = Number(floorPlan?.height);
  if (!isFinitePositive(width) || !isFinitePositive(height)) return floorPlan;
  const scaleX = 100 / width;
  const scaleY = 100 / height;
  return {
    ...floorPlan,
    coordinateSpace: ROOM_COORDINATE_SPACE,
    width: 100,
    height: 100,
    walls: Array.isArray(floorPlan.walls)
      ? floorPlan.walls.map((wall) => normalizedRectangle(wall, scaleX, scaleY))
      : floorPlan.walls,
    stations: Array.isArray(floorPlan.stations)
      ? floorPlan.stations.map((station) => normalizedRectangle(station, scaleX, scaleY))
      : floorPlan.stations,
    placementInstructions: Array.isArray(floorPlan.placementInstructions)
      ? floorPlan.placementInstructions.map((instruction) => normalizedPoint(instruction, scaleX, scaleY))
      : floorPlan.placementInstructions,
  };
}

function stationPosition(stationId, floorPlan) {
  const physicalStationId = String(stationId || "center").startsWith("stove-") ? "stove" : stationId;
  const station = floorPlan?.stations?.find((candidate) => candidate.id === physicalStationId);
  if (!station) return { x: 50, y: 50 };
  return {
    x: Number(station.x) + (Number(station.width) / 2),
    y: Number(station.y) + (Number(station.height) / 2),
  };
}

export function normalizeFrontendSnapshot(snapshot) {
  if (!isRecord(snapshot) || !isServerSnapshot(snapshot)) return isRecord(snapshot) ? { ...snapshot } : snapshot;
  const floorPlan = normalizeLaptopFloorPlan(snapshot.floorPlan);
  const score = isRecord(snapshot.score)
    ? snapshot.score
    : {
        value: Number(snapshot.money?.net ?? snapshot.gold?.total ?? 0) || 0,
        delivered: Number(snapshot.delivered ?? snapshot.submissions?.filter((submission) => submission?.status === "accepted").length ?? 0) || 0,
      };
  const scaleX = floorPlan === snapshot.floorPlan ? 1 : 100 / Number(snapshot.floorPlan?.width);
  const scaleY = floorPlan === snapshot.floorPlan ? 1 : 100 / Number(snapshot.floorPlan?.height);
  const placementInstructions = Array.isArray(snapshot.burgerLevel?.placementInstructions)
    ? snapshot.burgerLevel.placementInstructions.map((instruction) => normalizedPoint(instruction, scaleX, scaleY))
    : snapshot.burgerLevel?.placementInstructions;
  return {
    ...snapshot,
    floorPlan,
    score,
    burgerLevel: isRecord(snapshot.burgerLevel)
      ? { ...snapshot.burgerLevel, placementInstructions }
      : snapshot.burgerLevel,
    players: Array.isArray(snapshot.players) ? snapshot.players.map((player) => {
      if (!isRecord(player) || player.position != null) return player;
      const stationId = player.simulatedLocation?.stationId || player.currentStation || "center";
      return {
        ...player,
        position: stationPosition(stationId, floorPlan),
        location: player.simulatedLocation?.label || stationId,
        positionSource: player.simulatedLocation?.source || "action-inference",
      };
    }) : snapshot.players,
  };
}

export function validateAndNormalizeSnapshot(snapshot) {
  const normalized = normalizeFrontendSnapshot(snapshot);
  return {
    ...validateFrontendSnapshot(normalized),
    snapshot: normalized,
    normalized,
  };
}

export const validateSnapshot = validateFrontendSnapshot;
export const normalizeSnapshot = normalizeFrontendSnapshot;
