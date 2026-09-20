import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { URL } from "node:url";

const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

function json(value) { return JSON.stringify(value); }
function publicError(message) { return { error: message }; }
function contentType(req) { return String(req.headers["content-type"] || ""); }
function mediaType(type) { return type.split(";", 1)[0].trim().toLowerCase(); }
function elapsedMs(start) { return Math.max(0, Number(process.hrtime.bigint() - start) / 1_000_000); }

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : json(body));
  res.writeHead(status, {
    "content-type": headers["content-type"] || "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function corsHeaders(origin = "*") {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,accept,x-photo-name",
  };
}

async function readBody(req, maximum = MAX_REQUEST_BYTES) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maximum) throw Object.assign(new Error("request body is too large"), { statusCode: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error("request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(buffer) {
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString("utf8")); }
  catch { throw Object.assign(new Error("request body must be valid JSON"), { statusCode: 400 }); }
}

function parseContentDisposition(value) {
  const name = value.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1] || "";
  const filename = value.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1] || "";
  return { name, filename };
}

function parseMultipart(buffer, type) {
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || type.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw Object.assign(new Error("multipart upload is missing its boundary"), { statusCode: 400 });
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(delimiter);
  while (cursor >= 0) {
    const start = cursor + delimiter.length;
    if (buffer.slice(start, start + 2).toString() === "--") break;
    const headerStart = start + (buffer.slice(start, start + 2).toString() === "\r\n" ? 2 : 0);
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const next = buffer.indexOf(delimiter, headerEnd + 4);
    if (next < 0) break;
    const headerText = buffer.slice(headerStart, headerEnd).toString("utf8");
    const bodyEnd = next - (buffer.slice(next - 2, next).toString() === "\r\n" ? 2 : 0);
    const headers = Object.fromEntries(headerText.split("\r\n").map((line) => {
      const split = line.indexOf(":");
      return split < 0 ? [line.toLowerCase(), ""] : [line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim()];
    }));
    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    parts.push({ ...disposition, mime: headers["content-type"] || "application/octet-stream", bytes: buffer.slice(headerEnd + 4, bodyEnd) });
    cursor = next;
  }
  return parts.filter((part) => part.filename || part.name === "photo" || part.name === "photos");
}

function extensionFor(mime, filename = "") {
  const fromName = path.extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, "");
  if ([".jpg", ".jpeg", ".png", ".webp", ".heic"].includes(fromName)) return fromName;
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic" })[mime] || ".bin";
}

export class PhotoStore {
  constructor({ directory } = {}) {
    this.directory = directory;
    this.photoDirectory = path.join(directory, "photos");
    this.metadataPath = path.join(directory, "photos.json");
    this.photos = [];
    this.sequence = 0;
  }

