import { createMockTransport } from "./mock-transport.js";

/**
 * The browser only talks to this small transport interface. The master Pi can
 * replace the HTTP implementation with its local WebSocket/SSE adapter
 * without changing rendering code.
 */
export function createHttpTransport({ baseUrl = "", fetchImpl = globalThis.fetch, eventSourceFactory = globalThis.EventSource } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("The local HTTP transport requires fetch");

  let source;
  let poll;
  return {
    kind: "http",
    async connect(listener) {
      const response = await fetchImpl(`${baseUrl}/api/state`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Master Pi state request failed (${response.status})`);
      listener(await response.json());

      if (typeof eventSourceFactory === "function") {
        source = new eventSourceFactory(`${baseUrl}/api/events`);
        source.onmessage = (event) => listener(JSON.parse(event.data));
      } else {
        // Polling is only a local fallback for a master implementation without SSE.
        poll = setInterval(async () => {
          const next = await fetchImpl(`${baseUrl}/api/state`, { headers: { accept: "application/json" } });
          if (next.ok) listener(await next.json());
        }, 1_000);
      }

      return () => {
        source?.close();
        if (poll) clearInterval(poll);
      };
    },
    async command(command) {
      const response = await fetchImpl(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) throw new Error(`Master Pi command failed (${response.status})`);
      return response.json();
    },
  };
}

export function createBrowserTransport({ search = globalThis.location?.search || "", injected = globalThis.__HTN26_TRANSPORT__ } = {}) {
  if (injected) return injected;
  const mode = new URLSearchParams(search).get("transport");
  return mode === "http" ? createHttpTransport() : createMockTransport();
}
