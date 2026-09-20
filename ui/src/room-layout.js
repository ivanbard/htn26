// This matches the footprint of the scaled Figma chef sprite in the inset
// landscape room. It includes the plate sprite's vertical reach so the art
// cannot visibly cross a counter when its centre point is technically clear.
// Both are in percent of the floor plan, which is ~2.1x wider than tall, so one
// number cannot fit both axes. They are chosen from measurements of the rendered
// chef (~90 px) on a ~1240 x 585 px plan: a chef beside a station tile stands
// about a chef-width clear of it (a radius of 11 left ~100 px of daylight). Two
// chefs stacked vertically need a chef (~85 px) + a name tag (~22 px) + a
// callout above the lower one (~31 px), about 138 px, or a callout lands on the
// upper chef's tag; on this plan that is a separation of ~24.
export const PLAYER_RADIUS = 6;
export const PLAYER_SEPARATION = 24;
export const MAX_PLAYER_MOVE_MS = 1_150;

const PATH_CLEARANCE = 0.35;
const ROOM_MIN = 0;
const ROOM_MAX = 100;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));
const pointDistance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y);

function normalizedPoint(point, radius = PLAYER_RADIUS) {
  return {
    x: clamp(point?.x, ROOM_MIN + radius, ROOM_MAX - radius),
    y: clamp(point?.y, ROOM_MIN + radius, ROOM_MAX - radius),
  };
}

