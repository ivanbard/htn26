#!/usr/bin/env node
import { acquireSimLock, describeHolder } from "./sim-lock.mjs";

const base = process.env.HTN26_API_URL || "http://127.0.0.1:8787";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const player = (id, action, ...fields) => `HTN26|1|PLAYER|${id}|${action}${fields.length ? `|${fields.join("|")}` : ""}`;

async function request(route, options = {}) {
  const response = await fetch(`${base}${route}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${options.method || "GET"} ${route} failed (${response.status}): ${body.error || "unknown error"}`);
  return body;
}

const command = (type) => request("/api/command", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type }),
});

const serial = (line) => request("/api/serial", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ line }),
});

async function step(label, action, wait = 1_000) {
  console.log(label);
  await sleep(wait);
  await action();
}

// Ask the server what the last submission did, so a timing slip shows up here
// instead of silently leaving the frontend with nothing to display.
async function report(label, expected) {
  await sleep(300);
  const { serving, score } = await request("/api/state");
  const event = serving?.lastEvent;
  console.log(`  server says: ${event ? `${event.message} (gold ${event.gold}, tip ${event.tip}, penalty ${event.penalty})` : "no submission result"}; score ${score?.value}`);
  if (!expected(event)) {
    console.error(`  expected the ${label} result but the server disagreed`);
    process.exitCode = 1;
  }
}

// Only one simulation at a time: a second one would restart the host mid-setup and
// break the first (see sim-lock.mjs).
function takeLock() {
  const lock = acquireSimLock({ owner: "simulate-game" });
  if (!lock.ok) {
    console.error(`Another simulation is already running (${describeHolder(lock.holder)}). Two at once fight over the same server. Wait for it to finish, or stop it, then try again.`);
    process.exit(1);
  }
  process.on("exit", () => lock.release());
  process.on("SIGINT", () => process.exit(130));
}

async function main() {
  takeLock();
  console.log(`Running the burger round against ${base}`);

  // Put the server in the same setup state the UI reaches after the photo flow.
  await step("Host starts setup", () => command("START_HOST"));
  await step("Use the deterministic burger room", () => request("/api/floorplan/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowEmpty: true }),
  }));
  await step("Approve the room layout", () => request("/api/floorplan/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved: true }),
  }));
  await step("Prepare for the physical host badge", () => command("START_GAME"));
  await step("Host badge starts the round", () => serial("HTN26|GAME|START_GAME|240|3"));

  // Make the first plain-meat burger: bun + cooked meat.
  //
  // Timing matters because the server keeps its own clock:
  //   - the chop takes 3 s;
  //   - meat is cooking for 15 s, then "done" for 2 s, then "warning" for 3 s,
  //     and is burnt after that (20 s in all), so it must be taken during the
  //     done/warning window, well before it burns;
  //   - a submission needs every active player "ready" within 0.5 s of each
  //     other, so the ready steps and the submit below wait 0 ms between them.
  await step("P1 picks up raw meat", () => serial(player(1, "PICKUP", "RAW_MEAT")));
  await step("P1 starts chopping", () => serial(player(1, "CHOP", "START")));
  await step("P1 finishes the three-second chop", () => serial(player(1, "CHOP", "DONE", "CHOPPED_MEAT")), 3_000);
  await step("P1 puts chopped meat on stove 1", () => serial(player(1, "STOVE", "LEFT", "PLACE")));

  // Meat is cooking (t=0 here). Use the time: P2 builds the plate, P3 preps lettuce.
  await step("P2 picks up a bun", () => serial(player(2, "PICKUP", "BUN")));
  await step("P2 puts the bun on a new plate", () => serial(player(2, "PLATE", "NEW")));
  await step("P1 stove is cooking", () => serial(player(1, "STOVE", "LEFT", "STATUS", "COOKING")));
  await step("P3 picks up lettuce", () => serial(player(3, "PICKUP", "RAW_LETTUCE")));
  await step("P3 starts chopping the lettuce", () => serial(player(3, "CHOP", "START")));
  await step("P3 finishes chopping", () => serial(player(3, "CHOP", "DONE", "LETTUCE")), 3_000);
  // ~8 s in; wait for the 15 s cook to finish.
  await step("P1 stove reaches done", () => serial(player(1, "STOVE", "LEFT", "STATUS", "DONE")), 8_000);
  await step("P1 stove enters warning", () => serial(player(1, "STOVE", "LEFT", "STATUS", "WARNING")), 2_000);
  // ~25 s after placing would burn it; take it now, inside the warning window.
  await step("P1 takes the cooked meat", () => serial(player(1, "STOVE", "LEFT", "TAKE")), 1_000);
  await step("P1 transfers meat to P2's plate", () => serial(player(1, "TRANSFER", "2")));

  await step("P1 is ready to submit", () => serial(player(1, "READY")));
  await step("P3 is ready to submit", () => serial(player(3, "READY")), 0);
  await step("P2 submits the correct burger", () => serial("HTN26|1|SUBMIT|2|BM--"), 0);
  await report("correct burger", (event) => event?.status === "success");

  // Make a wrong submission so the UI can show the failure/penalty state too.
  // (Pause first so the "served" announcement is visible before the next one.)
  await step("P2 makes a bun-only plate", () => serial(player(2, "PLATE", "B---")), 3_500);
  await step("P1 is ready for the failed submission", () => serial(player(1, "READY")));
  await step("P3 is ready for the failed submission", () => serial(player(3, "READY")), 0);
  await step("P2 submits the wrong burger", () => serial("HTN26|1|SUBMIT|2|B---"), 0);
  await report("wrong burger", (event) => event?.status === "failure");
  await step("Host badge ends the round", () => serial("HTN26|GAME|GAME_END|3"), 3_000);

  console.log("Done. The frontend should now be showing the ended/results state.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
