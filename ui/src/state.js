export const SETUP_PHASES = Object.freeze({
  IDLE: "idle",
  SCANNING: "scanning",
  LAYOUT_PROPOSED: "layout-proposed",
  BURGER_PLACEMENT: "burger-placement",
  LAYOUT_ACCEPTED: "layout-accepted",
  RUNNING: "running",
  ENDED: "ended",
});

export const UI_DISPLAY_MODES = Object.freeze({
  SETUP: "setup",
  GAMEPLAY: "gameplay",
  RESULTS: "results",
});

// Alias kept intentionally so renderer code can use the shorter domain name.
export const DISPLAY_MODES = UI_DISPLAY_MODES;

const SETUP_PHASE_DISPLAY_MODES = Object.freeze({
  [SETUP_PHASES.IDLE]: UI_DISPLAY_MODES.SETUP,
  [SETUP_PHASES.SCANNING]: UI_DISPLAY_MODES.SETUP,
  [SETUP_PHASES.LAYOUT_PROPOSED]: UI_DISPLAY_MODES.SETUP,
  [SETUP_PHASES.BURGER_PLACEMENT]: UI_DISPLAY_MODES.SETUP,
  [SETUP_PHASES.LAYOUT_ACCEPTED]: UI_DISPLAY_MODES.SETUP,
  [SETUP_PHASES.RUNNING]: UI_DISPLAY_MODES.GAMEPLAY,
  [SETUP_PHASES.ENDED]: UI_DISPLAY_MODES.RESULTS,
});

export function displayModeForPhase(phase) {
  return SETUP_PHASE_DISPLAY_MODES[phase] ?? null;
}

export const modeForSetupPhase = displayModeForPhase;

export const GAME_ACTIONS = Object.freeze({
  START_HOST: "START_HOST",
  SCAN_ROOM: "SCAN_ROOM",
  APPROVE_LAYOUT: "APPROVE_LAYOUT",
  // Kept as a protocol alias for existing master-Pi adapters.
  ACCEPT_LAYOUT: "APPROVE_LAYOUT",
  RESCAN: "RESCAN",
  START_GAME: "START_GAME",
  END_GAME: "END_GAME",
  RESET_GAME: "RESET_GAME",
  DELIVERY_SUCCESS: "DELIVERY_SUCCESS",
  DELIVERY_FAILURE: "DELIVERY_FAILURE",
});

export function cloneState(state) {
  return state == null ? state : structuredClone(state);
}

export function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function staleAfterMs(item, fallback = 2_000) {
  const value = Number(item?.staleAfterMs ?? item?.tracking?.staleAfterMs);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function isStale(item, now, fallback = 2_000) {
  const status = String(item?.status || item?.tracking?.status || "").toLowerCase();
  if (["stale", "lost", "offline", "failed"].includes(status)) return true;
  const seen = timestampMs(item?.lastSeenAt ?? item?.tracking?.lastSeenAt);
  if (seen == null || !Number.isFinite(now)) return true;
  return now - seen > staleAfterMs(item, fallback);
}

export function playerPosition(player) {
  const position = player?.position || player;
  if (!Number.isFinite(Number(position?.x)) || !Number.isFinite(Number(position?.y))) return null;
  return position;
}

export function healthStatus(item, now) {
  const status = String(item?.status || "healthy").toLowerCase();
  if (["failed", "offline", "lost"].includes(status)) return "offline";
  if (["degraded", "warning"].includes(status)) return "degraded";
  if (isStale(item, now, 5_000)) return "stale";
  return "healthy";
}

export function trackingCoverage(state, now) {
  const health = state?.health || {};
  const workers = health.workers || health.cameras || [];
  const unhealthy = workers.some((worker) => healthStatus(worker, now) !== "healthy");
  const declared = String(health.trackingCoverage || "").toLowerCase();
  if (unhealthy || ["degraded", "lost", "stale"].includes(declared)) return "degraded";
  if (["healthy", "good"].includes(declared)) return "healthy";
  return workers.length ? "healthy" : "unknown";
}

export function formatSeconds(value) {
  if (value == null || !Number.isFinite(Number(value))) return "--:--";
  const seconds = Math.max(0, Math.round(Number(value)));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function progressPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric <= 1 ? numeric * 100 : numeric));
}

