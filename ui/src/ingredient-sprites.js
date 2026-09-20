// Existing top-down ingredient art, selected by the authoritative item state.
// This module only maps presentation; the server remains the source of truth.
const DIR = "/assets/eagle eye view";
const sprite = (name) => `${DIR}/${name}.png`;

const stages = (raw, chopped = raw, cooked = chopped, burnt = cooked) => Object.freeze({ raw, chopped, cooked, burnt });

export const INGREDIENT_SPRITES = Object.freeze({
  BUN: stages(sprite("bun")),
  MEAT: stages(sprite("meat_raw"), sprite("meat_flattened"), sprite("meat_cooked"), sprite("meat_burnt")),
  CHEESE: stages(sprite("cheese_triangle"), sprite("cheese_slice")),
  LETTUCE: stages(sprite("lettuce_head"), sprite("lettuce_leaf")),
});

export const INGREDIENT_KINDS = Object.freeze(Object.keys(INGREDIENT_SPRITES));

export const PLATE_SPRITES = Object.freeze({
  "": sprite("plate"),
  BUN: sprite("plate_bun"),
  CHEESE: sprite("plate_cheese_slice"),
  LETTUCE: sprite("plate_lettuce_leaf"),
  MEAT: sprite("plate_meat_cooked"),
  "CHEESE+MEAT": sprite("plate_meat_cheese"),
  "LETTUCE+MEAT": sprite("plate_meat_lettuce"),
  "CHEESE+LETTUCE+MEAT": sprite("plate_meat_lettuce_cheese"),
});

const PLATED_STAGE = Object.freeze({ BUN: "raw", MEAT: "cooked", CHEESE: "chopped", LETTUCE: "chopped" });
const normalize = (value) => String(value || "").toUpperCase().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ").trim();

export function ingredientStage(value, fallback = "raw") {
  const name = normalize(value);
  if (/\b(BURNT|BURNED|OVERCOOK\w*)\b/.test(name)) return "burnt";
  if (/\b(COOKED|DONE)\b/.test(name)) return "cooked";
  if (/\b(CHOPPED|SHREDDED|SLICED|CUT|FLATTENED)\b/.test(name)) return "chopped";
  if (/\bRAW\b/.test(name)) return "raw";
  return fallback;
}

export function platedStage(kind) { return PLATED_STAGE[kind] || "raw"; }
export function ingredientSprite(kind, stage = "raw") {
  const set = INGREDIENT_SPRITES[kind];
  return set ? set[stage] || set.raw : null;
}
export function plateSprite(kinds = []) {
  const key = [...new Set(kinds)].sort().join("+");
  return PLATE_SPRITES[key] || null;
}
