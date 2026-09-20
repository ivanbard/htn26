// The server reports each player's `actionState` as free text and does not say
// when it changed or that a cut was abandoned. The screen needs both to show a
// short-lived callout ("CUT FAILED") and let it fade, so the browser works them
// out itself by watching how each player's state changes between snapshots.
// Nothing here is authoritative: it only labels and timestamps what was seen.

const CHOPPING = /^chopping\b/i;
const HOLDING_RAW = /^holding raw[ _]/i;

/**
 * Returns `{ annotate(players) }`. Each call takes the players of the newest
 * snapshot and returns copies with:
 *  - `actionStateAt`: when this browser first saw the current state (epoch ms).
 *    A state that was already showing when the page loaded has no stamp
 *    (`null`), so an old result is never replayed as if it just happened.
 *  - `actionState` relabelled `cut failed; ...` when a player went from
 *    "chopping" straight back to holding the same raw item: the only way a cut
 *    ends that way is the player letting go early.
 */
export function createActionTracker(clock = Date.now) {
  const seen = new Map();
  return {
    annotate(players) {
      if (!Array.isArray(players)) return players;
      return players.map((player) => {
        if (!player || typeof player !== "object") return player;
        const raw = String(player.actionState ?? "");
        const previous = seen.get(player.id);
        let entry = previous;
        if (!previous || previous.raw !== raw) {
          const failedCut = Boolean(previous) && CHOPPING.test(previous.raw) && HOLDING_RAW.test(raw);
          entry = { raw, label: failedCut ? `cut failed; ${raw}` : raw, at: previous ? clock() : null };
          seen.set(player.id, entry);
        }
        return { ...player, actionState: entry.label, actionStateAt: entry.at };
      });
    },
  };
}
