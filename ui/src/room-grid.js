// The standard burger room is authored as a tile map rather than a list of
// unrelated percentages. The playable room is a 2:1 landscape surface, so
// 22 columns by 11 rows gives every logical tile the same physical size.
// Stations, counters, and collision geometry all come from these same cells.

export const STANDARD_ROOM_GRID = Object.freeze({
  columns: 22,
  rows: 11,
  coordinateSpace: "normalized-percent",
});

// The matrix cell remains the authoritative NFC/collision anchor. The art is
// deliberately rendered at two cells in both directions so it is legible on
// a projector. Each appliance's anchor cell is the top-left cell of its 2x2
// footprint, and every counter is two rows thick, so the art sits exactly on
// the counter instead of overhanging it. The slots below leave a full logical
// cell between appliances so the enlarged tiles never overlap each other.
export const STANDARD_STATION_DISPLAY_SCALE = 2;

const ROOM_WIDTH = 100;
const ROOM_HEIGHT = 100;
const round = (value) => Math.round(value * 1_000_000) / 1_000_000;

const STATION_SLOTS = Object.freeze([
  { id: "cheese-source", label: "CHEESE", kind: "ingredient", column: 1, row: 1, assetKey: "FRIDGE", contents: ["CHEESE"] },
  { id: "meat-source", label: "MEAT", kind: "ingredient", column: 4, row: 1, assetKey: "FRIDGE", contents: ["MEAT"] },
  { id: "lettuce-source", label: "LETTUCE", kind: "ingredient", column: 7, row: 1, assetKey: "PANTRY", contents: ["LETTUCE"] },
  { id: "buns-source", label: "BUNS", kind: "ingredient", column: 10, row: 1, assetKey: "PANTRY", contents: ["BUN"] },
  { id: "stove1", label: "STOVE 1", kind: "stove", column: 15, row: 1, assetKey: "STOVE" },
  { id: "stove2", label: "STOVE 2", kind: "stove", column: 19, row: 1, assetKey: "STOVE" },
  { id: "assembly", label: "ASSEMBLY", kind: "assembly", column: 13, row: 8, assetKey: "COUNTER", contents: ["BUN", "COOKED MEAT", "SHREDDED LETTUCE"] },
  { id: "chop1", label: "CHOP 1", kind: "chop", column: 2, row: 8, assetKey: "CHOP" },
  { id: "chop2", label: "CHOP 2", kind: "chop", column: 6, row: 8, assetKey: "CHOP" },
]);

const COUNTER_REGIONS = Object.freeze([
  // Counters are as thick as the appliance art (two tiles). They stop one
  // column short of the east wall and one row short of the north/south walls.
  { id: "pantry-counter", column: 1, row: 1, columns: 12, rows: 2 },
  { id: "stove-counter", column: 14, row: 1, columns: 7, rows: 2 },
  { id: "chop-counter", column: 1, row: 8, columns: 10, rows: 2 },
  // The assembly counter sits in the bottom row beside the chopping counter.
  // There is deliberately no center island: with two-tile-thick
  // perimeter counters and the chef collision radius, any obstacle in the
  // middle would split the room into two halves players cannot cross. The
  // assembly tile displays the plate and the current burger components.
  { id: "assembly-counter", column: 12, row: 8, columns: 4, rows: 2 },
]);

function cellRect(column, row, columns = 1, rows = 1) {
  return {
    x: round((column / STANDARD_ROOM_GRID.columns) * ROOM_WIDTH),
    y: round((row / STANDARD_ROOM_GRID.rows) * ROOM_HEIGHT),
    width: round((columns / STANDARD_ROOM_GRID.columns) * ROOM_WIDTH),
    height: round((rows / STANDARD_ROOM_GRID.rows) * ROOM_HEIGHT),
  };
}

function gridMetadata(column, row, columnSpan = 1, rowSpan = 1) {
  return {
    column,
    row,
    columnSpan,
    rowSpan,
  };
}

function emptyCell() {
  return { type: "floor", blocksMovement: false, stationId: null };
}

function createMatrix() {
  return Array.from({ length: STANDARD_ROOM_GRID.rows }, (_, row) => (
    Array.from({ length: STANDARD_ROOM_GRID.columns }, (_, column) => {
      const boundary = row === 0 || row === STANDARD_ROOM_GRID.rows - 1
        || column === 0 || column === STANDARD_ROOM_GRID.columns - 1;
      return boundary ? { type: "wall", blocksMovement: true, stationId: null } : emptyCell();
    })
  ));
}

function setRegion(matrix, region, type = "counter") {
  for (let row = region.row; row < region.row + region.rows; row += 1) {
    for (let column = region.column; column < region.column + region.columns; column += 1) {
      if (!matrix[row]?.[column]) continue;
      matrix[row][column] = { ...matrix[row][column], type, blocksMovement: true };
    }
  }
}

function setStation(matrix, station) {
  const current = matrix[station.row]?.[station.column];
  if (!current) throw new Error(`Station ${station.id} is outside the standard room grid.`);
  matrix[station.row][station.column] = {
    ...current,
    type: "station",
    blocksMovement: true,
    stationId: station.id,
  };
}

