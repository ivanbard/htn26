// A failed personalized layout (no OpenAI key, timeout...) must always leave the
// way forward on screen.
import assert from "node:assert/strict";
import test from "node:test";
import { layoutFailureMessage } from "../src/main.js";

const HINT = "You can still continue with the Normal Room Layout.";

test("a generic failure gets the way forward appended", () => {
  const text = layoutFailureMessage(new Error("Room layout generation failed (503): Room layout generation is unavailable. Try again."), HINT);
  assert.match(text, /^ROOM LAYOUT FAILED — Room layout generation failed \(503\)/);
  assert.ok(text.endsWith(HINT));
});

test("the server's own not-configured message already names the normal layout, so it is not repeated", () => {
  const text = layoutFailureMessage(new Error("Room layout generation failed (503): Personalized room layout needs an OpenAI API key on the game server (OPENAI_API_KEY in server/.env, then restart it). The normal room layout works without one."), HINT);
  assert.match(text, /needs an OpenAI API key/);
  assert.equal((text.match(/normal room layout/gi) || []).length, 1);
});

test("the normal-layout choice itself gets no hint, and a missing message still reads sensibly", () => {
  assert.equal(layoutFailureMessage(new Error("Default room layout failed (500)")), "ROOM LAYOUT FAILED — Default room layout failed (500)");
  assert.equal(layoutFailureMessage(undefined, HINT), `ROOM LAYOUT FAILED — unknown error ${HINT}`);
});
