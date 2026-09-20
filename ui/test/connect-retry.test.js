// A dead or not-yet-started server must not strand the page: say what is wrong,
// keep retrying, and recover on its own once the server answers.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createApp, describeConnectionFailure } from "../src/main.js";
import { createInitialMockState } from "../src/mock-transport.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const fakeRoot = () => ({ innerHTML: "", addEventListener() {}, removeEventListener() {} });

test("a 5xx from the proxy or a failed fetch says the server is not reachable and how to start it", () => {
  for (const error of [Object.assign(new Error("Game server state request failed (500)"), { status: 500 }), Object.assign(new Error("x"), { status: 502 }), new TypeError("fetch failed")]) {
    const text = describeConnectionFailure(error);
    assert.match(text, /^GAME SERVER UNAVAILABLE — can't reach it/);
    assert.match(text, /node server\/server\.mjs --serial DEVICE/);
    assert.match(text, /retrying every 3 s/);
  }
  const other = describeConnectionFailure(Object.assign(new Error("Game server state request failed (404)"), { status: 404 }));
  assert.match(other, /404/);
  assert.doesNotMatch(other, /cd server/);
});

test("the page keeps retrying and recovers by itself when the server comes up, with no reload", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let attempts = 0;
    const transport = {
      kind: "http",
      async connect(listener) {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("Game server state request failed (500)"), { status: 500 });
        listener(createInitialMockState(1_000));
        return () => {};
      },
      async command() {},
      close() {},
    };
    const root = fakeRoot();
    const app = createApp({ root, transport });
    await flush();
    assert.equal(attempts, 1);
    assert.match(root.innerHTML, /GAME SERVER UNAVAILABLE/);
    assert.match(root.innerHTML, /Waiting for authoritative state/);

    mock.timers.tick(3_000); await flush();
    assert.equal(attempts, 2, "retried after 3 s");
    assert.match(root.innerHTML, /GAME SERVER UNAVAILABLE/);

    mock.timers.tick(3_000); await flush();
    assert.equal(attempts, 3, "connected on the third try");
    assert.doesNotMatch(root.innerHTML, /GAME SERVER UNAVAILABLE|Waiting for authoritative state/);
    assert.match(root.innerHTML, /UnderCooked/, "the real screen is showing");

    mock.timers.tick(30_000); await flush();
    assert.equal(attempts, 3, "no more retries once connected");
    app.destroy();
  } finally {
    mock.timers.reset();
  }
});

test("tearing the page down stops the retries", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let attempts = 0;
    const transport = { kind: "http", async connect() { attempts += 1; throw new TypeError("fetch failed"); }, async command() {}, close() {} };
    const app = createApp({ root: fakeRoot(), transport });
    await flush();
    assert.equal(attempts, 1);
    app.destroy();
    mock.timers.tick(60_000); await flush();
    assert.equal(attempts, 1);
  } finally {
    mock.timers.reset();
  }
});