function matrixForLayout() {
  const matrix = createMatrix();
  COUNTER_REGIONS.forEach((region) => setRegion(matrix, region));
  STATION_SLOTS.forEach((station) => setStation(matrix, station));
  return matrix;
}

function serialiseMatrix(matrix) {
  return matrix.map((row) => row.map((cell) => ({ ...cell })));
}

function rectForRegion(region) {
  return {
    id: region.id,
    ...cellRect(region.column, region.row, region.columns, region.rows),
    grid: gridMetadata(region.column, region.row, region.columns, region.rows),
    blocksMovement: true,
  };
}

function displayRectForSlot(slot) {
  const baseWidth = ROOM_WIDTH / STANDARD_ROOM_GRID.columns;
  const baseHeight = ROOM_HEIGHT / STANDARD_ROOM_GRID.rows;
  const width = round(baseWidth * STANDARD_STATION_DISPLAY_SCALE);
  const height = round(baseHeight * STANDARD_STATION_DISPLAY_SCALE);
  // Anchor the footprint at the slot's top-left cell so it lines up with the
  // counter's tile edges rather than straddling them.
  const x = (slot.column / STANDARD_ROOM_GRID.columns) * ROOM_WIDTH;
  const y = (slot.row / STANDARD_ROOM_GRID.rows) * ROOM_HEIGHT;
  return {
    x: round(Math.max(0, Math.min(ROOM_WIDTH - width, x))),
    y: round(Math.max(0, Math.min(ROOM_HEIGHT - height, y))),
    width,
    height,
  };
}

function stationForSlot(slot) {
  return {
    id: slot.id,
    label: slot.label,
    kind: slot.kind,
    assetKey: slot.assetKey,
    contents: slot.contents,
    ...cellRect(slot.column, slot.row),
    display: displayRectForSlot(slot),
    grid: gridMetadata(slot.column, slot.row),
  };
}

const PLACEMENT_TEXT = Object.freeze({
  "cheese-source": "Place cheese on the left top counter tile",
  "meat-source": "Place meat beside the cheese tile",
  "lettuce-source": "Place lettuce beside the meat tile",
  "buns-source": "Place buns at the end of the ingredient row",
  assembly: "Use the bottom-center counter to assemble the current burger on a plate",
  chop1: "Keep the first chopping board on the lower-left counter",
  chop2: "Keep the second chopping board beside chop 1",
  stove1: "Use the left burner on the upper-right counter",
  stove2: "Use the right burner beside stove 1",
});

export function createStandardRoomPlan() {
  const matrix = matrixForLayout();
  const stations = STATION_SLOTS.map(stationForSlot);
  return {
    coordinateSpace: STANDARD_ROOM_GRID.coordinateSpace,
    width: ROOM_WIDTH,
    height: ROOM_HEIGHT,
    grid: {
      columns: STANDARD_ROOM_GRID.columns,
      rows: STANDARD_ROOM_GRID.rows,
      tileWidth: round(ROOM_WIDTH / STANDARD_ROOM_GRID.columns),
      tileHeight: round(ROOM_HEIGHT / STANDARD_ROOM_GRID.rows),
      cells: serialiseMatrix(matrix),
    },
    walls: [
      { id: "north-wall", ...cellRect(0, 0, STANDARD_ROOM_GRID.columns, 1), blocksMovement: true, grid: gridMetadata(0, 0, STANDARD_ROOM_GRID.columns, 1) },
      { id: "south-wall", ...cellRect(0, STANDARD_ROOM_GRID.rows - 1, STANDARD_ROOM_GRID.columns, 1), blocksMovement: true, grid: gridMetadata(0, STANDARD_ROOM_GRID.rows - 1, STANDARD_ROOM_GRID.columns, 1) },
      { id: "west-wall", ...cellRect(0, 0, 1, STANDARD_ROOM_GRID.rows), blocksMovement: true, grid: gridMetadata(0, 0, 1, STANDARD_ROOM_GRID.rows) },
      { id: "east-wall", ...cellRect(STANDARD_ROOM_GRID.columns - 1, 0, 1, STANDARD_ROOM_GRID.rows), blocksMovement: true, grid: gridMetadata(STANDARD_ROOM_GRID.columns - 1, 0, 1, STANDARD_ROOM_GRID.rows) },
      ...COUNTER_REGIONS.map(rectForRegion),
    ],
    stations,
    placementInstructions: stations.map((station) => ({
      id: station.id,
      label: `${station.label} ${station.kind === "ingredient" ? "SOURCE" : ""}`.trim(),
      instruction: PLACEMENT_TEXT[station.id],
      x: station.x,
      y: station.y,
      width: station.width,
      height: station.height,
      grid: { ...station.grid },
    })),
  };
}

export function stationTileKey(station) {
  return station?.grid ? `${station.grid.column}:${station.grid.row}` : null;
}

export function hasStationTileCollisions(stations = []) {
  const keys = stations.map(stationTileKey).filter(Boolean);
  return new Set(keys).size !== keys.length;
}
