import { renderApp } from "./render.js";
import { createBrowserTransport } from "./transport.js";

export function createApp({ root, transport, now = () => Date.now() }) {
  if (!root) throw new Error("A root element is required");
  if (!transport) throw new Error("A state transport is required");

  let state;
  let destroyed = false;
  let unsubscribe;
  let connectionError = "";

  const render = (nextState) => {
    if (destroyed) return;
    state = nextState;
    root.innerHTML = renderApp(state, now(), connectionError);
  };

  const onCommand = async (event) => {
    const button = event.target.closest("button[data-command]");
    if (!button || button.disabled) return;
    button.disabled = true;
    connectionError = "";
    try {
      const nextState = await transport.command(button.dataset.command);
      render(nextState);
    } catch (error) {
      connectionError = `COMMAND NOT SENT — ${error.message}`;
      render(state);
    }
  };

  root.addEventListener("click", onCommand);
  const connection = transport.connect(render);
  Promise.resolve(connection).then((cleanup) => {
    unsubscribe = typeof cleanup === "function" ? cleanup : undefined;
  }).catch((error) => {
    connectionError = `MASTER PI UNAVAILABLE — ${error.message}`;
    render(state);
  });

  // The interval only re-evaluates freshness against the last received snapshot.
  // It never changes positions, timers, score, or any other authoritative value.
  const freshnessTimer = setInterval(() => {
    if (state) render(state);
  }, 1_000);

  return {
    getState: () => state,
    destroy() {
      destroyed = true;
      clearInterval(freshnessTimer);
      unsubscribe?.();
      root.removeEventListener("click", onCommand);
      transport.close?.();
    },
  };
}

if (typeof document !== "undefined") {
  const root = document.querySelector("#app");
  createApp({ root, transport: createBrowserTransport() });
}
