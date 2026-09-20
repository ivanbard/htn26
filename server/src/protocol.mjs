const MARKER = "HTN26|";
const MAX_PAYLOAD_BYTES = 44;
const MAC_RE = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/;
const PLAYER_ITEMS = new Set([
  "BUN",
  "RAW_MEAT",
  "CHOPPED_MEAT",
  "COOKED_MEAT",
  "RAW_LETTUCE",
  "LETTUCE",
  "RAW_CHEESE",
  "CHEESE",
  "BURNT_MEAT",
]);
const PLATE_RE = /^(?:B|-)(?:M|-)(?:L|-)(?:C|-)$/;

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

function markedFields(line) {
  const marker = String(line).indexOf(MARKER);
  if (marker < 0) return null;
  return splitFields(String(line).slice(marker).trim());
}

function invalid(error) { return { ok: false, error }; }

export function parseGatewayRxLine(line) {
  const fields = markedFields(line);
  if (!fields) return invalid("missing HTN26 marker");
  if (fields.length !== 8 || fields[0] !== "HTN26" || fields[1] !== "RX") {
    return invalid("invalid RX field count or prefix");
  }
  const senderMac = normalizeMac(fields[2]);
  if (!senderMac) return invalid("invalid sender MAC");
  const rssi = parseInteger(fields[3], -127, 20);
  if (rssi == null) return invalid("invalid RSSI");
  if (fields[4] !== "OC2") return invalid("unsupported badge protocol");
  const sequence = parseInteger(fields[5], 0, 0xffffffff);
  if (sequence == null) return invalid("invalid badge sequence");
  if (!/^[NMBHEP]$/.test(fields[6])) return invalid("invalid badge event type");
  if (!isPrintableValue(fields[7])) return invalid("invalid badge value");
  const payload = `${fields[4]}|${fields[5]}|${fields[6]}|${fields[7]}`;
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    return invalid("badge payload exceeds 44 bytes");
  }
  return {
    ok: true,
    kind: "badge-event",
    framing: "legacy-rx",
    intent: { senderMac, rssi, sequence, type: fields[6], value: fields[7] },
  };
}

export function parseGatewayStatusLine(line) {
  const fields = markedFields(line);
  if (!fields) return invalid("missing HTN26 marker");
  if (fields.length !== 5 || fields[0] !== "HTN26" || fields[1] !== "GW") {
    return invalid("invalid gateway status field count or prefix");
  }
  if (fields[2] !== "UP" && fields[2] !== "DOWN") return invalid("invalid gateway status");
  const packetCount = parseInteger(fields[3], 0, Number.MAX_SAFE_INTEGER);
  const droppedCount = parseInteger(fields[4], 0, Number.MAX_SAFE_INTEGER);
  if (packetCount == null || droppedCount == null) return invalid("invalid gateway counters");
  return {
    ok: true,
    kind: "gateway-status",
    framing: "legacy-gw",
    status: { up: fields[2] === "UP", packetCount, droppedCount },
  };
}

export function parseLegacyGameLine(line) {
  const fields = markedFields(line);
  if (!fields) return invalid("missing HTN26 marker");
  if (fields[0] !== "HTN26" || fields[1] !== "GAME") return invalid("invalid GAME prefix");
  if (fields[2] === "START_GAME" && fields.length === 5) {
    const durationSeconds = parseInteger(fields[3], 1, 3600);
    const playerCount = parseInteger(fields[4], 1, 3);
    if (durationSeconds == null || playerCount == null) return invalid("invalid GAME start values");
    return { ok: true, kind: "host-control", framing: "legacy-game", control: "START", durationSeconds, playerCount };
  }
  if (fields[2] === "GAME_END" && fields.length === 4) {
    const playerCount = parseInteger(fields[3], 1, 3);
    if (playerCount == null) return invalid("invalid GAME end player count");
    return { ok: true, kind: "host-control", framing: "legacy-game", control: "END", playerCount };
  }
  if (fields[2] === "RESET_GAME" && (fields.length === 3 || fields.length === 4)) {
    const playerCount = fields.length === 4 ? parseInteger(fields[3], 1, 3) : 3;
    if (playerCount == null) return invalid("invalid GAME reset player count");
    return { ok: true, kind: "host-control", framing: "legacy-game", control: "RESET", playerCount };
  }
  return invalid("unsupported GAME record");
}