function normalizedBarrier(wall) {
  const x = clamp(wall?.x, ROOM_MIN, ROOM_MAX);
  const y = clamp(wall?.y, ROOM_MIN, ROOM_MAX);
  const width = clamp(wall?.width, 0, ROOM_MAX - x);
  const height = clamp(wall?.height, 0, ROOM_MAX - y);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function expandedBarrier(wall, radius = PLAYER_RADIUS) {
  return {
    x: wall.x - radius,
    y: wall.y - radius,
    width: wall.width + (radius * 2),
    height: wall.height + (radius * 2),
  };
}

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function segmentIntersectsRect(start, end, rect) {
  if (pointInRect(start, rect) || pointInRect(end, rect)) return true;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const p = [-dx, dx, -dy, dy];
  const q = [start.x - rect.x, (rect.x + rect.width) - start.x, start.y - rect.y, (rect.y + rect.height) - start.y];
  let entry = 0;
  let exit = 1;

  for (let index = 0; index < p.length; index += 1) {
    if (p[index] === 0) {
      if (q[index] < 0) return false;
      continue;
    }
    const value = q[index] / p[index];
    if (p[index] < 0) {
      if (value > exit) return false;
      entry = Math.max(entry, value);
    } else {
      if (value < entry) return false;
      exit = Math.min(exit, value);
    }
  }

  return entry <= exit;
}

function uniquePoints(points) {
  const unique = new Map();
  points.forEach((point) => {
    const key = `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
    if (!unique.has(key)) unique.set(key, point);
  });
  return [...unique.values()];
}

export function movementBarriers(walls = []) {
  const barriers = (Array.isArray(walls) ? walls : [])
    .filter((wall) => wall?.blocksMovement !== false)
    .map(normalizedBarrier)
    .filter(Boolean);
  // Station display rectangles are often nested inside their counter's
  // collision rectangle. Keeping both creates duplicate graph corners and
  // makes a three-player plan needlessly expensive without adding clearance.
  // Preserve overlapping/sibling barriers; only discard strict containment.
  return barriers.filter((barrier, index) => !barriers.some((outer, outerIndex) => (
    index !== outerIndex
      && outer.x <= barrier.x
      && outer.y <= barrier.y
      && outer.x + outer.width >= barrier.x + barrier.width
      && outer.y + outer.height >= barrier.y + barrier.height
      && (outer.x < barrier.x || outer.y < barrier.y
        || outer.width > barrier.width || outer.height > barrier.height)
  )));
}

export function isWalkablePosition(point, walls = [], radius = PLAYER_RADIUS) {
  const candidate = finite(point?.x, NaN) === point?.x && finite(point?.y, NaN) === point?.y
    ? { x: Number(point.x), y: Number(point.y) }
    : null;
  if (!candidate) return false;
  if (candidate.x < ROOM_MIN + radius || candidate.x > ROOM_MAX - radius
    || candidate.y < ROOM_MIN + radius || candidate.y > ROOM_MAX - radius) return false;

  return !movementBarriers(walls).some((wall) => pointInRect(candidate, expandedBarrier(wall, radius)));
}

export function projectPointIntoWalkableRoom(point, walls = [], fallback = { x: 50, y: 88 }, radius = PLAYER_RADIUS) {
  const barriers = movementBarriers(walls);
  const candidate = normalizedPoint(point, radius);
  if (isWalkablePosition(candidate, barriers, radius)) return candidate;

  const projected = barriers.flatMap((wall) => {
    const edge = radius + PATH_CLEARANCE;
    const left = wall.x - edge;
    const right = wall.x + wall.width + edge;
    const top = wall.y - edge;
    const bottom = wall.y + wall.height + edge;
    return [
      { x: left, y: candidate.y },
      { x: right, y: candidate.y },
      { x: candidate.x, y: top },
      { x: candidate.x, y: bottom },
      { x: left, y: top },
      { x: right, y: top },
      { x: left, y: bottom },
      { x: right, y: bottom },
    ].map((value) => normalizedPoint(value, radius));
  });
  const safeCandidates = uniquePoints([...projected, normalizedPoint(fallback, radius)])
    .filter((value) => isWalkablePosition(value, barriers, radius))
    .sort((left, right) => pointDistance(left, candidate) - pointDistance(right, candidate)
      || left.x - right.x || left.y - right.y);

  return safeCandidates[0] || normalizedPoint(fallback, radius);
}

function pathIsClear(start, end, barriers, radius) {
  return !barriers.some((wall) => segmentIntersectsRect(start, end, expandedBarrier(wall, radius)));
}

function routeWaypoints(barriers, radius) {
  return barriers.flatMap((wall) => {
    const expanded = expandedBarrier(wall, radius + PATH_CLEARANCE);
    return [
      { x: expanded.x, y: expanded.y },
      { x: expanded.x + expanded.width, y: expanded.y },
      { x: expanded.x, y: expanded.y + expanded.height },
      { x: expanded.x + expanded.width, y: expanded.y + expanded.height },
    ].map((point) => normalizedPoint(point, radius));
  });
}

export function routePlayerPath(from, to, walls = [], radius = PLAYER_RADIUS) {
  const barriers = movementBarriers(walls);
  const start = projectPointIntoWalkableRoom(from, barriers, from, radius);
  const end = projectPointIntoWalkableRoom(to, barriers, start, radius);
  if (pathIsClear(start, end, barriers, radius)) return [start, end];

  const nodes = uniquePoints([start, end, ...routeWaypoints(barriers, radius)])
    .filter((point) => isWalkablePosition(point, barriers, radius));
  const startIndex = nodes.findIndex((point) => point.x === start.x && point.y === start.y);
  const endIndex = nodes.findIndex((point) => point.x === end.x && point.y === end.y);
  const distances = nodes.map((_, index) => index === startIndex ? 0 : Number.POSITIVE_INFINITY);
  const previous = nodes.map(() => -1);
  const visited = new Set();

  while (visited.size < nodes.length) {
    let current = -1;
    nodes.forEach((_, index) => {
      if (!visited.has(index) && (current === -1 || distances[index] < distances[current])) current = index;
    });
    if (current === -1 || current === endIndex || !Number.isFinite(distances[current])) break;
    visited.add(current);
    nodes.forEach((node, index) => {
      if (visited.has(index) || !pathIsClear(nodes[current], node, barriers, radius)) return;
      const nextDistance = distances[current] + pointDistance(nodes[current], node);
      if (nextDistance < distances[index]) {
        distances[index] = nextDistance;
        previous[index] = current;
      }
    });
  }

  if (!Number.isFinite(distances[endIndex])) return [start];
  const route = [];
  for (let index = endIndex; index !== -1; index = previous[index]) route.unshift(nodes[index]);
  return route;
}

function displayOffsets(step = PLAYER_SEPARATION) {
  return [
    { x: 0, y: 0 },
    { x: 0, y: -step },
    { x: step, y: 0 },
    { x: 0, y: step },
    { x: -step, y: 0 },
    { x: step * .72, y: -step * .72 },
    { x: step * .72, y: step * .72 },
    { x: -step * .72, y: step * .72 },
    { x: -step * .72, y: -step * .72 },
    { x: 0, y: -step * 2 },
    { x: step * 2, y: 0 },
    { x: 0, y: step * 2 },
    { x: -step * 2, y: 0 },
    { x: step * 1.45, y: -step * 1.45 },
    { x: step * 1.45, y: step * 1.45 },
    { x: -step * 1.45, y: step * 1.45 },
    { x: -step * 1.45, y: -step * 1.45 },
  ];
}

function roomWalkableCandidates(walls, radius, preferred) {
  const candidates = [];
  const step = Math.max(3, Math.min(6, PLAYER_SEPARATION / 3));
  for (let y = ROOM_MIN + radius; y <= ROOM_MAX - radius; y += step) {
    for (let x = ROOM_MIN + radius; x <= ROOM_MAX - radius; x += step) {
      const point = { x, y };
      if (isWalkablePosition(point, walls, radius)) candidates.push(point);
    }
  }
  return candidates.sort((left, right) => pointDistance(left, preferred) - pointDistance(right, preferred));
}

export function separatePlayerPositions(players = [], walls = [], radius = PLAYER_RADIUS, separation = PLAYER_SEPARATION) {
  const source = Array.isArray(players) ? players : [];
  const positioned = source
    .filter((player) => player?.position)
    .map((player) => ({ ...player, position: projectPointIntoWalkableRoom(player.position, walls, player.position, radius) }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const occupied = [];
  const byId = new Map();
  const roomCandidates = roomWalkableCandidates(walls, radius, { x: 50, y: 50 });

  positioned.forEach((player) => {
    const candidates = displayOffsets(separation)
      .map((offset) => projectPointIntoWalkableRoom({ x: player.position.x + offset.x, y: player.position.y + offset.y }, walls, player.position, radius));
    const slot = [...candidates, ...roomCandidates]
      .find((candidate) => occupied.every((existing) => pointDistance(candidate, existing) >= separation))
      || player.position;
    occupied.push(slot);
    byId.set(player.id, slot);
  });

  return source.map((player) => player?.position ? { ...player, position: byId.get(player.id) || player.position } : { ...player });
}

// A destination can be clear of every other destination and still be occupied
// by a chef who is about to leave. Reserve the other chefs' current display
// positions while assigning target slots so one chef cannot arrive on top of a
// waiting chef during a scan animation.
function separateTargetPositions(players = [], walls = [], radius = PLAYER_RADIUS, separation = PLAYER_SEPARATION) {
  const source = Array.isArray(players) ? players : [];
  const starts = new Map(source.filter((player) => player?.position).map((player) => [player.id, player.startPosition || player.position]));
  const positioned = source
    .filter((player) => player?.position)
    .map((player) => ({ ...player, position: projectPointIntoWalkableRoom(player.targetPosition || player.position, walls, player.position, radius) }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const occupied = [];
  const byId = new Map();
  const roomCandidates = roomWalkableCandidates(walls, radius, { x: 50, y: 50 });

  positioned.forEach((player) => {
    const otherStarts = [...starts.entries()]
      .filter(([id]) => id !== player.id)
      .map(([, point]) => point);
    const candidates = displayOffsets(separation)
      .map((offset) => projectPointIntoWalkableRoom({ x: player.position.x + offset.x, y: player.position.y + offset.y }, walls, player.position, radius));
    const slot = [...candidates, ...roomCandidates].find((candidate) => (
      [...occupied, ...otherStarts].every((existing) => pointDistance(candidate, existing) >= separation)
    )) || player.position;
    occupied.push(slot);
    byId.set(player.id, slot);
  });

  return source.map((player) => player?.position ? { ...player, position: byId.get(player.id) || player.position } : { ...player });
}

function pathLength(path = []) {
  return path.slice(1).reduce((sum, point, index) => sum + pointDistance(point, path[index]), 0);
}

export function pointAlongPath(path = [], progress = 0) {
  if (!path.length) return null;
  if (path.length === 1) return { ...path[0] };
  const total = pathLength(path);
  if (total <= 0) return { ...path[0] };
  let remaining = total * clamp(progress, 0, 1);
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    const length = pointDistance(from, to);
    if (remaining <= length || index === path.length - 1) {
      const ratio = length > 0 ? remaining / length : 1;
      return {
        x: from.x + ((to.x - from.x) * ratio),
        y: from.y + ((to.y - from.y) * ratio),
      };
    }
    remaining -= length;
  }
  return { ...path.at(-1) };
}

function pathKey(path) {
  return path.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join("|");
}

function joinPaths(first, second) {
  if (!first.length) return second;
  if (!second.length) return first;
  const tail = first.at(-1);
  const head = second[0];
  return [...first, ...(tail.x === head.x && tail.y === head.y ? second.slice(1) : second)];
}

function geometryKey(walls, radius) {
  return `${radius}|${movementBarriers(walls).map((wall) => (
    `${wall.x.toFixed(3)},${wall.y.toFixed(3)},${wall.width.toFixed(3)},${wall.height.toFixed(3)}`
  )).join(";")}`;
}

function candidatePaths(from, to, walls, radius, cache = null) {
  const cacheKey = cache
    ? `${from.x.toFixed(3)},${from.y.toFixed(3)}>${to.x.toFixed(3)},${to.y.toFixed(3)}|${geometryKey(walls, radius)}`
    : null;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
  const barriers = movementBarriers(walls);
  const candidates = [routePlayerPath(from, to, barriers, radius)];
  // The base graph returns the shortest safe route. These waypoint variants
  // are the alternate lanes used when another chef reserves that same route.
  // Only obstacles touched by the straight-line corridor can affect an
  // alternate lane. Considering corners from unrelated counters multiplies
  // the graph work without creating a useful route.
  const corridorBarriers = barriers.filter((barrier) => segmentIntersectsRect(
    from,
    to,
    expandedBarrier(barrier, radius + PATH_CLEARANCE),
  ));
  routeWaypoints(corridorBarriers, radius).forEach((waypoint) => {
    const first = routePlayerPath(from, waypoint, barriers, radius);
    const second = routePlayerPath(waypoint, to, barriers, radius);
    const joined = joinPaths(first, second);
    if (joined.length > 1) candidates.push(joined);
  });
  // When two chefs would exchange positions in an open lane, a small
  // perpendicular arc is a better solution than serializing one of them at
  // the other's destination. These two lanes are also useful around a wide
  // obstacle when a corner route is not enough to separate animation paths.
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance > 0) {
    const perpendicular = { x: -dy / distance, y: dx / distance };
    [PLAYER_SEPARATION * 1.5, -PLAYER_SEPARATION * 1.5, PLAYER_SEPARATION * 2.25, -PLAYER_SEPARATION * 2.25].forEach((offset) => {
      const waypoint = projectPointIntoWalkableRoom({
        x: from.x + (dx * .5) + (perpendicular.x * offset),
        y: from.y + (dy * .5) + (perpendicular.y * offset),
      }, barriers, from, radius);
      if (!isWalkablePosition(waypoint, barriers, radius)) return;
      const first = routePlayerPath(from, waypoint, barriers, radius);
      const second = routePlayerPath(waypoint, to, barriers, radius);
      const joined = joinPaths(first, second);
      if (joined.length > 1) candidates.push(joined);
    });
  }
  const unique = new Map();
  candidates.forEach((path) => unique.set(pathKey(path), path));
  const result = [...unique.values()]
    // A one-point route is the blocked-geometry sentinel from
    // routePlayerPath, not a usable candidate. Keep it out of reservation
    // ranking whenever a real route exists; otherwise the caller returns the
    // sentinel explicitly and marks the target as unreached.
    .filter((path) => path.length > 1 && path.every((point) => isWalkablePosition(point, barriers, radius))
      && pathIsWalkable(path, barriers, radius))
    .sort((left, right) => pathLength(left) - pathLength(right));
  if (cacheKey) cache.set(cacheKey, result);
  return result;
}

function sampleCountForPaths(left, right) {
  return Math.max(24, Math.min(180, Math.ceil(Math.max(pathLength(left), pathLength(right)) / 1.5)));
}

/**
 * Check two paths in the same normalized time domain. The renderer moves all
 * chefs at a constant path speed, so equal progress represents equal time.
 */
export function pathsHaveAgentConflict(left = [], right = [], separation = PLAYER_SEPARATION) {
  if (!left.length || !right.length) return false;
  const samples = sampleCountForPaths(left, right);
  for (let index = 0; index <= samples; index += 1) {
    const progress = index / samples;
    if (pointDistance(pointAlongPath(left, progress), pointAlongPath(right, progress)) < separation) return true;
  }
  return false;
}

function pointForPlanAtTime(plan, time) {
  const delay = plan.delayMs || 0;
  const duration = plan.durationMs || travelDuration(plan.path);
  if (time <= delay) return plan.path[0];
  if (time >= delay + duration) return plan.path.at(-1);
  return pointAlongPath(plan.path, (time - delay) / duration);
}

/**
 * Check two reservations in real animation time, including their waiting
 * periods and the time each chef remains at its destination. Comparing only
 * equal path percentages misses collisions when one route is longer.
 */
export function plansHaveTemporalConflict(left, right, separation = PLAYER_SEPARATION) {
  if (!left?.path?.length || !right?.path?.length) return false;
  const horizon = Math.max(
    (left.delayMs || 0) + (left.durationMs || travelDuration(left.path)),
    (right.delayMs || 0) + (right.durationMs || travelDuration(right.path)),
  );
  const samples = Math.max(32, Math.min(240, Math.ceil(horizon / 35)));
  for (let index = 0; index <= samples; index += 1) {
    const time = (horizon * index) / samples;
    if (pointDistance(pointForPlanAtTime(left, time), pointForPlanAtTime(right, time)) < separation) return true;
  }
  return false;
}

function pathIsWalkable(path, walls, radius) {
  if (!path.length) return false;
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    const length = pointDistance(from, to);
    const samples = Math.max(2, Math.ceil(length / 1.5));
    for (let step = 0; step <= samples; step += 1) {
      const progress = step / samples;
      if (!isWalkablePosition({
        x: from.x + ((to.x - from.x) * progress),
        y: from.y + ((to.y - from.y) * progress),
      }, walls, radius)) return false;
    }
  }
  return isWalkablePosition(path[0], walls, radius);
}

function travelDuration(path) {
  return Math.min(MAX_PLAYER_MOVE_MS, Math.max(460, pathLength(path) * 19));
}

export function movementEase(progress) {
  const value = clamp(progress, 0, 1);
  // Cubic ease-in-out keeps the first and last frames gentle while ensuring
  // every scan-to-scan movement settles in at most MAX_PLAYER_MOVE_MS.
  const eased = value < 0.5
    ? 4 * value * value * value
    : 1 - (((-2 * value) + 2) ** 3) / 2;
  return eased === 0 ? 0 : eased;
}

export function headingForPath(path = [], progress = 1, fallback = 0) {
  if (!Array.isArray(path) || path.length < 2) return fallback;
  const value = clamp(progress, 0, 1);
  const before = pointAlongPath(path, Math.max(0, value - 0.002));
  const after = pointAlongPath(path, Math.min(1, value + 0.002));
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  if (Math.hypot(dx, dy) < 0.001) return fallback;
  // The art faces down by default. CSS positive rotation moves that forward
  // vector counter-clockwise in screen coordinates, hence the negated dx.
  return Math.atan2(-dx, dy) * (180 / Math.PI);
}

function reservationDelays(reservations) {
  const latestReservationEnd = reservations.reduce((latest, reservation) => Math.max(
    latest,
    (reservation.delayMs || 0) + (reservation.durationMs || travelDuration(reservation.path)),
  ), 0);
  const delays = new Set([0, latestReservationEnd + 120]);
  const maxDelay = Math.min(5_000, latestReservationEnd + 2_500);
  for (let delay = 120; delay <= maxDelay; delay += 120) delays.add(delay);
  reservations.forEach((reservation) => delays.add(
    (reservation.delayMs || 0) + (reservation.durationMs || travelDuration(reservation.path)) + 120,
  ));
  return [...delays].sort((left, right) => left - right);
}

function avoidanceBarriers(points, radius, separation) {
  const half = Math.max(.5, separation - radius);
  return (Array.isArray(points) ? points : [])
    .filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)))
    .map((point, index) => ({
      id: `chef-avoidance-${index}`,
      x: Number(point.x) - half,
      y: Number(point.y) - half,
      width: half * 2,
      height: half * 2,
      blocksMovement: true,
    }));
}

function chooseReservedPlan(candidates, reservations, separation, avoidPoints = [], softAvoidPoints = avoidPoints) {
  const ranked = [];
  candidates.forEach((path) => {
    const durationMs = travelDuration(path);
    const staticConflicts = softAvoidPoints.reduce((count, point) => (
      count + (pathsHaveAgentConflict(path, [point], separation) ? 1 : 0)
    ), 0);
    reservationDelays(reservations).forEach((delayMs) => {
      const candidate = { path, delayMs, durationMs };
      const conflicts = reservations.reduce((count, reservation) => (
        count + (plansHaveTemporalConflict(candidate, reservation, separation) ? 1 : 0)
      ), 0);
      ranked.push({ ...candidate, conflicts, staticConflicts });
    });
  });
  ranked.sort((left, right) => left.conflicts - right.conflicts
    || left.staticConflicts - right.staticConflicts
    || left.delayMs - right.delayMs
    || pathLength(left.path) - pathLength(right.path));
  return ranked[0] || {
    path: candidates[0] || [],
    delayMs: 0,
    durationMs: travelDuration(candidates[0] || []),
    conflicts: reservations.length,
    staticConflicts: softAvoidPoints.length,
  };
}

/**
 * Single-agent obstacle routing with reservations from higher-priority
 * players. It tries the shortest route first, then alternate wall-corner
 * lanes, and finally returns the least-conflicting route for queueing.
 */
export function routePlayerPathWithReservations(from, to, walls = [], reservations = [], radius = PLAYER_RADIUS, separation = PLAYER_SEPARATION, avoidPoints = [], softAvoidPoints = avoidPoints, cache = null) {
  // Turn other chefs' current/destination centres into small dynamic square
  // barriers. Their player-radius expansion produces the same separation
  // rule used by the temporal checker, so a route cannot cut through a chef's
  // final resting spot just because that chef arrived there earlier.
  const planningWalls = [
    ...(Array.isArray(walls) ? walls : []),
    ...avoidanceBarriers(avoidPoints, radius, separation),
  ];
  // Keep a static-geometry candidate as a fallback. A reserved destination is
  // occupied only after its owner arrives; treating it as a permanent wall
  // can incorrectly seal the only lane around a central island. The planner
  // still ranks that candidate against the dynamic-avoidance routes and can
  // queue it behind the reservation when that is the safe temporal choice.
  const candidateMap = new Map();
  // Dynamic avoidance squares can make a destination temporarily occupied.
  // Do not accept the route helper's projected substitute as if it were the
  // requested station; the static route can be delayed until that chef moves.
  const dynamicCandidates = candidatePaths(from, to, planningWalls, radius, cache)
    .filter((path) => pointDistance(path.at(-1), to) < 0.5);
  [...dynamicCandidates, ...candidatePaths(from, to, walls, radius, cache)]
    .forEach((path) => candidateMap.set(pathKey(path), path));
  const candidates = [...candidateMap.values()];
  if (!candidates.length) return { path: [projectPointIntoWalkableRoom(from, walls, from, radius)], conflicts: reservations.length, strategy: "blocked-fallback" };
  const choice = chooseReservedPlan(candidates, reservations, separation, avoidPoints, softAvoidPoints);
  return {
    path: choice.path,
    delayMs: choice.delayMs,
    durationMs: choice.durationMs,
    conflicts: choice.conflicts,
    strategy: choice.conflicts ? "queued-reservation" : choice.delayMs ? "queued-reservation" : "prioritized-reservation",
  };
}

/**
 * Generate alternate priority orders for the small number of chefs on this
 * board. A greedy reservation order can make a later chef's starting square
 * an unavoidable crossing point; trying the six possible orders for three
 * chefs lets the planner choose a genuinely disjoint schedule instead of
 * accepting a route that is only locally optimal.
 */
function priorityOrders(players) {
  const ordered = [...players].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (ordered.length > 4) return [ordered];
  const results = [];
  const visit = (remaining, current) => {
    if (!remaining.length) {
      results.push(current);
      return;
    }
    remaining.forEach((player, index) => visit(
      [...remaining.slice(0, index), ...remaining.slice(index + 1)],
      [...current, player],
    ));
  };
  visit(ordered, []);
  return results;
}

export function planPlayerPaths(players = [], walls = [], {
  radius = PLAYER_RADIUS,
  separation = PLAYER_SEPARATION,
} = {}) {
  const source = Array.isArray(players) ? players.filter((player) => player?.position) : [];
  const safeSources = separatePlayerPositions(source, walls, radius, separation);
  const targetPlayers = separateTargetPositions(safeSources.map((player) => ({
    ...player,
    startPosition: player.position,
    position: player.targetPosition || player.position,
  })), walls, radius, separation);
  const targets = new Map(targetPlayers.map((player) => [player.id, player.position]));
  const requestedTargets = new Map(source.map((player) => [player.id, player.targetPosition || player.position]));
  const starts = new Map(safeSources.map((player) => [player.id, player.position]));
  const candidateCache = new Map();

  const buildPlan = (orderedPlayers) => {
    const reservations = [];
    const plans = new Map();
    orderedPlayers.forEach((player) => {
      const start = projectPointIntoWalkableRoom(starts.get(player.id) || player.position, walls, player.position, radius);
      const requestedTarget = targets.get(player.id) || player.position;
      const targetWasWalkable = isWalkablePosition(requestedTargets.get(player.id), walls, radius);
      const target = projectPointIntoWalkableRoom(requestedTarget, walls, start, radius);
      const otherStartPoints = [...starts.entries()]
        .filter(([id]) => id !== player.id)
        .map(([, point]) => point);
      const reservedDestinationPoints = reservations.map((reservation) => reservation.path.at(-1)).filter(Boolean);
      const result = routePlayerPathWithReservations(
        start,
        target,
        walls,
        reservations,
        radius,
        separation,
        reservedDestinationPoints,
        [...otherStartPoints, ...reservedDestinationPoints],
        candidateCache,
      );
      const plan = {
        path: result.path,
        delayMs: result.delayMs || 0,
        durationMs: result.durationMs || travelDuration(result.path),
        conflicts: result.conflicts,
        strategy: result.strategy,
        reachedTarget: targetWasWalkable && pointDistance(result.path.at(-1), target) < 0.5,
      };
      plans.set(player.id, plan);
      reservations.push({ id: player.id, ...plan });
    });
    return plans;
  };

  const orderedPlayers = priorityOrders(safeSources);
  const firstPlan = buildPlan(orderedPlayers[0] || []);
  if (playerPlansAreCollisionSafe(firstPlan, separation)) return firstPlan;
  let bestPlan = firstPlan;
  let bestScore = Number.POSITIVE_INFINITY;
  orderedPlayers.slice(1).forEach((order) => {
    const candidate = buildPlan(order);
    const safe = playerPlansAreCollisionSafe(candidate, separation);
    const score = (safe ? 0 : 1_000_000)
      + [...candidate.values()].reduce((sum, plan) => sum + (plan.conflicts || 0) + (plan.path.length < 2 ? 100 : 0), 0)
      + [...candidate.values()].reduce((sum, plan) => sum + (plan.delayMs || 0) / 1_000_000, 0);
    if (score < bestScore) {
      bestScore = score;
      bestPlan = candidate;
    }
  });
  // If simultaneous paths are impossible for this scan, let one chef make
  // progress while the other two wait in their already-separated positions.
  // This is safer and less glitchy than freezing the whole kitchen, and the
  // next authoritative scan will re-plan from the moved chef's new position.
  for (const player of safeSources) {
    const start = starts.get(player.id);
    const target = targets.get(player.id) || start;
    const otherStarts = [...starts.entries()]
      .filter(([id]) => id !== player.id)
      .map(([, point]) => point);
    const result = routePlayerPathWithReservations(
      start,
      target,
      walls,
      [],
      radius,
      separation,
      otherStarts,
      otherStarts,
      candidateCache,
    );
    const mover = {
      path: result.path,
      delayMs: 0,
      durationMs: result.durationMs || travelDuration(result.path),
      conflicts: result.conflicts,
      strategy: "single-mover-queue",
      reachedTarget: pointDistance(result.path.at(-1), target) < 0.5,
    };
    const fallback = new Map(safeSources.map((candidate) => [candidate.id, candidate.id === player.id
      ? mover
      : {
          path: [starts.get(candidate.id), starts.get(candidate.id)],
          delayMs: 0,
          durationMs: 460,
          conflicts: 0,
          strategy: "single-mover-hold",
          reachedTarget: false,
        }]));
    if (playerPlansAreCollisionSafe(fallback, separation)) return fallback;
  }
  // If every priority permutation still contains a temporal crossing, hold
  // the chefs in their already-separated safe slots for this snapshot. This
  // is the final safety gate for an over-constrained or impossible geometry.
  const holdingPlan = new Map(safeSources.map((player) => [player.id, {
    path: [player.position, player.position],
    delayMs: 0,
    durationMs: 460,
    conflicts: 0,
    strategy: "collision-hold",
    reachedTarget: false,
  }]));
  if (playerPlansAreCollisionSafe(holdingPlan, separation)) return holdingPlan;
  return bestPlan;
}

export function playerPlansAreCollisionSafe(plans, separation = PLAYER_SEPARATION) {
  const values = plans instanceof Map ? [...plans.values()] : Object.values(plans || {});
  for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
      const left = values[leftIndex];
      const right = values[rightIndex];
      const horizon = Math.max(
        (left.delayMs || 0) + (left.durationMs || travelDuration(left.path)),
        (right.delayMs || 0) + (right.durationMs || travelDuration(right.path)),
      );
      const samples = Math.max(24, Math.min(180, Math.ceil(horizon / 40)));
      for (let index = 0; index <= samples; index += 1) {
        const time = (horizon * index) / samples;
        const pointForPlan = (plan) => {
          const delay = plan.delayMs || 0;
          const duration = plan.durationMs || travelDuration(plan.path);
          if (time <= delay) return plan.path[0];
          if (time >= delay + duration) return plan.path.at(-1);
          return pointAlongPath(plan.path, (time - delay) / duration);
        };
        if (pointDistance(pointForPlan(left), pointForPlan(right)) < separation) return false;
      }
    }
  }
  return true;
}
