#!/usr/bin/env node

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

async function main() {
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
  await step("P1 picks up raw meat", () => serial(player(1, "PICKUP", "RAW_MEAT")));
  await step("P1 starts chopping", () => serial(player(1, "CHOP", "START")));
  await step("P1 finishes the three-second chop", () => serial(player(1, "CHOP", "DONE", "CHOPPED_MEAT")), 3_000);
  await step("P1 puts chopped meat on stove 1", () => serial(player(1, "STOVE", "LEFT", "PLACE")));
  await step("P2 picks up a bun", () => serial(player(2, "PICKUP", "BUN")));
  await step("P2 puts the bun on a new plate", () => serial(player(2, "PLATE", "NEW")));
  await step("P1 stove is cooking", () => serial(player(1, "STOVE", "LEFT", "STATUS", "COOKING")), 5_000);
  await step("P1 stove reaches done", () => serial(player(1, "STOVE", "LEFT", "STATUS", "DONE")), 11_000);
  await step("P1 stove enters warning", () => serial(player(1, "STOVE", "LEFT", "STATUS", "WARNING")), 2_000);
  await step("P1 takes the cooked meat", () => serial(player(1, "STOVE", "LEFT", "TAKE")));
  await step("P1 transfers meat to P2's plate", () => serial(player(1, "TRANSFER", "2")));
  await step("P1 is ready to submit", () => serial(player(1, "READY")));
  await step("P3 is ready to submit", () => serial(player(3, "READY")));
  await step("P2 submits the correct burger", () => serial("HTN26|1|SUBMIT|2|BM--"));

  // Make a wrong submission so the UI can show the failure/penalty state too.
  await step("P2 makes a bun-only plate", () => serial(player(2, "PLATE", "B---")));
  await step("P1 is ready for the failed submission", () => serial(player(1, "READY")));
  await step("P3 is ready for the failed submission", () => serial(player(3, "READY")));
  await step("P2 submits the wrong burger", () => serial("HTN26|1|SUBMIT|2|B---"));
  await step("Host badge ends the round", () => serial("HTN26|GAME|GAME_END|3"));

  console.log("Done. The frontend should now be showing the ended/results state.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
