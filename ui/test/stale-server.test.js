// "Back to start" on a page newer than the game server used to fail with a bare
// "Game server command failed (500)". It must say why and what to do.
import assert from "node:assert/strict";
import test from "node:test";
import { createHttpTransport } from "../src/transport.js";

const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });

test("an old server rejecting a newer command says so and how to fix it", async () => {
  const transport = createHttpTransport({
    fetchImpl: async () => respond(400, { error: "unsupported command: RESET_TO_OPENING" }),
    eventSourceFactory: undefined,
  });
  await assert.rejects(
    () => transport.command({ type: "RESET_TO_OPENING" }),
    (error) => /Game server command failed \(400\): unsupported command: RESET_TO_OPENING/.test(error.message)
      && /older than this page; restart it/.test(error.message)
      && /cd server && node server\.mjs/.test(error.message),
  );
});

test("other failures still show the server's own reason without the stale-server hint", async () => {
  const transport = createHttpTransport({
    fetchImpl: async () => respond(409, { error: "approve the floorplan before preparing the game" }),
    eventSourceFactory: undefined,
  });
  await assert.rejects(
    () => transport.command({ type: "START_GAME" }),
    (error) => /\(409\): approve the floorplan before preparing the game$/.test(error.message),
  );
});

test("a bare server error stays short", async () => {
  const transport = createHttpTransport({ fetchImpl: async () => respond(500, { error: "server error" }), eventSourceFactory: undefined });
  await assert.rejects(() => transport.command({ type: "RESET_GAME" }), (error) => error.message === "Game server command failed (500)");
});
