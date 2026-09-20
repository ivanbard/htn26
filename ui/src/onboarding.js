import { isStale } from "./state.js";

export const ONBOARDING_SCREENS = Object.freeze({
  WELCOME: "welcome",
  LEVEL: "level",
  PHOTOS: "photos",
  PLAYERS: "players",
  TUTORIAL: "tutorial",
  WAITING: "waiting",
});

export const MAX_PLAYERS = 3;
export const DEFAULT_MAX_STARS = 3;

/**
 * The UI can show up to three fixed badge slots. A slot is playable only when
 * the server has supplied a player that is connected and not stale. Missing
 * slots intentionally remain visible so the lobby communicates capacity.
 */
export function playerSlotState(player, now = Date.now()) {
  if (!player) return "waiting";
  const trackingStatus = String(player.tracking?.status || player.status || "healthy").toLowerCase();
  const unavailable = ["offline", "lost", "stale", "failed", "disconnected"].includes(trackingStatus);
  const loaded = player.loaded !== false && player.connected !== false && !unavailable && !isStale(player, now, 30_000);
  return loaded ? "ready" : "waiting";
}

export function lobbyPlayers(players = [], now = Date.now()) {
  return Array.from({ length: MAX_PLAYERS }, (_, index) => {
    const player = Array.isArray(players) ? players[index] : undefined;
    return {
      index,
      player,
      state: playerSlotState(player, now),
    };
  });
}

export function maxScoreForOrders(orders = []) {
  return orders.reduce((total, order) => total + Math.max(0, Number(order?.goldValue) || 0), 0);
}

/**
 * Star thresholds are a presentation rule for the final card, not game
 * authority. The server supplies score and order results; this maps the final
 * score to the level's configured star count.
 */
export function calculateStarRating({ score = 0, maxScore = 0, maxStars = DEFAULT_MAX_STARS } = {}) {
  const available = Math.max(0, Math.min(3, Math.floor(Number(maxStars) || 0)));
  if (!available) return 0;
  const ratio = Number(maxScore) > 0 ? Math.max(0, Number(score) || 0) / Number(maxScore) : 0;
  const thresholds = available === 1 ? [0.6] : available === 2 ? [0.45, 0.75] : [0.35, 0.65, 0.9];
  return thresholds.reduce((stars, threshold, index) => ratio >= threshold ? index + 1 : stars, 0);
}

/**
 * Tally a round's orders for the results screen. Pass the full history when the
 * transport supplies it; active-only lists still work (they just under-count).
 */
export function summarizeOrders(orders = []) {
  const list = Array.isArray(orders) ? orders : [];
  const count = (status) => list.filter((order) => String(order?.status || "").toLowerCase() === status).length;
  return {
    issued: list.length,
    served: count("completed"),
    expired: count("expired"),
    active: count("active"),
    maxScore: maxScoreForOrders(list),
  };
}
