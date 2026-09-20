// Where chefs are drawn while a round is live (positions are inferred from each
// player's latest action; there is no camera tracking in v1).
import assert from "node:assert/strict";
import test from "node:test";
import { ServerProjection } from "../../server/src/projection.mjs";
import { LocalFloorplanProvider } from "../../server/src/provider.mjs";
import { normalizeFrontendSnapshot } from "../src/contracts.js";
import { renderApp } from "../src/render.js";
import { PLAYER_RADIUS, PLAYER_SEPARATION, projectPointIntoWalkableRoom, separatePlayerPositions } from "../src/room-layout.js";
import { normalizeServerSnapshot } from "../src/server-snapshot.js";

// Rendered size of the floor plan and a chef in a real 2000x1090 browser (measured).
const PLAN_PX = { width: 1243, height: 585 };
const CHEF_PX = { width: 88, height: 85 };
const TAG_PX = 22;
const CALLOUT_PX = 31;

async function round() {
  let now = 1_000_000;
  const projection = new ServerProjection({ provider: new LocalFloorplanProvider({ now: () => now }), now: () => now, locationHoldSeconds: 30 });
  await projection.proposeFloorplan({ photos: [{ id: "fixture" }] }, now);
  projection.approveFloorplan(true, now);
  projection.command("START_GAME", {}, now);
  projection.ingestHostControl({ control: "START", durationSeconds: 240, framing: "legacy-game" }, now);
  const act = (action) => projection.ingestPlayerAction(action, now);
  const view = () => {
    const state = normalizeFrontendSnapshot(normalizeServerSnapshot(projection.snapshot(now)));
    return { state, html: renderApp(state, now, "", "http"), plan: state.floorPlan };
  };
  return { projection, act, view, advance(ms) { now += ms; } };
}

const centre = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const player = (state, id) => state.players.find((candidate) => candidate.id === id);
const tile = (plan, id) => plan.stations.find((station) => station.id === id);

// The walls the room actually uses to keep chefs off stations (see RoomSurface).
const barriers = (plan) => [...plan.walls, ...plan.stations.map((station) => ({ ...station, ...station.display, blocksMovement: true }))];
const px = (rect) => ({ l: rect.x * PLAN_PX.width / 100, t: rect.y * PLAN_PX.height / 100, w: rect.width * PLAN_PX.width / 100, h: rect.width * PLAN_PX.width / 100 /* tiles are CSS squares */ });
const gapPx = (chefCentre, station) => {
  const s = px(station.display);
  const c = { l: chefCentre.x * PLAN_PX.width / 100 - CHEF_PX.width / 2, t: chefCentre.y * PLAN_PX.height / 100 - CHEF_PX.height / 2 };
  const gx = Math.max(0, Math.max(s.l - (c.l + CHEF_PX.width), c.l - (s.l + s.w)));
  const gy = Math.max(0, Math.max(s.t - (c.t + CHEF_PX.height), c.t - (s.t + s.h)));
  return Math.hypot(gx, gy);
};

test("the left and right stoves send the chef to two different places, each at its own drawn tile", async () => {
  const game = await round();
  game.act({ playerId: "p1", action: "STOVE", side: "LEFT", operation: "CHECK" });
  game.act({ playerId: "p2", action: "STOVE", side: "RIGHT", operation: "CHECK" });
  const { state, plan } = game.view();
  const left = player(state, "p1").position;
  const right = player(state, "p2").position;
  assert.deepEqual(left, centre(tile(plan, "stove-left").display));
  assert.deepEqual(right, centre(tile(plan, "stove-right").display));
  assert.ok(right.x - left.x > 5, "the right stove is to the right of the left one");
});

