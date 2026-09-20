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

// How long to wait before reopening a dead event stream, and how often to check
// the server is still answering while the stream is quiet.
export const STREAM_REOPEN_MS = 3_000;
export const HEARTBEAT_MS = 5_000;

// The server has no RESCAN command; going back to scanning is START_HOST.
function serverCommand(command) {
  const type = typeof command === "string" ? command : command?.type;
  if (type !== "RESCAN") return command;
  return typeof command === "string" ? "START_HOST" : { ...command, type: "START_HOST" };
}

// Say why, when the server says why. It answers 4xx with a safe message and 500
// with a generic one that adds nothing.
async function failureMessage(label, response) {
  let detail = "";
  try {
    const body = await response.json();
    if (body && typeof body.error === "string" && body.error !== "server error") detail = `: ${body.error}`;
  } catch {
    detail = "";
  }
  return `${label} (${response.status})${detail}`;
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
  return {
    kind: "http",
    async connect(listener, hooks = {}) {
      const response = await fetchImpl(apiUrl(baseUrl, "/api/state"), { headers: { accept: "application/json" } });
      if (!response.ok) throw Object.assign(new Error(`Game server state request failed (${response.status})`), { status: response.status });
      const initial = await response.json();
      let lastRevision = Number.isFinite(Number(initial?.revision)) ? Number(initial.revision) : null;
      let lost = false;
      let forceNext = false;
      let stopped = false;
      let reopenTimer;

      const markLost = () => {
        if (lost || stopped) return;
        lost = true;
        forceNext = true; // a restarted server may count revisions from zero again
        hooks.onConnectionLost?.();
      };
      const markRestored = () => {
        if (!lost || stopped) return;
        lost = false;
        hooks.onConnectionRestored?.();
      };
      // A slow heartbeat reply must not overwrite a newer stream event, so a snapshot
      // that is older than what is already showing is dropped (equal ones are harmless).
      const apply = (raw) => {
        if (stopped) return;
        const revision = Number(raw?.revision);
        const known = Number.isFinite(revision);
        if (!forceNext && known && lastRevision != null && revision < lastRevision) return;
        forceNext = false;
        if (known) lastRevision = revision;
        listener(normalizeSnapshot(raw));
      };

      apply(initial);

      const checkServer = async () => {
        if (stopped || pollInFlight) return;
        pollInFlight = true;
        try {
          const next = await fetchImpl(apiUrl(baseUrl, "/api/state"), { headers: { accept: "application/json" } });
          if (!next.ok) throw new Error(String(next.status));
          const raw = await next.json();
          if (lost) forceNext = true;
          apply(raw);
          markRestored();
        } catch {
          markLost();
        } finally {
          pollInFlight = false;
        }
      };

      if (typeof eventSourceFactory === "function") {
        const open = () => {
          source?.close();
          source = new eventSourceFactory(apiUrl(baseUrl, "/api/events"));
          const onState = (event) => { markRestored(); apply(JSON.parse(event.data)); };
          const onError = () => {
            // A broken stream alone is not "the server is gone": ask it directly.
            checkServer();
            // The browser retries a dropped stream itself, but gives up for good on
            // an error response (a dead proxy, a server that answered 500).
            if (source?.readyState === 2 && !stopped) {
              clearTimeout(reopenTimer);
              reopenTimer = setTimeout(open, STREAM_REOPEN_MS);
              reopenTimer.unref?.();
            }
          };
          if (typeof source.addEventListener === "function") {
            source.addEventListener("state", onState);
            source.addEventListener("error", onError);
          } else {
            source.onmessage = onState;
            source.onerror = onError;
          }
        };
        open();
      }
      // The stream is silent while nothing changes, so a quiet stream proves nothing.
      // Ask the server directly now and then: it notices a dead server, and it picks
      // up anything the stream missed. Without an event stream this poll is the only
      // source of updates, so the default is one second.
      poll = setInterval(checkServer, Math.max(1, Number(pollIntervalMs) || 1_000));

      return () => {
        stopped = true;
        clearTimeout(reopenTimer);
        clearInterval(poll);
        source?.close();
      };
    },
    async command(command) {
      const response = await fetchImpl(apiUrl(baseUrl, "/api/command"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(serverCommand(command)),
      });
      if (!response.ok) throw new Error(await failureMessage("Game server command failed", response));
      return normalizeSnapshot(await response.json());
    },
    async uploadPhotos(files) {
      const selected = Array.from(files || []);
      if (!selected.length) throw new Error("Select at least one room photo before uploading");
      const body = new FormData();
      selected.forEach((file) => body.append("photos", file, file.name));
      const response = await fetchImpl(apiUrl(baseUrl, "/api/photos"), { method: "POST", body, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(await failureMessage("Game server photo upload failed", response));
      return response.json();
    },
    async generateRoomLayout() {
      const generated = await fetchImpl(apiUrl(baseUrl, "/api/layout/generate"), {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!generated.ok) throw new Error(await failureMessage("Room layout generation failed", generated));
      return generated.json();
    },
    async useDefaultLayout() {
      const proposed = await fetchImpl(apiUrl(baseUrl, "/api/floorplan/review"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ allowEmpty: true }),
      });
      if (!proposed.ok) throw new Error(await failureMessage("Default room layout failed", proposed));
      await proposed.json();
      const approved = await fetchImpl(apiUrl(baseUrl, "/api/floorplan/approve"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      if (!approved.ok) throw new Error(await failureMessage("Default room layout activation failed", approved));
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
