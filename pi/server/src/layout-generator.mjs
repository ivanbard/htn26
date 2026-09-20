import { layoutResponsesRequest } from "./layout-prompt.mjs";
import { sanitizeRoomLayout, validateRoomLayout } from "./layout-schema.mjs";

function duration(start) { return Math.max(0, Number(process.hrtime.bigint() - start) / 1_000_000); }

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") return content.text;
      if (typeof content?.value === "string") return content.value;
    }
  }
  return null;
}

export class RoomLayoutGenerationError extends Error {
  constructor(message, metrics = {}) {
    super(message);
    this.name = "RoomLayoutGenerationError";
    this.metrics = metrics;
    this.statusCode = 503;
  }
}

export class OpenAIRoomLayoutGenerator {
  constructor({ apiKey, model = "gpt-5.6-luna", fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async generate(images = [], { preprocessMs: clientPreprocessMs } = {}) {
    const totalStart = process.hrtime.bigint();
    if (!this.apiKey) throw new RoomLayoutGenerationError("room layout generation is not configured");
    if (typeof this.fetchImpl !== "function") throw new RoomLayoutGenerationError("room layout generation is unavailable");
    if (!Array.isArray(images) || images.length < 3 || images.length > 5) throw new RoomLayoutGenerationError("room layout generation requires 3 to 5 photos");
    const preprocessMs = Number.isFinite(Number(clientPreprocessMs)) ? Math.max(0, Number(clientPreprocessMs)) : duration(totalStart);
    const requestStart = process.hrtime.bigint();
    let response;
    try {
      response = await this.fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(layoutResponsesRequest(images, { model: this.model })),
      });
    } catch {
      throw new RoomLayoutGenerationError("room layout provider request failed", { preprocessMs, requestMs: duration(requestStart), totalMs: duration(totalStart) });
    }
    const requestMs = duration(requestStart);
    if (!response?.ok) throw new RoomLayoutGenerationError("room layout provider returned an unavailable response", { preprocessMs, requestMs, totalMs: duration(totalStart) });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new RoomLayoutGenerationError("room layout provider returned invalid JSON", { preprocessMs, requestMs, totalMs: duration(totalStart) });
    }
    const validationStart = process.hrtime.bigint();
    let candidate;
    try {
      const text = responseText(payload);
      if (!text) throw new Error("empty structured response");
      candidate = JSON.parse(text);
    } catch {
      throw new RoomLayoutGenerationError("room layout provider returned invalid structured output", { preprocessMs, requestMs, validationMs: duration(validationStart), totalMs: duration(totalStart) });
    }
    const layout = sanitizeRoomLayout(candidate);
    const schemaErrors = validateRoomLayout(layout);
    const validationMs = duration(validationStart);
    if (schemaErrors.length) throw new RoomLayoutGenerationError("room layout provider returned unusable geometry", { preprocessMs, requestMs, validationMs, totalMs: duration(totalStart) });
    return {
      layout,
      metrics: { preprocessMs, requestMs, validationMs, totalMs: duration(totalStart), photoCount: images.length },
    };
  }
}

export function createRoomLayoutGenerator({ env = process.env, fetchImpl = globalThis.fetch, now } = {}) {
  return new OpenAIRoomLayoutGenerator({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_LAYOUT_MODEL || "gpt-5.6-luna",
    fetchImpl,
    now,
  });
}
