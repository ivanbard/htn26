// TEMPORARY dev helper. Ethan's two fixture scripts (server/simulate-photos.mjs
// and server/simulate-game.mjs) play the phone and the badges over the server's
// HTTP API so the frontend can be watched without hardware. It is deliberately
// opt-in: a normal dev or presentation run must never create fake photos,
// badge events, or an early GAME_END.
//
// It lives entirely in ui/: it only reads the server's /api/state and runs the
// existing scripts as child processes. Set HTN26_SIMULATE=1 to enable it.
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const ON_VALUES = new Set(["1", "on", "true", "yes"]);

export function simulationEnabled(env = process.env) {
  return ON_VALUES.has(String(env.HTN26_SIMULATE ?? "").trim().toLowerCase());
}

export const DEFAULT_SCRIPTS = Object.freeze([
  fileURLToPath(new URL("../server/simulate-photos.mjs", import.meta.url)),
  fileURLToPath(new URL("../server/simulate-game.mjs", import.meta.url)),
]);

// A game "starts" when the setup phase moves from idle (or a finished round)
// to scanning: that is the operator pressing Get Started.
const RESTING_PHASES = new Set(["idle", "ended"]);

/**
 * Watches the server and runs `scripts` in order once per game start.
 *
 * The scripts themselves send START_HOST, which would look like another game
 * starting, so a run blocks re-triggering until it finishes, and the next game
 * start is only recognised after the state has been at rest (idle/ended) again.
 * `tick()` does one poll and is exposed so tests can drive it without timers.
 */
export function createSimulator({
  target = "http://127.0.0.1:8787",
  scripts = DEFAULT_SCRIPTS,
  pollMs = 500,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  log = (line) => console.log(line),
} = {}) {
  let lastPhase = null;
  let running = false;
  let waitingLogged = false;
  let timer = null;
  let child = null;
  let stopped = false;

  const prefixLines = (name, stream) => {
    let pending = "";
    stream?.on("data", (chunk) => {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) if (line.trim()) log(`[sim:${name}] ${line}`);
    });
    stream?.on("end", () => { if (pending.trim()) log(`[sim:${name}] ${pending}`); pending = ""; });
  };

  const runScript = (script) => new Promise((resolve) => {
    const name = basename(script, ".mjs");
    child = spawnImpl(process.execPath, [script], {
      env: { ...process.env, HTN26_API_URL: target },
      stdio: ["ignore", "pipe", "pipe"],
    });
    prefixLines(name, child.stdout);
    prefixLines(name, child.stderr);
    child.on("error", (error) => { log(`[sim:${name}] could not start: ${error.message}`); resolve(1); });
    child.on("close", (code) => { child = null; resolve(code ?? 1); });
  });

  async function run() {
    running = true;
    log(`[sim] game started: running ${scripts.map((script) => basename(script)).join(", then ")}`);
    try {
      for (const script of scripts) {
        const code = await runScript(script);
        if (stopped) return;
        // Keep going: the scripts are independent (the game script does its own
        // setup), and the photo one legitimately fails on a repeat game because the
        // server keeps earlier photos and caps them at five.
        if (code !== 0) log(`[sim] ${basename(script)} exited with code ${code}; continuing with the next script`);
      }
      log("[sim] finished; the next game start will run it again");
    } finally {
      running = false;
    }
  }

  async function tick() {
    let phase;
    try {
      const response = await fetchImpl(`${target}/api/state`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(String(response.status));
      phase = (await response.json())?.setup?.phase;
      waitingLogged = false;
    } catch {
      if (!waitingLogged) { log(`[sim] waiting for the server at ${target}`); waitingLogged = true; }
      return false;
    }
    const started = !running && phase === "scanning" && RESTING_PHASES.has(lastPhase);
    lastPhase = phase;
    if (!started) return false;
    run();
    return true;
  }

  return {
    tick,
    get running() { return running; },
    start() {
      log(`[sim] on: runs the simulation scripts each time a game starts (server ${target}); restart normally or use npm run dev:live for a physical run`);
      timer = setInterval(() => { tick(); }, pollMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      child?.kill();
    },
  };
}

/** Vite plugin: starts the simulator with the dev server, pointed at the same server the /api proxy targets. */
export function simulatorPlugin({ target, env = process.env } = {}) {
  return {
    name: "htn26-simulator",
    apply: "serve",
    configureServer(server) {
      if (!simulationEnabled(env)) return;
      const simulator = createSimulator({ target, log: (line) => server.config.logger.info(line) });
      simulator.start();
      server.httpServer?.once("close", () => simulator.stop());
    },
  };
}
