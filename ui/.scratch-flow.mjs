import { chromium } from "playwright";
import { validateFrontendSnapshot, normalizeFrontendSnapshot } from "/Users/aaryanj/htn26/ui/src/contracts.js";
import { normalizeServerSnapshot } from "/Users/aaryanj/htn26/ui/src/server-snapshot.js";
import { createInitialProjectionState } from "/Users/aaryanj/htn26/server/src/projection.mjs";
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:4173/"); await p.waitForTimeout(800);
const bad = async (tag) => { const t = await p.locator("body").innerText(); console.log(tag.padEnd(22), /Authoritative state unavailable|frontend contract|Missing required/i.test(t) ? "ERROR SHOWN" : "ok"); };
await bad("load");
for (const name of ["Get Started", "Wake the kitchen", "Load the room", "Confirm the layout", "Start cooking", /got it/i]) {
  const btn = p.getByRole("button", { name }).first();
  if (await btn.count()) { await btn.click(); await p.waitForTimeout(600); await bad(String(name)); }
}
await p.waitForTimeout(6000); await bad("6s into round");
console.log("page errors:", JSON.stringify(errs));
await b.close();
// real-server path: what the http transport does (normalizeServerSnapshot then normalizeFrontendSnapshot)
const raw = createInitialProjectionState(); delete raw.score;
console.log("server snapshot without score ->", JSON.stringify(validateFrontendSnapshot(normalizeFrontendSnapshot(normalizeServerSnapshot(raw))).valid));
