const DIFFICULTIES = new Set(["easy", "normal", "hectic"]);
const RESPONSE_KEYS = new Set(["schemaVersion", "difficulty", "source", "model", "latencyMs"]);
const MODEL_KEYS = new Set(["name", "version", "artifact"]);
const FEATURE_KEYS = ["activeOrderPressure", "recentFailureRate", "busyStovePressure", "roundElapsed"];
const MAX_RESPONSE_BYTES = 4096;

function hasExactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === allowed.size
    && Object.keys(value).every((key) => allowed.has(key));
}

function shortString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function normalizeDifficultyFeatures(features) {
  if (!features || typeof features !== "object" || Array.isArray(features)
    || Object.keys(features).length !== FEATURE_KEYS.length
    || !Object.keys(features).every((key) => FEATURE_KEYS.includes(key))) {
    throw new Error("difficulty features must contain exactly the v1 feature set");
  }
  return Object.fromEntries(FEATURE_KEYS.map((key) => {
    const value = Number(features[key]);
    if (!Number.isFinite(value)) throw new Error(`${key} must be finite`);
    return [key, Math.max(0, Math.min(1, value))];
  }));
}

export function validateDifficultyResponse(value) {
  if (!hasExactKeys(value, RESPONSE_KEYS)) throw new Error("invalid difficulty sidecar response fields");
  if (value.schemaVersion !== 1) throw new Error("unsupported difficulty sidecar schemaVersion");
  if (!DIFFICULTIES.has(value.difficulty)) throw new Error("invalid difficulty label");
  if (!shortString(value.source)) throw new Error("invalid difficulty source");
  if (!hasExactKeys(value.model, MODEL_KEYS)
    || !shortString(value.model.name) || !shortString(value.model.version) || !shortString(value.model.artifact)) {
    throw new Error("invalid difficulty model metadata");
  }
  if (!Number.isFinite(value.latencyMs) || value.latencyMs < 0) throw new Error("invalid difficulty latency");
  return {
    difficulty: value.difficulty,
    source: value.source,
    model: { ...value.model },
    latencyMs: value.latencyMs,
  };
}

export class DifficultySidecarClient {
  constructor({ baseUrl, timeoutMs = 200, fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl) throw new Error("difficulty sidecar baseUrl is required");
    if (typeof fetchImpl !== "function") throw new Error("difficulty sidecar requires fetch");
    this.endpoint = new URL("/v1/recommendation", baseUrl).href;
    this.timeoutMs = Math.max(1, Math.min(5_000, Number(timeoutMs) || 200));
    this.fetchImpl = fetchImpl;
  }

  async recommend(features) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, features: normalizeDifficultyFeatures(features) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`difficulty sidecar returned HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("difficulty sidecar response is too large");
      return validateDifficultyResponse(JSON.parse(text));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const DIFFICULTY_LABELS = DIFFICULTIES;
