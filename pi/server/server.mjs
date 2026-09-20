#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFloorplanProvider } from "./src/provider.mjs";
import { ServerProjection } from "./src/projection.mjs";
import { createSerialStreamAdapter } from "./src/protocol.mjs";
import { openSerialDevice } from "./src/serial-device.mjs";
import { PhotoStore, createHttpServer } from "./src/http.mjs";
import { DifficultySidecarClient } from "./src/difficulty-sidecar.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--host") options.host = argv[++index];
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--serial") options.serial = argv[++index];
    else if (arg.startsWith("--host=")) options.host = arg.slice(7);
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice(7));
    else if (arg.startsWith("--serial=")) options.serial = arg.slice(9);
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

export async function createRuntime({ env = process.env, now = () => Date.now(), fetchImpl = globalThis.fetch, dataDir, authoritativeEngine, difficultySidecar } = {}) {
  const directory = dataDir || env.HTN26_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
  const photoStore = new PhotoStore({ directory });
  await photoStore.init();
  const provider = createFloorplanProvider({ env, fetchImpl, now });
  const configuredDifficultySidecar = difficultySidecar === undefined && env.HTN26_DIFFICULTY_SIDECAR_URL
    ? new DifficultySidecarClient({
      baseUrl: env.HTN26_DIFFICULTY_SIDECAR_URL,
      timeoutMs: Number(env.HTN26_DIFFICULTY_SIDECAR_TIMEOUT_MS) || 200,
      fetchImpl,
    })
    : difficultySidecar || null;
  const projection = new ServerProjection({
    provider,
    now,
    roundSeconds: Number(env.HTN26_ROUND_SECONDS) || 240,
    orderIntervalMinSeconds: Number(env.HTN26_ORDER_INTERVAL_MIN_SECONDS) || 8,
    orderIntervalMaxSeconds: Number(env.HTN26_ORDER_INTERVAL_MAX_SECONDS) || 35,
    orderPatienceSeconds: Number(env.HTN26_ORDER_PATIENCE_SECONDS) || undefined,
    maxActiveOrders: Number(env.HTN26_MAX_ACTIVE_ORDERS) || 3,
    locationHoldSeconds: env.HTN26_PLAYER_LOCATION_HOLD_SECONDS == null
      ? undefined : Number(env.HTN26_PLAYER_LOCATION_HOLD_SECONDS),
    authoritativeEngine,
    difficultySidecar: configuredDifficultySidecar,
  });
  const serialAdapter = createSerialStreamAdapter({
    onRecord: (record) => {
      const timestamp = now();
      if (record.kind === "badge-event") projection.ingestBadgeEvent(record.intent, timestamp);
      else if (record.kind === "gateway-status") projection.ingestGatewayStatus(record.status, timestamp);
      else if (record.kind === "host-control") projection.ingestHostControl(record, timestamp);
      else if (record.kind === "player-action") projection.ingestPlayerAction(record, timestamp);
      else if (record.kind === "submission") projection.ingestSubmission(record, timestamp);
    },
  });
  projection.serialAdapter = serialAdapter;
  const serialDevice = env.HTN26_SERIAL_DEVICE
    ? openSerialDevice(env.HTN26_SERIAL_DEVICE, {
      parser: serialAdapter,
      onError: (error) => console.error(`serial device ${env.HTN26_SERIAL_DEVICE}: ${error.message}`),
    })
    : null;
  const server = createHttpServer({ projection, photoStore });
  const interval = setInterval(() => projection.snapshot(now()), 250);
  interval.unref?.();
  return {
    directory,
    provider,
    difficultySidecar: configuredDifficultySidecar,
    projection,
    photoStore,
    serialAdapter,
    serialDevice,
    server,
    close() {
      clearInterval(interval);
      serialDevice?.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function usage() {
  return `HTN26 laptop server simulator\n\n` +
    `  node pi/server/server.mjs [--host HOST] [--port PORT] [--serial DEVICE]\n\n` +
    `Environment: HTN26_BIND_HOST, HTN26_PORT, HTN26_SERIAL_DEVICE, HTN26_DATA_DIR,\n` +
    `OPENAI_API_KEY (optional; server-side only), HTN26_ORDER_INTERVAL_MIN_SECONDS,\n` +
    `HTN26_ORDER_INTERVAL_MAX_SECONDS, HTN26_ORDER_PATIENCE_SECONDS,\n` +
    `HTN26_MAX_ACTIVE_ORDERS, HTN26_PLAYER_LOCATION_HOLD_SECONDS,\n` +
    `HTN26_DIFFICULTY_SIDECAR_URL, HTN26_DIFFICULTY_SIDECAR_TIMEOUT_MS.\n`;
}

export function startupGuide(baseUrl) {
  return `\nHTN26 development simulator guide\n` +
    `Open ${baseUrl}/ for the plain live state view.\n\n` +
    `Production rounds start only when the physical host emits HTN26|GAME|START_GAME|240|3.\n` +
    `The canonical HOST records below are explicit local development simulation.\n\n` +
    `Paste these development examples in that page's browser console:\n` +
    `const serial = line => fetch('/api/serial', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({line})}).then(r => r.json());\n` +
    `await serial('HTN26|1|HOST|RESET');\n` +
    `await serial('HTN26|1|HOST|START|240|3');\n` +
    `await serial('HTN26|1|GATEWAY|UP|1|0');\n` +
    `await serial('HTN26|1|PLAYER|1|PLATE|BM--');\n` +
    `await Promise.all([serial('HTN26|1|PLAYER|2|READY'), serial('HTN26|1|PLAYER|3|READY'), serial('HTN26|1|SUBMIT|1|BM--')]);\n\n` +
    `Query the same authoritative state shown on the page:\n` +
    `await fetch('/api/timer').then(r => r.json());\n` +
    `await fetch('/api/orders').then(r => r.json());\n` +
    `await fetch('/api/players').then(r => r.json());\n` +
    `await fetch('/api/submissions').then(r => r.json());\n` +
    `await fetch('/api/money').then(r => r.json());\n`;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) { console.log(usage()); return null; }
  const runtime = await createRuntime({ env: { ...env, HTN26_SERIAL_DEVICE: options.serial || env.HTN26_SERIAL_DEVICE } });
  const host = options.host || env.HTN26_BIND_HOST || "127.0.0.1";
  const port = options.port || Number(env.HTN26_PORT) || 8787;
  await new Promise((resolve) => runtime.server.listen(port, host, resolve));
  const address = runtime.server.address();
  console.log(`HTN26 laptop server listening on http://${host}:${address.port}`);
  if (runtime.serialDevice) console.log(`HTN26 serial input: ${runtime.serialDevice.path}`);
  else console.log("HTN26 serial input disabled; set HTN26_SERIAL_DEVICE or pass --serial DEVICE");
  console.log(`Floorplan provider: ${env.OPENAI_API_KEY ? "optional OpenAI with local fallback" : "local deterministic fallback (set OPENAI_API_KEY on the server to opt in)"}`);
  console.log(startupGuide(`http://${host}:${address.port}`));
  const shutdown = async () => { await runtime.close(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