test("a chef whose location has nothing to draw (submitting, at 'serving') stays on screen at the room's centre", async () => {
  const game = await round();
  const target = game.projection._activeOrders()[0];
  const summary = ["BUN", "MEAT", "LETTUCE", "CHEESE"].map((item) => target.components.includes(item) ? item[0] : "-").join("");
  game.act({ playerId: "p2", action: "PLATE", plate: summary });
  for (const playerId of ["p1", "p3"]) game.act({ playerId, action: "READY" });
  game.projection.submit(game.projection._player("p2"), target.recipe, 1_000_000);
  const { state, html } = game.view();
  assert.equal(player(state, "p2").simulatedLocation.stationId, "serving", "the server really does report that location");
  assert.deepEqual(player(state, "p2").position, { x: 50, y: 50 });
  const chef = html.match(/<div class="tracked-player[^"]*"[^>]*data-player="p2"[^>]*>/)?.[0] || html.match(/<div[^>]*data-player="p2"[^>]*>/)?.[0];
  assert.match(chef, /style="left:/, "drawn at a position, not as an empty 'location unavailable' placeholder");
});

test("chefs are not drawn faded just because their spot is inferred; they fade only if the gateway is down", async () => {
  const game = await round();
  game.act({ playerId: "p1", action: "PICKUP", item: "BUN" });
  const fresh = game.view().html;
  assert.equal((fresh.match(/tracked-player[^"]*is-stale/g) || []).length, 0);
  assert.doesNotMatch(fresh, /data-stale="true"/);

  game.projection.ingestGatewayStatus({ up: false, packetCount: 0, droppedCount: 0 }, 1_000_000);
  const down = game.view().html;
  assert.equal((down.match(/data-stale="true"/g) || []).length, 3, "all three fade when the gateway is offline");
});

test("a chef using a station stands right beside it (about a chef's width clear), never on it", async () => {
  const game = await round();
  const { plan } = game.view();
  for (const id of ["pantry", "fridge", "cutting-board", "stove-left", "stove-right"]) {
    const station = tile(plan, id);
    const spot = projectPointIntoWalkableRoom(centre(station.display), barriers(plan), { x: 50, y: 50 });
    const gap = gapPx(spot, station);
    assert.ok(gap >= 0 && gap <= 60, `${id}: chef stands ${Math.round(gap)} px from the tile`);
    const s = px(station.display);
    const overlaps = (spot.x * PLAN_PX.width / 100 - CHEF_PX.width / 2) < s.l + s.w && (spot.x * PLAN_PX.width / 100 + CHEF_PX.width / 2) > s.l
      && (spot.y * PLAN_PX.height / 100 - CHEF_PX.height / 2) < s.t + s.h && (spot.y * PLAN_PX.height / 100 + CHEF_PX.height / 2) > s.t;
    assert.equal(overlaps, false, `${id}: the chef is not standing on the tile`);
  }
  assert.ok(PLAYER_RADIUS <= 8, "the collision radius is sized for the wide floor plan");
});

test("three chefs together keep enough room for their name tags AND a callout", () => {
  const spots = separatePlayerPositions(
    ["p1", "p2", "p3"].map((id) => ({ id, position: { x: 50, y: 50 } })),
    [{ x: 0, y: 0, width: 100, height: 2 }, { x: 0, y: 98, width: 100, height: 2 }, { x: 0, y: 0, width: 2, height: 100 }, { x: 98, y: 0, width: 2, height: 100 }],
  ).map((entry) => entry.position);
  for (let a = 0; a < spots.length; a += 1) {
    for (let b = a + 1; b < spots.length; b += 1) {
      const dx = Math.abs(spots[a].x - spots[b].x) * PLAN_PX.width / 100;
      const dy = Math.abs(spots[a].y - spots[b].y) * PLAN_PX.height / 100;
      // Stacked: chef + name tag + a callout above the lower chef. Side by side: room for the callout's width.
      assert.ok(dx >= 150 || dy >= CHEF_PX.height + TAG_PX + CALLOUT_PX, `chefs ${a + 1} and ${b + 1} are ${Math.round(dx)} px across and ${Math.round(dy)} px down`);
    }
  }
});
