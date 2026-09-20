#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFloorplanProvider } from "./src/provider.mjs";
import { ServerProjection } from "./src/projection.mjs";
import { createSerialStreamAdapter } from "./src/protocol.mjs";
import { openSerialDevice } from "./src/serial-device.mjs";
import { PhotoStore, createHttpServer } from "./src/http.mjs";
import { createRoomLayoutGenerator } from "./src/layout-generator.mjs";
import { LayoutSubmissionStore } from "./src/layout-submission-store.mjs";

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

export async function createRuntime({ env = process.env, now = () => Date.now(), fetchImpl = globalThis.fetch, dataDir, authoritativeEngine } = {}) {
  const directory = dataDir || env.HTN26_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
  const photoStore = new PhotoStore({ directory });
  await photoStore.init();
  const layoutSubmissionStore = new LayoutSubmissionStore({ directory, now });
  await layoutSubmissionStore.init();
  const provider = createFloorplanProvider({ env, fetchImpl, now });
  const roomLayoutGenerator = createRoomLayoutGenerator({ env, fetchImpl, now });
  const projection = new ServerProjection({
    provider,
    now,
    roundSeconds: Number(env.HTN26_ROUND_SECONDS) || 240,
    orderIntervalMinSeconds: Number(env.HTN26_ORDER_INTERVAL_MIN_SECONDS) || 8,
    orderIntervalMaxSeconds: Number(env.HTN26_ORDER_INTERVAL_MAX_SECONDS) || 35,
    orderPatienceSeconds: Number(env.HTN26_ORDER_PATIENCE_SECONDS) || undefined,
    maxActiveOrders: Number(env.HTN26_MAX_ACTIVE_ORDERS) || 3,
    locationHoldSeconds: env.HTN26_PLAYER_LOCATION_HOLD_SECONDS == null ? undefined : Number(env.HTN26_PLAYER_LOCATION_HOLD_SECONDS),
    authoritativeEngine,
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
  const server = createHttpServer({ projection, photoStore, layoutSubmissionStore, roomLayoutGenerator });
  const interval = setInterval(() => projection.snapshot(now()), 250);
  interval.unref?.();
  return {
    directory,
    provider,
    projection,
    photoStore,
    layoutSubmissionStore,
    roomLayoutGenerator,
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
  return `HTN26 server (portable/QNX-oriented)\n\n` +
    `  node server/server.mjs [--host HOST] [--port PORT] [--serial DEVICE]\n\n` +
    `Environment: HTN26_BIND_HOST, HTN26_PORT, HTN26_SERIAL_DEVICE, HTN26_DATA_DIR,\n` +
    `OPENAI_API_KEY (optional; server-side only), OPENAI_LAYOUT_TIMEOUT_MS,\n` +
    `HTN26_ORDER_INTERVAL_MIN_SECONDS,\n` +
    `HTN26_ORDER_INTERVAL_MAX_SECONDS, HTN26_MAX_ACTIVE_ORDERS.\n`;
}

export function startupGuide(baseUrl) {
  return `HTN26 development simulator guide at ${baseUrl}/\\n` +
    `GET /api/timer\\nGET /api/orders\\nGET /api/players\\nGET /api/submissions\\nGET /api/money\\n` +
    `HTN26|1|PLAYER|2|READY\\nHTN26|1|PLAYER|3|READY\\nHTN26|1|SUBMIT|1|BM--\\n` +
    `HTN26|GAME|START_GAME|240|3\\nDevelopment simulator`;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) { console.log(usage()); return null; }
  const runtime = await createRuntime({ env: { ...env, HTN26_SERIAL_DEVICE: options.serial || env.HTN26_SERIAL_DEVICE } });
  const host = options.host || env.HTN26_BIND_HOST || "127.0.0.1";
  const port = options.port || Number(env.HTN26_PORT) || 8787;
  await new Promise((resolve) => runtime.server.listen(port, host, resolve));
  const address = runtime.server.address();
  console.log(`HTN26 server listening on http://${host}:${address.port}`);
  if (runtime.serialDevice) console.log(`HTN26 serial input: ${runtime.serialDevice.path}`);
  else console.log("HTN26 serial input disabled; set HTN26_SERIAL_DEVICE or pass --serial DEVICE");
  console.log(`Floorplan provider: ${env.OPENAI_API_KEY ? "optional OpenAI with local fallback" : "local deterministic fallback (set OPENAI_API_KEY on the server to opt in)"}`);
  const shutdown = async () => { await runtime.close(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
