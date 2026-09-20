#!/usr/bin/env node
import { acquireSimLock, describeHolder } from "./sim-lock.mjs";

const base = process.env.HTN26_API_URL || "http://127.0.0.1:8787";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(route, options = {}) {
  const response = await fetch(`${base}${route}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${options.method || "GET"} ${route} failed (${response.status}): ${body.error || "unknown error"}`);
  return body;
}

// Only one simulation at a time: a second one would restart the host mid-setup and
// break the first (see sim-lock.mjs).
function takeLock() {
  const lock = acquireSimLock({ owner: "simulate-photos" });
  if (!lock.ok) {
    console.error(`Another simulation is already running (${describeHolder(lock.holder)}). Two at once fight over the same server. Wait for it to finish, or stop it, then try again.`);
    process.exit(1);
  }
  process.on("exit", () => lock.release());
  process.on("SIGINT", () => process.exit(130));
}

async function main() {
  takeLock();
  console.log(`Uploading fixture photos to ${base}`);
  await request("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "START_HOST" }),
  });

  // The server keeps photos between games and caps them at five, so uploading
  // four more on a repeat run would fail with a 409. Reuse what is already there.
  const existing = await request("/api/photos");
  if (existing.count >= 3) {
    console.log(`Using the ${existing.count} photos already on the server.`);
  } else {
    const photos = new FormData();
    for (let index = 1; index <= 4; index += 1) {
      photos.append("photos", new Blob([`fixture photo ${index}`], { type: "image/jpeg" }), `room-${index}.jpg`);
    }
    const uploaded = await request("/api/photos", { method: "POST", body: photos });
    console.log(`Uploaded ${uploaded.count} photos.`);
  }
  await sleep(500);

  const proposed = await request("/api/floorplan/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  console.log(`Room proposal ready: ${proposed.setup.phase}`);
  await sleep(500);

  const approved = await request("/api/floorplan/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved: true }),
  });
  console.log(`Layout approved. Frontend should now show: ${approved.setup.phase}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
