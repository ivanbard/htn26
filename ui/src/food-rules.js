// Display-only ingredient state rules shared by stations, player hands, and
// plates. The master Pi remains authoritative; this module only decides which
// supplied asset represents a state in the UI.

export const PLATABLE_ITEM_STATES = Object.freeze({
  BUN: Object.freeze(["BUN", "BUNS"]),
  COOKED_MEAT: Object.freeze(["COOKED MEAT", "COOKED MEAT PATTY", "DONE MEAT"]),
  CHOPPED_CHEESE: Object.freeze(["CHOPPED CHEESE", "SHREDDED CHEESE", "SLICED CHEESE", "CUT CHEESE"]),
  SHREDDED_LETTUCE: Object.freeze(["SHREDDED LETTUCE", "SLICED LETTUCE", "CHOPPED LETTUCE", "CUT LETTUCE"]),
});

const PLAIN_PLATE_COMPONENTS = Object.freeze({ BUN: "BUN", MEAT: "MEAT", LETTUCE: "LETTUCE", CHEESE: "CHEESE" });

const normalize = (value) => String(value || "")
  .trim()
  .toUpperCase()
  .replaceAll(/[_-]+/g, " ")
  .replaceAll(/\s+/g, " ");

function includesAny(value, candidates) {
  return candidates.some((candidate) => value === candidate || value.includes(candidate));
}

export function plateableState(value) {
  const normalized = normalize(value);
  if (!normalized || normalized.includes("BURNT") || normalized.includes("RAW")) return null;
  // The authoritative server normalizes plate contents to the bare component
  // names, so an exact BUN/MEAT/LETTUCE/CHEESE is already a plated item. Only an
  // exact match counts: "CHOPPED MEAT" (uncooked) must still be rejected below.
  if (PLAIN_PLATE_COMPONENTS[normalized]) return PLAIN_PLATE_COMPONENTS[normalized];
  if (includesAny(normalized, PLATABLE_ITEM_STATES.BUN)) return "BUN";
  if (includesAny(normalized, PLATABLE_ITEM_STATES.COOKED_MEAT)) return "MEAT";
  if (includesAny(normalized, PLATABLE_ITEM_STATES.CHOPPED_CHEESE)) return "CHEESE";
  if (includesAny(normalized, PLATABLE_ITEM_STATES.SHREDDED_LETTUCE)) return "LETTUCE";
  return null;
}

export function plateableIngredientKeys(values) {
  const source = Array.isArray(values) ? values : [values];
  return source.map(plateableState).filter(Boolean);
}

const COOKING_STATE_LABELS = Object.freeze({
  cooking: "COOKING",
  cooked: "COOKED",
  burnt: "BURNT",
  raw: "RAW",
  chopping: "CHOPPING",
  ready: "READY",
  idle: "IDLE",
  empty: "EMPTY",
});

/**
 * Map server-provided item/status values to a small visual vocabulary. This
 * never changes the item or its authoritative progress; it only makes the
 * projector state legible at a glance.
 */
export function cookingVisualState({ status, item, progress } = {}) {
  const statusValue = normalize(status);
  const itemValue = normalize(item);
  const combined = `${statusValue} ${itemValue}`;
  if (combined.includes("BURNT") || combined.includes("BURNED") || combined.includes("OVERCOOK")) return "burnt";
  if (combined.includes("COOKING") || combined.includes("PROCESSING")) return "cooking";
  if (combined.includes("CHOPPING") || combined.includes("CHOP")) return "chopping";
  if (combined.includes("COOKED") || combined.includes("DONE MEAT") || combined.includes("DONE")) return "cooked";
  if (combined.includes("RAW") || combined.includes("UNCOOKED")) return "raw";
  if (statusValue.includes("READY") || statusValue.includes("DONE")) return "ready";
  if (statusValue.includes("IDLE") || !statusValue && !itemValue && Number(progress || 0) === 0) return "idle";
  if (!itemValue || itemValue === "EMPTY") return "empty";
  return statusValue || "ready";
}

export function cookingStateLabel(state) {
  return COOKING_STATE_LABELS[state] || String(state || "READY").toUpperCase();
}
