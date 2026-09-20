import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { renderApp } from "./render.js";
import { createBrowserTransport } from "./transport.js";

export function createApp({ root, transport, now = () => Date.now() }) {
  if (!root) throw new Error("A root element is required");
  if (!transport) throw new Error("A state transport is required");

  let state;
  let destroyed = false;
  let unsubscribe;
  let connectionError = "";
  const reactRoot = typeof root.nodeType === "number" ? createRoot(root) : null;

  const render = (nextState) => {
    if (destroyed) return;
    state = nextState;
    const props = {
      state,
      now: now(),
      connectionError,
      onCommand,
      onGenerateLayout: typeof transport.generateLayout === "function" ? onGenerateLayout : undefined,
    };
    if (reactRoot) reactRoot.render(React.createElement(App, props));
    else root.innerHTML = renderApp(state, props.now, connectionError, props);
  };

  const onCommand = async (command) => {
    connectionError = "";
    const stateAtCommandStart = state;
    try {
      const nextState = await transport.command(command);
      if (state !== stateAtCommandStart) return;
      render(nextState);
    } catch (error) {
      connectionError = `COMMAND NOT SENT — ${error.message}`;
      render(state);
    }
  };

  const onGenerateLayout = async (files) => {
    connectionError = "";
    const stateAtCommandStart = state;
    try {
      const nextState = await transport.generateLayout(files);
      if (state !== stateAtCommandStart) return;
      render(nextState);
    } catch (error) {
      connectionError = "ROOM LAYOUT UNAVAILABLE — Try again with 3-5 classroom photos.";
      render(state);
    }
  };

  const onFallbackClick = async (event) => {
    const button = event.target.closest("button[data-command]");
    if (!button || button.disabled) return;
    button.disabled = true;
    await onCommand(button.dataset.command);
  };
  if (!reactRoot) root.addEventListener("click", onFallbackClick);

  const connection = transport.connect(render);
  Promise.resolve(connection).then((cleanup) => {
    const resolvedCleanup = typeof cleanup === "function" ? cleanup : undefined;
    if (destroyed) {
      resolvedCleanup?.();
      return;
    }
    unsubscribe = resolvedCleanup;
  }).catch((error) => {
    connectionError = `MASTER PI UNAVAILABLE — ${error.message}`;
    render(state);
  });

  const freshnessTimer = setInterval(() => {
    if (state) render(state);
  }, 1_000);

  return {
    getState: () => state,
    destroy() {
      destroyed = true;
      clearInterval(freshnessTimer);
      unsubscribe?.();
      if (!reactRoot) root.removeEventListener("click", onFallbackClick);
      reactRoot?.unmount();
      transport.close?.();
    },
  };
}

if (typeof document !== "undefined") {
  const root = document.querySelector("#app");
  createApp({ root, transport: createBrowserTransport() });
}