  async init() {
    await fs.mkdir(this.photoDirectory, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(this.metadataPath, "utf8"));
      if (Array.isArray(saved)) this.photos = saved.filter((photo) => photo && photo.file);
      this.sequence = this.photos.length;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  publicPhoto(photo) {
    const { absolutePath, file, ...publicValue } = photo;
    return publicValue;
  }

  async save(bytes, { filename = "photo", mime = "application/octet-stream" } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw Object.assign(new Error("photo upload is empty"), { statusCode: 400 });
    if (bytes.length > MAX_PHOTO_BYTES) throw Object.assign(new Error("each photo must be 12 MiB or smaller"), { statusCode: 413 });
    const id = `photo-${String(++this.sequence).padStart(2, "0")}`;
    const file = `${id}${extensionFor(mime, filename)}`;
    const absolutePath = path.join(this.photoDirectory, file);
    await fs.writeFile(absolutePath, bytes, { flag: "wx" });
    const photo = { id, file, absolutePath, filename: path.basename(filename || file), mime, bytes: bytes.length, uploadedAt: new Date().toISOString() };
    this.photos.push(photo);
    await fs.writeFile(this.metadataPath, JSON.stringify(this.photos.map((value) => ({ ...value })), null, 2));
    return photo;
  }

  list() { return this.photos.map((photo) => this.publicPhoto(photo)); }
  async read(photo) { return fs.readFile(photo.absolutePath); }
}

function commandType(body) { return typeof body === "string" ? body : body?.type || body?.action; }

export function browserDocument() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HTN26 server simulator</title></head>
<body>
<h1>HTN26 server simulator</h1>
<section aria-labelledby="orders-heading">
  <h2 id="orders-heading">Orders / new orders</h2>
  <p id="orders-empty">No active orders. Start a round.</p>
  <ol id="orders"></ol>
</section>
<hr>
<main>
  <section aria-labelledby="round-heading">
    <h2 id="round-heading">Round and timer</h2>
    <p id="round">Loading authoritative state...</p>
    <p id="status"></p>
  </section>
  <section aria-labelledby="serial-heading">
    <h2 id="serial-heading">Development serial injection</h2>
    <form id="serial-form">
      <label for="serial-line">Canonical serial line</label>
      <input id="serial-line" name="line" size="64" value="HTN26|1|HOST|START|240|3">
      <button type="submit">Send</button>
    </form>
    <button type="button" data-line="HTN26|1|HOST|START|240|3">Start simulated round (development only)</button>
    <button type="button" data-line="HTN26|1|HOST|END">End round</button>
    <button type="button" data-line="HTN26|1|HOST|RESET">Reset round</button>
    <pre id="serial-result" aria-live="polite"></pre>
  </section>
  <section aria-labelledby="locations-heading">
    <h2 id="locations-heading">Players by inferred station</h2>
    <p>Each player appears only below their temporary server-inferred action location, not a camera-tracked location.</p>
    <h3>Pantry</h3><ul id="location-pantry"></ul>
    <h3>Fridge</h3><ul id="location-fridge"></ul>
    <h3>Cutting Board</h3><ul id="location-cutting-board"></ul>
    <h3>Stove 1</h3><ul id="location-stove-left"></ul>
    <h3>Stove 2</h3><ul id="location-stove-right"></ul>
    <h3>Serving</h3><ul id="location-serving"></ul>
    <h3>Center / default</h3><ul id="location-center"></ul>
  </section>
  <section aria-labelledby="stations-heading"><h2 id="stations-heading">Stations and cooking</h2><ul id="stations"></ul></section>
  <section aria-labelledby="submissions-heading"><h2 id="submissions-heading">Submissions</h2><ol id="submissions"></ol></section>
  <section aria-labelledby="history-heading"><h2 id="history-heading">Recent event history</h2><ol id="history"></ol></section>
</main>
<hr>
<section aria-labelledby="money-heading">
  <h2 id="money-heading">Money</h2>
  <p id="money">Gold: 0 | Tips: 0 | Penalties: 0 | Net money: 0</p>
</section>
<p>This page renders server snapshots only. It does not calculate timers, patience, station state, validation, or money.</p>
<script>
const element = id => document.getElementById(id);
const list = (id, rows) => {
  const target = element(id);
  target.replaceChildren(...rows.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
};
const render = state => {
  const active = state.activeOrders || [];
  element('orders-empty').hidden = active.length > 0;
  list('orders', active.map(order => order.recipeName + ' [' + order.components.join(', ') + '] - ' + order.remainingSeconds + 's - patience ' + order.patience.filledSegments + '/3'));
  element('round').textContent = 'Round: ' + state.timer.status + ' | ' + state.timer.remainingSeconds + '/' + state.timer.totalSeconds + ' seconds';
  element('status').textContent = state.setup.message;
  for (const stationId of ['pantry', 'fridge', 'cutting-board', 'stove-left', 'stove-right', 'serving', 'center']) {
    const players = state.players.filter(player => (player.simulatedLocation?.stationId || 'center') === stationId);
    list('location-' + stationId, players.length ? players.map(player => {
      const held = player.hasPlate ? 'PLATE [' + (player.plate.join(', ') || 'empty') + ']' : player.heldItem;
      const action = player.processing?.type === 'chop' ? 'CHOPPING' : 'NOT CHOPPING / ' + String(player.actionState || 'idle').toUpperCase();
      return player.name + ': held=' + held + ', action=' + action;
    }) : ['(no players)']);
  }
  list('stations', state.stations.map(station => station.label + ': ' + station.status + ', item=' + (station.item || 'empty') + ', progress=' + Math.round(station.progress * 100) + '%, remaining=' + station.remainingSeconds + 's'));
  list('submissions', (state.submissions || []).slice(-10).reverse().map(value => value.status + ': ' + value.message + ' (gold ' + value.gold + ', tip ' + value.tip + ', penalty ' + value.penalty + ')'));
  list('history', (state.eventHistory || []).slice(-20).reverse().map(value => value.at + ' - ' + value.message));
  element('money').textContent = 'Gold: ' + state.money.gold + ' | Tips: ' + state.money.tips + ' | Penalties: ' + state.money.penalties + ' | Net money: ' + state.money.net;
};
const serial = line => fetch('/api/serial', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line }) }).then(async response => {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
  return body;
});
window.htn26Serial = serial;
element('serial-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { const result = await serial(element('serial-line').value); element('serial-result').textContent = JSON.stringify(result.result, null, 2); render(result.state); }
  catch (error) { element('serial-result').textContent = error.message; }
});
for (const button of document.querySelectorAll('button[data-line]')) button.addEventListener('click', () => {
  element('serial-line').value = button.dataset.line;
  element('serial-form').requestSubmit();
});
fetch('/api/state').then(response => response.json()).then(render).catch(error => { element('status').textContent = error.message; });
const events = new EventSource('/api/events');
events.addEventListener('state', event => render(JSON.parse(event.data)));
events.onerror = () => { element('status').textContent += ' (live event stream reconnecting)'; };
</script>
</body>
</html>`;
}

export function createHttpServer({ projection, photoStore, layoutSubmissionStore, roomLayoutGenerator, bindOrigin = process.env.HTN26_CORS_ORIGIN || "*" } = {}) {
  if (!projection) throw new Error("projection is required");
  if (!photoStore) throw new Error("photoStore is required");
  if (!layoutSubmissionStore) throw new Error("layoutSubmissionStore is required");
  const clients = new Set();
  const unsubscribe = projection.subscribe((state) => {
    const packet = `event: state\ndata: ${json(state)}\n\n`;
    for (const client of clients) {
      try { client.write(packet); } catch { clients.delete(client); }
    }
  });

  async function uploadPhotos(req, res) {
    const body = await readBody(req, MAX_REQUEST_BYTES);
    const type = contentType(req);
    const mime = mediaType(type);
    const uploads = mime === "multipart/form-data"
      ? parseMultipart(body, type)
      : [{ filename: req.headers["x-photo-name"] || "room-photo", mime: mime || "application/octet-stream", bytes: body }];
    if (!uploads.length) throw Object.assign(new Error("no photo parts found"), { statusCode: 400 });
    if (photoStore.photos.length + uploads.length > 4) throw Object.assign(new Error("at most four room photos are supported"), { statusCode: 409 });
    const saved = [];
    for (const upload of uploads) saved.push(await photoStore.save(upload.bytes, upload));
    projection.setPhotos(photoStore.photos, Date.now());
    return { photos: photoStore.list(), accepted: saved.map((photo) => photo.id), count: photoStore.photos.length, reviewReady: photoStore.photos.length >= 3 };
  }

  function timingHeader(metrics = {}) {
    const entries = [["preprocess", metrics.preprocessMs], ["openai", metrics.requestMs], ["validation", metrics.validationMs], ["total", metrics.totalMs]]
      .filter(([, value]) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)))
      .map(([name, value]) => `${name};dur=${Number(value).toFixed(1)}`);
    return entries.length ? { "server-timing": entries.join(", "), "x-htn26-layout-metrics": JSON.stringify(metrics) } : {};
  }

  async function generateRoomLayout(req, res, headers) {
    const totalStart = process.hrtime.bigint();
    const preprocessHeader = req.headers["x-htn26-photo-preprocess-ms"];
    const preprocessMs = preprocessHeader !== undefined && String(preprocessHeader).trim() !== "" && Number.isFinite(Number(preprocessHeader))
      ? Math.max(0, Number(preprocessHeader))
      : null;
    const body = await readBody(req, MAX_REQUEST_BYTES);
    const type = contentType(req);
    const mime = mediaType(type);
    const uploads = mime === "multipart/form-data"
      ? parseMultipart(body, type)
      : [{ filename: req.headers["x-photo-name"] || "room-photo", mime: mime || "application/octet-stream", bytes: body }];
    if (uploads.length < 3 || uploads.length > 5) throw Object.assign(new Error("upload 3 to 5 room photos"), { statusCode: 400 });
    const submission = await layoutSubmissionStore.create(uploads, { preprocessMs });
    const auditHeaders = {
      "x-htn26-layout-request-id": submission.requestId,
      "x-htn26-layout-audit-folder": submission.folder,
    };
    try {
      const result = await roomLayoutGenerator?.generate(uploads.map((upload, index) => ({ ...upload, id: submission.photos[index].id })), { preprocessMs });
      if (!result?.layout) throw new Error("no layout returned");
      const completed = await layoutSubmissionStore.finish(submission.requestId, {
        status: "success",
        metrics: result.metrics,
        finalizeMetrics: () => ({ totalMs: (preprocessMs ?? 0) + elapsedMs(totalStart) }),
      });
      projection.proposeRoomLayout(result.layout, Date.now(), { photoCount: submission.photoCount });
      if (process.env.NODE_ENV !== "production") console.debug("[htn26] room layout generation", { requestId: submission.requestId, ...completed.metrics });
      send(res, 200, result.layout, { ...headers, ...auditHeaders, ...timingHeader(completed.metrics) });
    } catch (error) {
      const metrics = {
        preprocessMs,
        ...error?.metrics,
      };
      const completed = await layoutSubmissionStore.finish(submission.requestId, {
        status: "failure",
        metrics,
        finalizeMetrics: () => ({ totalMs: (preprocessMs ?? 0) + elapsedMs(totalStart) }),
      });
      if (process.env.NODE_ENV !== "production") console.debug("[htn26] room layout generation failed", { requestId: submission.requestId, reason: error?.name || "provider", ...completed.metrics });
      send(res, Number(error?.statusCode) || 503, { error: "Room layout generation is unavailable. Try again." }, { ...headers, ...auditHeaders, ...timingHeader(completed.metrics) });
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const headers = corsHeaders(bindOrigin);
    if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      send(res, 200, browserDocument(), { ...headers, "content-type": "text/html; charset=utf-8" });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      send(res, 404, publicError("HTN26 server paths are / and /api/*"), headers);
      return;
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/state") { send(res, 200, projection.snapshot(), headers); return; }
      if (req.method === "GET" && url.pathname === "/api/floorplan") { send(res, 200, projection.snapshot().floorPlan, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/layout") { send(res, 200, projection.snapshot().roomLayout || null, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/layout/submissions") { send(res, 200, { submissions: layoutSubmissionStore.list() }, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/photos") { send(res, 200, { photos: photoStore.list(), count: photoStore.photos.length, reviewReady: photoStore.photos.length >= 3 }, { ...headers, deprecation: "true", link: "</api/layout/generate>; rel=\"successor-version\"" }); return; }
      if (req.method === "GET" && url.pathname === "/api/orders") { const state = projection.snapshot(); send(res, 200, { order: state.order, activeOrders: state.activeOrders, orders: state.orders }, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/gold") { send(res, 200, projection.snapshot().gold, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/tips") { send(res, 200, projection.snapshot().tips, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/money") { send(res, 200, projection.snapshot().money, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/timer") { const state = projection.snapshot(); send(res, 200, state.timer, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/players") { send(res, 200, { players: projection.snapshot().players }, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/stations") { send(res, 200, { stations: projection.snapshot().stations }, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/submissions") { send(res, 200, { submissions: projection.snapshot().submissions }, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/history") { send(res, 200, { events: projection.snapshot().eventHistory }, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/health") { send(res, 200, { ok: true, state: projection.snapshot().health }, headers); return; }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: state\ndata: ${json(projection.snapshot())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/photos") {
        send(res, 201, await uploadPhotos(req, res), { ...headers, deprecation: "true", link: "</api/layout/generate>; rel=\"successor-version\"" }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/layout/generate") {
        await generateRoomLayout(req, res, headers); return;
      }
      if (req.method === "POST" && ["/api/floorplan/review", "/api/floorplan/propose", "/api/floorplan"].includes(url.pathname)) {
        const payload = parseJsonBody(await readBody(req));
        if (!photoStore.photos.length && !payload.allowEmpty) throw Object.assign(new Error("upload room photos before deterministic floorplan review (or use allowEmpty for a local fixture)"), { statusCode: 400 });
        const proposed = await projection.proposeFloorplan({ photos: photoStore.photos, readPhoto: (photo) => photoStore.read(photo), room: payload.room });
        send(res, 200, proposed, headers); return;
      }
      if (req.method === "POST" && url.pathname === "/api/floorplan/approve") {
        const payload = parseJsonBody(await readBody(req));
        send(res, 200, projection.approveFloorplan(payload.approved !== false), headers); return;
      }
      if (req.method === "POST" && url.pathname === "/api/command") {
        const payload = parseJsonBody(await readBody(req));
        const type = commandType(payload);
        if (type === "SCAN_ROOM") {
          const snapshot = await projection.proposeFloorplan({ photos: [] });
          send(res, 200, snapshot, headers); return;
        }
        send(res, 200, projection.command(type, payload), headers); return;
      }
      if (req.method === "POST" && url.pathname === "/api/players/assign") {
        const payload = parseJsonBody(await readBody(req));
        const playerId = payload.playerId || payload.player;
        if (!projection.registerBadge(payload.mac, playerId)) throw Object.assign(new Error("player assignment requires a valid MAC and p1, p2, or p3"), { statusCode: 400 });
        send(res, 200, projection.snapshot(), headers); return;
      }
      if (req.method === "POST" && url.pathname === "/api/serial") {
        const payload = parseJsonBody(await readBody(req));
        if (typeof payload.line !== "string") throw Object.assign(new Error("serial endpoint requires a line"), { statusCode: 400 });
        const result = projection.serialAdapter?.ingest(payload.line) || { error: "serial adapter is not attached" };
        send(res, 200, { result, state: projection.snapshot() }, headers); return;
      }
      send(res, 404, publicError("unknown API route"), headers);
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      send(res, status, publicError(status === 500 ? "server error" : error.message), headers);
    }
  }

  const server = http.createServer((req, res) => { void handle(req, res); });
  server.on("close", () => { unsubscribe(); for (const client of clients) client.end(); clients.clear(); });
  return server;
}

export { MAX_PHOTO_BYTES, parseMultipart, readBody };
