// Losing the server AFTER a good connection must be noticed, recovered from, and
// never leave the screen silently stale. Also: the server's reason is passed on,
// and "Rescan" means something the real server understands.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { HEARTBEAT_MS, STREAM_REOPEN_MS, createHttpTransport } from "../src/transport.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (revision, phase = "idle") => ({ revision, setup: { phase, message: "" }, players: [] });
const normalize = (raw) => raw; // the adapter is tested elsewhere

function rig({ serverUp = true } = {}) {
  const rig = { serverUp, revision: 1, phase: "idle", fetches: [], sources: [], received: [], events: [] };
  rig.fetchImpl = async (url, options) => {
    rig.fetches.push({ url, method: options?.method || "GET", body: options?.body });
    if (!rig.serverUp) throw new TypeError("fetch failed");
    if (rig.reply) return rig.reply(url, options);
    return { ok: true, status: 200, json: async () => snapshot(rig.revision, rig.phase) };
  };
  rig.eventSourceFactory = class {
    constructor(url) { this.url = url; this.handlers = {}; this.readyState = 1; this.closed = false; rig.sources.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    close() { this.closed = true; }
    emit(name, payload) { this.handlers[name]?.(payload); }
  };
  rig.transport = createHttpTransport({ baseUrl: "http://x", fetchImpl: rig.fetchImpl, eventSourceFactory: rig.eventSourceFactory, normalizeSnapshot: normalize });
  rig.hooks = { onConnectionLost: () => rig.events.push("lost"), onConnectionRestored: () => rig.events.push("restored") };
  rig.connect = async () => { rig.stop = await rig.transport.connect((s) => rig.received.push(s), rig.hooks); return rig; };
  return rig;
}
const tick = async (ms) => { mock.timers.tick(ms); await flush(); await flush(); };

test("the server dying after we connected is announced within one heartbeat, and its return is announced too", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const r = await rig().connect();
    assert.deepEqual(r.events, []);
    r.serverUp = false;
    await tick(HEARTBEAT_MS);
    assert.deepEqual(r.events, ["lost"]);
    await tick(HEARTBEAT_MS);
    assert.deepEqual(r.events, ["lost"], "announced once, not on every beat");
    r.serverUp = true;
    r.revision = 1; // a restarted server starts counting revisions again from the beginning
    r.phase = "scanning";
    await tick(HEARTBEAT_MS);
    assert.deepEqual(r.events, ["lost", "restored"]);
    assert.equal(r.received.at(-1).setup.phase, "scanning", "the fresh state is shown even though its revision is not higher");
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a broken event stream with a healthy server is not reported as a lost connection", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const r = await rig().connect();
    r.sources[0].readyState = 2;
    r.sources[0].emit("error", {});
    await flush(); await flush();
    assert.deepEqual(r.events, [], "the server answered, so nothing is lost");
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a stream that the browser gave up on is reopened, and the state it pushes is applied", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const r = await rig().connect();
    r.sources[0].readyState = 2; // CLOSED: the browser will not retry by itself
    r.sources[0].emit("error", {});
    await flush();
    assert.equal(r.sources.length, 1);
    await tick(STREAM_REOPEN_MS);
    assert.equal(r.sources.length, 2, "a new stream was opened");
    assert.equal(r.sources[0].closed, true, "and the dead one was closed");
    r.sources[1].emit("state", { data: JSON.stringify(snapshot(9, "running")) });
    assert.equal(r.received.at(-1).setup.phase, "running");
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a quiet stream that missed a change is caught up by the heartbeat", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const r = await rig().connect();
    r.revision = 7; r.phase = "burger-placement"; // changed while the stream said nothing
    await tick(HEARTBEAT_MS);
    assert.equal(r.received.at(-1).setup.phase, "burger-placement");
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a late heartbeat reply never overwrites a newer stream event", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const r = await rig().connect();
    r.sources[0].emit("state", { data: JSON.stringify(snapshot(10, "running")) });
    r.revision = 4; r.phase = "scanning"; // an old reply arriving late
    await tick(HEARTBEAT_MS);
    assert.equal(r.received.at(-1).setup.phase, "running");
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

test("disconnecting stops the timers (no reconnect or heartbeat after cleanup)", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const r = await rig().connect();
    r.sources[0].readyState = 2;
    r.sources[0].emit("error", {});
    r.stop();
    const before = r.fetches.length;
    await tick(HEARTBEAT_MS * 3);
    assert.equal(r.fetches.length, before, "no more requests");
    assert.equal(r.sources.length, 1, "no reopened stream");
  } finally {
    mock.timers.reset();
  }
});

test("the server's own reason is passed on when it gives one, and a bare 500 is not embellished", async () => {
  const r = rig();
  await r.connect(); r.stop?.();
  r.reply = async () => ({ ok: false, status: 400, json: async () => ({ error: "approve the floorplan before preparing the game" }) });
  await assert.rejects(() => r.transport.command("START_GAME"), /Game server command failed \(400\): approve the floorplan before preparing the game/);
  r.reply = async () => ({ ok: false, status: 500, json: async () => ({ error: "server error" }) });
  await assert.rejects(() => r.transport.command("START_GAME"), (error) => error.message === "Game server command failed (500)");
  r.reply = async () => ({ ok: false, status: 502, json: async () => { throw new Error("not json"); } });
  await assert.rejects(() => r.transport.command("START_GAME"), (error) => error.message === "Game server command failed (502)");
});

test("'Rescan' is sent as START_HOST, the only way the real server goes back to scanning", async () => {
  const r = rig();
  await r.connect(); r.stop?.();
  r.reply = async (url, options) => ({ ok: true, status: 200, json: async () => ({ echoed: JSON.parse(options.body) }) });
  await r.transport.command("RESCAN");
  await r.transport.command({ type: "RESCAN", extra: 1 });
  const posts = r.fetches.filter((f) => f.method === "POST").map((f) => JSON.parse(f.body));
  assert.deepEqual(posts, [ "START_HOST", { type: "START_HOST", extra: 1 } ]);
  await r.transport.command("APPROVE_LAYOUT");
  assert.equal(JSON.parse(r.fetches.at(-1).body), "APPROVE_LAYOUT", "other commands are untouched");
});
