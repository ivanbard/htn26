import { createMockTransport } from "./mock-transport.js";
import { normalizeServerSnapshot } from "./server-snapshot.js";

/**
 * The browser only talks to this small transport interface. The master Pi can
 * replace the HTTP implementation with its local WebSocket/SSE adapter
 * without changing rendering code.
 */
function apiUrl(baseUrl, path) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${path}`;
}

export function createHttpTransport({ baseUrl = "", fetchImpl = globalThis.fetch, eventSourceFactory = globalThis.EventSource, normalizeSnapshot = normalizeServerSnapshot } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("The local HTTP transport requires fetch");

  let source;
  let poll;
  return {
    kind: "http",
    async connect(listener) {
      const response = await fetchImpl(apiUrl(baseUrl, "/api/state"), { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Master Pi state request failed (${response.status})`);
      listener(normalizeSnapshot(await response.json()));

      if (typeof eventSourceFactory === "function") {
        source = new eventSourceFactory(apiUrl(baseUrl, "/api/events"));
        const onState = (event) => listener(normalizeSnapshot(JSON.parse(event.data)));
        if (typeof source.addEventListener === "function") source.addEventListener("state", onState);
        else source.onmessage = onState;
      } else {
        // Polling is only a local fallback for a master implementation without SSE.
        poll = setInterval(async () => {
          const next = await fetchImpl(apiUrl(baseUrl, "/api/state"), { headers: { accept: "application/json" } });
          if (next.ok) listener(normalizeSnapshot(await next.json()));
        }, 1_000);
      }

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
  return mode === "http" ? createHttpTransport({ baseUrl, fetchImpl, eventSourceFactory }) : createMockTransport();
}