/**
 * Station progress as a 0-100 percentage. The Pi projection sends `progress` as
 * a 0..1 fraction (values above 1 are read as an already-percent value). A
 * station that only reports `remainingSeconds` + `totalSeconds` (or
 * `durationSeconds`) is derived from those; a missing/null `progress` never
 * counts as "0", so it cannot mask the remaining/total pair.
 */
export function stationProgressPercent(station) {
  const raw = station?.progress;
  if (raw != null && raw !== "" && Number.isFinite(Number(raw))) return progressPercent(raw);
  const remaining = Number(station?.remainingSeconds);
  const total = Number(station?.totalSeconds ?? station?.durationSeconds);
  if (station?.remainingSeconds != null && Number.isFinite(remaining) && Number.isFinite(total) && total > 0) {
    return progressPercent(1 - (remaining / total));
  }
  return 0;
}

// Only workstations run timers. Ingredient sources, the assembly counter and
// serving never show a progress bar.
const WORKSTATION_KINDS = new Set(["stove", "chop"]);

/**
 * Pair each layout station with its runtime (authoritative) station.
 *
 * An exact id match always wins. The Pi plan names one physical `stove` while
 * its runtime stations are `stove-left` / `stove-right` (and `cutting-board`),
 * so a workstation with no id match falls back to the first runtime station of
 * the same `kind` that no other layout station has claimed.
 */
export function matchRuntimeStations(layoutStations, runtimeStations) {
  const layout = Array.isArray(layoutStations) ? layoutStations : [];
  const runtime = Array.isArray(runtimeStations) ? runtimeStations.filter((station) => station && typeof station === "object") : [];
  const matches = new Map();
  const claimed = new Set();
  for (const station of layout) {
    const exact = runtime.find((candidate) => candidate.id === station?.id && !claimed.has(candidate));
    if (exact) {
      matches.set(station.id, exact);
      claimed.add(exact);
    }
  }
  for (const station of layout) {
    if (!station || matches.has(station.id) || !WORKSTATION_KINDS.has(station.kind)) continue;
    const fallback = runtime.find((candidate) => candidate.kind === station.kind && !claimed.has(candidate));
    if (fallback) {
      matches.set(station.id, fallback);
      claimed.add(fallback);
    }
  }
  return matches;
}

export function canRunAction(state, action) {
  const phase = state?.setup?.phase;
  switch (action) {
    case GAME_ACTIONS.START_HOST:
      return phase === SETUP_PHASES.IDLE || phase === SETUP_PHASES.ENDED;
    case GAME_ACTIONS.SCAN_ROOM:
      return phase === SETUP_PHASES.SCANNING;
    case GAME_ACTIONS.APPROVE_LAYOUT:
      return phase === SETUP_PHASES.LAYOUT_PROPOSED && state?.floorPlan?.accepted !== true;
    case GAME_ACTIONS.RESCAN:
      return [
        SETUP_PHASES.SCANNING,
        SETUP_PHASES.LAYOUT_PROPOSED,
        SETUP_PHASES.BURGER_PLACEMENT,
        SETUP_PHASES.LAYOUT_ACCEPTED,
      ].includes(phase);
    case GAME_ACTIONS.START_GAME:
      return state?.floorPlan?.accepted === true
        && [SETUP_PHASES.BURGER_PLACEMENT, SETUP_PHASES.LAYOUT_ACCEPTED].includes(phase);
    case GAME_ACTIONS.END_GAME:
      return phase === SETUP_PHASES.RUNNING;
    case GAME_ACTIONS.RESET_GAME:
      return true;
    default:
      return false;
  }
}