function parseCanonicalHost(fields) {
  const control = fields[3];
  if (control === "END" || control === "RESET") {
    if (fields.length !== 4 && fields.length !== 5) return invalid("canonical HOST control has invalid player count");
    const playerCount = fields.length === 5 ? parseInteger(fields[4], 1, 3) : 3;
    if (playerCount == null) return invalid("canonical HOST control has invalid player count");
    return { ok: true, kind: "host-control", framing: "canonical", protocolVersion: 1, control, playerCount };
  }
  if (control === "START" && (fields.length === 4 || fields.length === 6)) {
    if (fields.length === 4) {
      return { ok: true, kind: "host-control", framing: "canonical", protocolVersion: 1, control, durationSeconds: null, playerCount: 3 };
    }
    const durationSeconds = parseInteger(fields[4], 1, 3600);
    const playerCount = parseInteger(fields[5], 1, 3);
    if (durationSeconds == null || playerCount == null) return invalid("canonical HOST START requires a duration and 1-3 players");
    return { ok: true, kind: "host-control", framing: "canonical", protocolVersion: 1, control, durationSeconds, playerCount };
  }
  return invalid("unsupported canonical HOST record");
}

function parseCanonicalGateway(fields) {
  if (fields.length !== 6 || (fields[3] !== "UP" && fields[3] !== "DOWN")) {
    return invalid("canonical GATEWAY requires status, packet count, and drop count");
  }
  const packetCount = parseInteger(fields[4], 0, Number.MAX_SAFE_INTEGER);
  const droppedCount = parseInteger(fields[5], 0, Number.MAX_SAFE_INTEGER);
  if (packetCount == null || droppedCount == null) return invalid("invalid canonical GATEWAY counters");
  return {
    ok: true,
    kind: "gateway-status",
    framing: "canonical",
    protocolVersion: 1,
    status: { up: fields[3] === "UP", packetCount, droppedCount },
  };
}

function playerRecord(playerId, action, details = {}) {
  return { ok: true, kind: "player-action", framing: "canonical", protocolVersion: 1, playerId: `p${playerId}`, action, ...details };
}

function parseCanonicalPlayer(fields) {
  const playerId = parseInteger(fields[3], 1, 3);
  if (playerId == null) return invalid("canonical PLAYER id must be 1, 2, or 3");
  const action = fields[4];
  if (action === "PICKUP" && fields.length === 6 && PLAYER_ITEMS.has(fields[5])) {
    return playerRecord(playerId, "PICKUP", { item: fields[5] });
  }
  if (action === "PLATE" && fields.length === 6 && (fields[5] === "NEW" || PLATE_RE.test(fields[5]))) {
    return playerRecord(playerId, "PLATE", { plate: fields[5] });
  }
  if (action === "CHOP" && fields.length >= 6 && fields.length <= 7) {
    const phase = fields[5];
    if ((phase === "START" || phase === "FAIL") && fields.length === 6) return playerRecord(playerId, "CHOP", { phase });
    if (phase === "DONE" && (fields.length === 6 || (fields.length === 7 && PLAYER_ITEMS.has(fields[6])))) {
      return playerRecord(playerId, "CHOP", { phase, item: fields[6] || null });
    }
  }
  if (action === "STOVE" && (fields.length === 7 || fields.length === 8)) {
    const side = fields[5];
    const operation = fields[6];
    if (!/^(LEFT|RIGHT)$/.test(side)) return invalid("canonical STOVE side must be LEFT or RIGHT");
    if (/^(PLACE|TAKE|CHECK)$/.test(operation) && fields.length === 7) return playerRecord(playerId, "STOVE", { side, operation });
    if (operation === "STATUS" && fields.length === 8 && /^(EMPTY|COOKING|DONE|WARNING|BURNT)$/.test(fields[7])) {
      return playerRecord(playerId, "STOVE", { side, operation, reportedStatus: fields[7] });
    }
  }
  if (action === "DROP" && fields.length === 5) return playerRecord(playerId, "DROP");
  if (action === "LEAVE" && fields.length === 5) return playerRecord(playerId, "LEAVE");
  if (action === "TRANSFER" && fields.length === 6) {
    const target = parseInteger(fields[5], 1, 3);
    if (target != null && target !== playerId) return playerRecord(playerId, "TRANSFER", { targetPlayerId: `p${target}` });
  }
  if (action === "READY" && fields.length === 5) return playerRecord(playerId, "READY");
  return invalid("unsupported canonical PLAYER action");
}

