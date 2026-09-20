// The browser stamps and labels player actions itself (the server does neither).
import assert from "node:assert/strict";
import test from "node:test";
import { createActionTracker } from "../src/action-tracker.js";

const players = (state, id = "p1") => [{ id, actionState: state }];

test("the first state seen has no stamp, so an old result is never replayed on page load", () => {
  const tracker = createActionTracker(() => 1_000);
  const [player] = tracker.annotate(players("order served"));
  assert.equal(player.actionStateAt, null);
  assert.equal(player.actionState, "order served");
});

test("a changed state is stamped when it was first seen and keeps that stamp while unchanged", () => {
  let now = 1_000;
  const tracker = createActionTracker(() => now);
  tracker.annotate(players("idle"));
  now = 5_000;
  assert.equal(tracker.annotate(players("ready to submit"))[0].actionStateAt, 5_000);
  now = 9_000;
  assert.equal(tracker.annotate(players("ready to submit"))[0].actionStateAt, 5_000, "same text, same stamp");
  now = 12_000;
  assert.equal(tracker.annotate(players("idle"))[0].actionStateAt, 12_000);
});

test("chopping then straight back to a raw item is a failed cut, and it stays labelled", () => {
  let now = 0;
  const tracker = createActionTracker(() => now);
  tracker.annotate(players("holding raw_meat"));
  now = 1_000;
  tracker.annotate(players("chopping"));
  now = 2_000;
  const [failed] = tracker.annotate(players("holding raw_meat"));
  assert.equal(failed.actionState, "cut failed; holding raw_meat");
  assert.equal(failed.actionStateAt, 2_000);
  now = 8_000;
  const [later] = tracker.annotate(players("holding raw_meat"));
  assert.equal(later.actionState, "cut failed; holding raw_meat", "the label persists while the server text is unchanged");
  assert.equal(later.actionStateAt, 2_000);
});

test("a completed cut, a pickup, or a drop is never mistaken for a failed cut", () => {
  const tracker = createActionTracker(() => 1);
  tracker.annotate(players("holding raw_meat"));
  tracker.annotate(players("chopping"));
  assert.equal(tracker.annotate(players("holding chopped_meat; chop complete"))[0].actionState, "holding chopped_meat; chop complete");
  const fresh = createActionTracker(() => 1);
  fresh.annotate(players("holding raw_meat"));
  assert.equal(fresh.annotate(players("holding raw_lettuce"))[0].actionState, "holding raw_lettuce", "a plain pickup is not a failure");
  assert.equal(fresh.annotate(players("dropped held state"))[0].actionState, "dropped held state");
});

test("players are tracked independently and non-array input passes through", () => {
  let now = 0;
  const tracker = createActionTracker(() => now);
  tracker.annotate([{ id: "p1", actionState: "idle" }, { id: "p2", actionState: "idle" }]);
  now = 3_000;
  const [one, two] = tracker.annotate([{ id: "p1", actionState: "chopping" }, { id: "p2", actionState: "idle" }]);
  assert.equal(one.actionStateAt, 3_000);
  assert.equal(two.actionStateAt, null, "p2 never changed, so it was never stamped");
  assert.equal(tracker.annotate(undefined), undefined);
});
