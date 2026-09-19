const MARKER = "HTN26|";
const MAX_PAYLOAD_BYTES = 44;
const MAC_RE = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/;

function splitFields(value) {
  return value.split("|");
}

function isPrintableValue(value) {
  return value.length > 0 && [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e && character !== "|";
  });
}

function parseInteger(value, minimum, maximum) {
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizeMac(value) {
  return MAC_RE.test(value) ? value.toUpperCase() : "";
}

export function parseGatewayRxLine(line) {
  const marker = String(line).indexOf(MARKER);
  if (marker < 0) return { ok: false, error: "missing HTN26 marker" };
  const fields = splitFields(String(line).slice(marker).trim());
  if (fields.length !== 8 || fields[0] !== "HTN26" || fields[1] !== "RX") {
    return { ok: false, error: "invalid RX field count or prefix" };
  }
  const senderMac = normalizeMac(fields[2]);
  if (!senderMac) return { ok: false, error: "invalid sender MAC" };
  const rssi = parseInteger(fields[3], -127, 20);
  if (rssi == null) return { ok: false, error: "invalid RSSI" };
  if (fields[4] !== "OC1") return { ok: false, error: "unsupported badge protocol" };
  const sequence = parseInteger(fields[5], 0, 0xffffffff);
  if (sequence == null) return { ok: false, error: "invalid badge sequence" };
  if (!/^[NMBHE]$/.test(fields[6])) return { ok: false, error: "invalid badge event type" };
  if (!isPrintableValue(fields[7])) return { ok: false, error: "invalid badge value" };
  const payload = `${fields[4]}|${fields[5]}|${fields[6]}|${fields[7]}`;
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: "badge payload exceeds 44 bytes" };
  }
  return {
    ok: true,
    kind: "badge-event",
    intent: { senderMac, rssi, sequence, type: fields[6], value: fields[7] },
  };
}

export function parseGatewayStatusLine(line) {
  const marker = String(line).indexOf(MARKER);
  if (marker < 0) return { ok: false, error: "missing HTN26 marker" };
  const fields = splitFields(String(line).slice(marker).trim());
  if (fields.length !== 5 || fields[0] !== "HTN26" || fields[1] !== "GW") {
    return { ok: false, error: "invalid gateway status field count or prefix" };
  }
  if (fields[2] !== "UP" && fields[2] !== "DOWN") return { ok: false, error: "invalid gateway status" };
  const packetCount = parseInteger(fields[3], 0, Number.MAX_SAFE_INTEGER);
  const droppedCount = parseInteger(fields[4], 0, Number.MAX_SAFE_INTEGER);
  if (packetCount == null || droppedCount == null) return { ok: false, error: "invalid gateway counters" };
  return { ok: true, kind: "gateway-status", status: { up: fields[2] === "UP", packetCount, droppedCount } };
}

/**
 * Parse one noisy USB gateway line. This is intentionally independent from
 * readline, serialport, or QNX device APIs so fixtures and the QNX adapter use
 * exactly the same validation boundary.
 */
export function parseGatewaySerialLine(line) {
  const text = String(line);
  if (text.includes("HTN26|GW|")) return parseGatewayStatusLine(text);
  if (text.includes("HTN26|RX|")) return parseGatewayRxLine(text);
  return { ok: false, error: "unknown HTN26 record" };
}

export function createSerialAdapter({ onRecord = () => {} } = {}) {
  let lines = 0;
  let accepted = 0;
  let malformed = 0;
  return {
    ingest(line) {
      lines += 1;
      const record = parseGatewaySerialLine(line);
      if (!record.ok) malformed += 1;
      else {
        accepted += 1;
        onRecord(record);
      }
      return record;
    },
    stats() { return { lines, accepted, malformed }; },
  };
}

/**
 * Chunk adapter for a real serial stream. USB reads may split a record at any
 * byte boundary and the badge may prefix records with human-readable logs.
 */
export function createSerialStreamAdapter({ onRecord = () => {} } = {}) {
  const lineAdapter = createSerialAdapter({ onRecord });
  let pending = "";
  return {
    ingest(line) { return lineAdapter.ingest(line); },
    push(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) lineAdapter.ingest(line);
    },
    flush() {
      if (pending) lineAdapter.ingest(pending);
      pending = "";
    },
    stats() { return lineAdapter.stats(); },
  };
}

export function intentToRecord(intent) {
  return { ok: true, kind: "badge-event", intent: { ...intent } };
}

export const BADGE_PAYLOAD_LIMIT = MAX_PAYLOAD_BYTES;