export function parseCanonicalLine(line) {
  const fields = markedFields(line);
  if (!fields) return invalid("missing HTN26 marker");
  if (fields[0] !== "HTN26" || fields[1] !== "1") return invalid("unsupported canonical protocol version");
  if (fields[2] === "HOST") return parseCanonicalHost(fields);
  if (fields[2] === "GATEWAY") return parseCanonicalGateway(fields);
  if (fields[2] === "PLAYER") return parseCanonicalPlayer(fields);
  if (fields[2] === "SUBMIT" && fields.length === 5) {
    const playerId = parseInteger(fields[3], 1, 3);
    if (playerId == null) return invalid("canonical SUBMIT player must be 1, 2, or 3");
    const plate = fields[4];
    if (!PLATE_RE.test(plate) && !/^(PLAIN_MEAT|CHEESEBURGER|LETTUCE_MEAT|CHEESE_LETTUCE_MEAT)$/.test(plate)) {
      return invalid("canonical SUBMIT requires a BMLC plate summary or recipe id");
    }
    return { ok: true, kind: "submission", framing: "canonical", protocolVersion: 1, playerId: `p${playerId}`, plate };
  }
  return invalid("unknown canonical HTN26 record");
}

/** Parse one noisy serial line using the v1 canonical grammar or a legacy badge frame. */
export function parseGatewaySerialLine(line) {
  const text = String(line);
  if (!text.includes(MARKER)) return invalid("missing HTN26 marker");
  if (text.includes("HTN26|1|")) return parseCanonicalLine(text);
  if (text.includes("HTN26|RX|")) return parseGatewayRxLine(text);
  if (text.includes("HTN26|GW|")) return parseGatewayStatusLine(text);
  if (text.includes("HTN26|GAME|")) return parseLegacyGameLine(text);
  return invalid("unknown HTN26 record");
}

/** Return the stable JSON object emitted for an accepted game record. */
export function gameEventLog(record, at = new Date().toISOString()) {
  if (!record || record.kind === "gateway-status") return null;

  const event = { event: "game-event", at, kind: record.kind, framing: record.framing };
  if (record.protocolVersion != null) event.protocolVersion = record.protocolVersion;

  if (record.kind === "badge-event") {
    return {
      ...event,
      senderMac: record.intent.senderMac,
      sequence: record.intent.sequence,
      type: record.intent.type,
      value: record.intent.value,
    };
  }
  if (record.kind === "host-control") {
    return {
      ...event,
      control: record.control,
      ...(record.durationSeconds == null ? {} : { durationSeconds: record.durationSeconds }),
      playerCount: record.playerCount,
    };
  }
  if (record.kind === "player-action") {
    return {
      ...event,
      playerId: record.playerId,
      action: record.action,
      ...(record.item == null ? {} : { item: record.item }),
      ...(record.plate == null ? {} : { plate: record.plate }),
      ...(record.phase == null ? {} : { phase: record.phase }),
      ...(record.side == null ? {} : { side: record.side }),
      ...(record.operation == null ? {} : { operation: record.operation }),
      ...(record.reportedStatus == null ? {} : { reportedStatus: record.reportedStatus }),
      ...(record.targetPlayerId == null ? {} : { targetPlayerId: record.targetPlayerId }),
    };
  }
  if (record.kind === "submission") {
    return { ...event, playerId: record.playerId, plate: record.plate };
  }
  return null;
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

/** USB reads may split records at any byte boundary and include runtime log prefixes. */
export function createSerialStreamAdapter({ onRecord = () => {}, onLine = () => {} } = {}) {
  const lineAdapter = createSerialAdapter({ onRecord });
  const ingest = (line) => {
    onLine(String(line));
    return lineAdapter.ingest(line);
  };
  let pending = "";
  return {
    ingest,
    push(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) ingest(line);
    },
    flush() {
      if (pending) ingest(pending);
      pending = "";
    },
    stats() { return lineAdapter.stats(); },
  };
}

export function intentToRecord(intent) {
  return { ok: true, kind: "badge-event", framing: "fixture", intent: { ...intent } };
}

export const BADGE_PAYLOAD_LIMIT = MAX_PAYLOAD_BYTES;
export const PLATE_SUMMARY_PATTERN = PLATE_RE;
