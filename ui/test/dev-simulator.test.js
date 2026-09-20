// The temporary dev helper that runs Ethan's simulate-*.mjs scripts at each game start.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSimulator, simulationEnabled } from "../dev-simulator.mjs";

function harness({ exitCodes = [], lock } = {}) {
  const phases = [];
  let phaseIndex = 0;
  let serverDown = false;
  const spawned = [];
  const logs = [];
  const finishers = [];
  const simulator = createSimulator({
    target: "http://server.test",
    scripts: ["/x/simulate-photos.mjs", "/x/simulate-game.mjs"],
    log: (line) => logs.push(line),
    ...(lock ? { lockApi: lock } : { lockApi: { acquire: () => ({ ok: true, release() {} }), describe: () => "test" } }),
    fetchImpl: async () => {
      if (serverDown) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => ({ setup: { phase: phases[Math.min(phaseIndex, phases.length - 1)] } }) };
    },
    spawnImpl: (command, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; };
      spawned.push({ script: args[0], env: options.env, child });
      // Scripts finish only when the test says so, like a real ~45 s run.
      finishers.push(() => child.emit("close", exitCodes[spawned.length - 1] ?? 0));
      return child;
    },
  });
  return {
    simulator, spawned, logs,
    setPhases(...next) { phases.length = 0; phases.push(...next); phaseIndex = 0; },
    async pollPhase(phase) { phases.length = 0; phases.push(phase); return simulator.tick(); },
    finishNext() { finishers.shift()?.(); return new Promise((resolve) => setImmediate(resolve)); },
    setDown(value) { serverDown = value; },
  };
}

test("starting a game (idle -> scanning) runs photos then game, once, aimed at the server", async () => {
  const h = harness();
  assert.equal(await h.pollPhase("idle"), false);
  assert.equal(await h.pollPhase("scanning"), true);
  assert.equal(h.spawned.length, 1);
  assert.match(h.spawned[0].script, /simulate-photos\.mjs$/);
  assert.equal(h.spawned[0].env.HTN26_API_URL, "http://server.test");
  assert.equal(h.simulator.running, true);

  await h.finishNext();
  assert.equal(h.spawned.length, 2, "the game script follows once the photo script exits");
  assert.match(h.spawned[1].script, /simulate-game\.mjs$/);
  await h.finishNext();
  assert.equal(h.simulator.running, false);
  assert.ok(h.logs.some((line) => /finished/.test(line)));
});

test("the scripts' own START_HOST calls never re-trigger a run while one is going", async () => {
  const h = harness();
  await h.pollPhase("idle");
  await h.pollPhase("scanning");
  // The game script sends START_HOST again mid-run, walking the phase back to scanning.
  for (const phase of ["layout-proposed", "burger-placement", "scanning", "burger-placement", "running", "scanning"]) {
    assert.equal(await h.pollPhase(phase), false, phase);
  }
  assert.equal(h.spawned.length, 1);
});

test("a finished run re-arms only after the game has been back at rest", async () => {
  const h = harness();
  await h.pollPhase("idle");
  await h.pollPhase("scanning");
  await h.finishNext();
  await h.finishNext();
  await h.pollPhase("ended");
  assert.equal(await h.pollPhase("scanning"), true, "Get Started again after the results screen");
  await h.finishNext();
  await h.finishNext();
  await h.pollPhase("idle");
  assert.equal(await h.pollPhase("scanning"), true, "and again after a reset");
});

test("a game already in progress when the dev server starts is not hijacked", async () => {
  const h = harness();
  assert.equal(await h.pollPhase("scanning"), false);
  assert.equal(await h.pollPhase("running"), false);
  assert.equal(h.spawned.length, 0);
});

test("an unreachable server is waited for quietly, and a later game start still works", async () => {
  const h = harness();
  h.setDown(true);
  await h.simulator.tick();
  await h.simulator.tick();
  assert.equal(h.logs.filter((line) => /waiting for the server/.test(line)).length, 1, "logged once, not every poll");
  h.setDown(false);
  await h.pollPhase("idle");
  assert.equal(await h.pollPhase("scanning"), true);
});

test("a failing script (e.g. the photo upload on a repeat game) does not stop the game script", async () => {
  const h = harness({ exitCodes: [1, 0] });
  await h.pollPhase("idle");
  await h.pollPhase("scanning");
  await h.finishNext();
  assert.equal(h.spawned.length, 2, "the game script still runs after the photo script fails");
  assert.match(h.spawned[1].script, /simulate-game\.mjs$/);
  assert.ok(h.logs.some((line) => /simulate-photos\.mjs exited with code 1; continuing/.test(line)));
  await h.finishNext();
  assert.equal(h.simulator.running, false);
  await h.pollPhase("idle");
  assert.equal(await h.pollPhase("scanning"), true, "the next game start runs it again");
});

test("script output is forwarded with a [sim:name] prefix", async () => {
  const h = harness();
  await h.pollPhase("idle");
  await h.pollPhase("scanning");
  h.spawned[0].child.stdout.emit("data", "Uploaded 4 photos.\nRoom proposal ready\n");
  assert.deepEqual(h.logs.filter((line) => line.startsWith("[sim:simulate-photos]")), ["[sim:simulate-photos] Uploaded 4 photos.", "[sim:simulate-photos] Room proposal ready"]);
});

test("the fixture simulator requires an explicit opt-in, so normal dev and live runs cannot spawn it", () => {
  for (const value of [undefined, "", "0", "off", "OFF", "false", "no", "anything-else"]) {
    assert.equal(simulationEnabled({ HTN26_SIMULATE: value }), false, String(value));
  }
  for (const value of ["1", "on", "ON", "true", "yes"]) assert.equal(simulationEnabled({ HTN26_SIMULATE: value }), true, value);
});

test("if another simulation already holds the lock, the hook does not start a second one", async () => {
  const lock = { acquire: () => ({ ok: false, holder: { pid: 4242, owner: "simulate-game", at: Date.now() - 3_000 } }), describe: (holder) => `pid ${holder.pid}, ${holder.owner}` };
  const h = harness({ lock });
  await h.pollPhase("idle");
  await h.pollPhase("scanning");
  assert.equal(h.spawned.length, 0, "no scripts were started");
  assert.equal(h.simulator.running, false);
  assert.ok(h.logs.some((line) => /another simulation is already running \(pid 4242, simulate-game\); not starting a second one/.test(line)));
});

test("the hook holds the lock for the whole photos-then-game run and releases it afterwards", async () => {
  let released = 0;
  const lock = { acquire: () => ({ ok: true, release() { released += 1; } }), describe: () => "" };
  const h = harness({ lock });
  await h.pollPhase("idle");
  await h.pollPhase("scanning");
  await h.finishNext();
  assert.equal(released, 0, "still held between the two scripts");
  await h.finishNext();
  assert.equal(released, 1, "released once, at the end");
});
