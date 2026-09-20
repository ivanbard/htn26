import { createMockTransport } from "./mock-transport.js";
import { createActionTracker } from "./action-tracker.js";
import { normalizeServerSnapshot } from "./server-snapshot.js";

/**
 * The browser only talks to this small transport interface. The master Pi can
 * replace the HTTP implementation with its local WebSocket/SSE adapter
 * without changing rendering code.
 */
function apiUrl(baseUrl, path) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${path}`;
}

export function createHttpTransport({ baseUrl = "", fetchImpl = globalThis.fetch, eventSourceFactory = globalThis.EventSource, normalizeSnapshot: normalizeBase = normalizeServerSnapshot, pollIntervalMs = 1_000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("The local HTTP transport requires fetch");

  // Every snapshot from the server goes through the same adapter, then the
  // action tracker adds what the server does not send (see action-tracker.js).
  const tracker = createActionTracker();
  const normalizeSnapshot = (raw) => {
    const snapshot = normalizeBase(raw);
    return snapshot && Array.isArray(snapshot.players) ? { ...snapshot, players: tracker.annotate(snapshot.players) } : snapshot;
  };

  let source;
  let poll;
  let pollInFlight = false;
  let latestRevision = Number.NEGATIVE_INFINITY;
  return {
    kind: "http",
    async connect(listener) {
      const response = await fetchImpl(apiUrl(baseUrl, "/api/state"), { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Master Pi state request failed (${response.status})`);
      const deliver = (raw) => {
        const snapshot = normalizeSnapshot(raw);
        const revision = Number(snapshot?.revision);
        // SSE and polling can cross in flight. The server revision makes the
        // complete snapshot ordering explicit, so a delayed poll can never
        // roll the laptop back to the initial zero-photo state.
        if (Number.isFinite(revision) && revision < latestRevision) return;
        if (Number.isFinite(revision)) latestRevision = revision;
        listener(snapshot);
      };
      const refresh = async () => {
        if (pollInFlight) return;
        pollInFlight = true;
        try {
          const next = await fetchImpl(apiUrl(baseUrl, "/api/state"), { headers: { accept: "application/json" } });
          if (next.ok) deliver(await next.json());
        } catch {
          // EventSource retries by itself; polling is only a best-effort
          // recovery path when the shared HTTP endpoint is temporarily down.
        } finally {
          pollInFlight = false;
        }
      };
      deliver(await response.json());

      if (typeof eventSourceFactory === "function") {
        source = new eventSourceFactory(apiUrl(baseUrl, "/api/events"));
        const onState = (event) => deliver(JSON.parse(event.data));
        if (typeof source.addEventListener === "function") source.addEventListener("state", onState);
        else source.onmessage = onState;
      }
      // Keep a small HTTP safety net even when EventSource is available. A
      // reverse proxy can accept SSE while buffering its frames, which would
      // otherwise leave this tab stuck on its initial snapshot forever.
      poll = setInterval(refresh, Math.max(1, Number(pollIntervalMs) || 1_000));

      return () => {
        source?.close();
        if (poll) clearInterval(poll);
      };
    },
    async command(command) {
      const response = await fetchImpl(apiUrl(baseUrl, "/api/command"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) throw new Error(`Master Pi command failed (${response.status})`);
      return normalizeSnapshot(await response.json());
    },
    async uploadPhotos(files) {
      const selected = Array.from(files || []);
      if (!selected.length) throw new Error("Select at least one room photo before uploading");
      const body = new FormData();
      selected.forEach((file) => body.append("photos", file, file.name));
      const response = await fetchImpl(apiUrl(baseUrl, "/api/photos"), { method: "POST", body, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Master Pi photo upload failed (${response.status})`);
      return response.json();
    },
    async generateRoomLayout() {
      const generated = await fetchImpl(apiUrl(baseUrl, "/api/layout/generate"), {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!generated.ok) throw new Error(`Room layout generation failed (${generated.status})`);
      return generated.json();
    },
    async useDefaultLayout() {
      const proposed = await fetchImpl(apiUrl(baseUrl, "/api/floorplan/review"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ allowEmpty: true }),
      });
      if (!proposed.ok) throw new Error(`Default room layout failed (${proposed.status})`);
      await proposed.json();
      const approved = await fetchImpl(apiUrl(baseUrl, "/api/floorplan/approve"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      if (!approved.ok) throw new Error(`Default room layout activation failed (${approved.status})`);
      return normalizeSnapshot(await approved.json());
    },
  };
}

export function createBrowserTransport({
  search = globalThis.location?.search || "",
  injected = globalThis.__HTN26_TRANSPORT__,
  fetchImpl = globalThis.fetch,
  eventSourceFactory = globalThis.EventSource,
} = {}) {
  if (injected) return injected;
  const params = new URLSearchParams(search);
  const mode = params.get("transport");
  const baseUrl = params.get("api") || params.get("apiBase") || globalThis.__HTN26_API_BASE__ || "";
  return mode === "mock" ? createMockTransport() : createHttpTransport({ baseUrl, fetchImpl, eventSourceFactory });
}
