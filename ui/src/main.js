import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { renderApp } from "./render.js";
import { createBrowserTransport } from "./transport.js";
import { PhotosPage } from "./PhotosPage.js";

const SERVER_UNAVAILABLE = "GAME SERVER UNAVAILABLE";
const CONNECT_RETRY_MS = 3_000;
const LOST_CONNECTION = `${SERVER_UNAVAILABLE} — lost the connection; showing the last state we had. Reconnecting…`;
// Notices about something the user just tried. They belong to the screen they
// happened on, so they are cleared once the game moves to another phase.
const ACTION_ERROR = /^(COMMAND NOT SENT|ROOM LAYOUT FAILED|PHOTO UPLOAD FAILED)/;

// Whatever went wrong with a layout choice, say the way forward (unless the
// server's own message already does).
export function layoutFailureMessage(error, failureHint = "") {
  const hint = failureHint && !/normal room layout/i.test(error?.message || "") ? ` ${failureHint}` : "";
  return `ROOM LAYOUT FAILED — ${error?.message || "unknown error"}${hint}`;
}

export function describeConnectionFailure(error) {
  const status = Number(error?.status);
  const unreachable = error instanceof TypeError || (status >= 500 && status <= 504);
  return unreachable
    ? `${SERVER_UNAVAILABLE} — can't reach it${status ? ` (${status})` : ""}. Start it with "node server/server.mjs --serial DEVICE"; retrying every ${CONNECT_RETRY_MS / 1000} s…`
    : `${SERVER_UNAVAILABLE} — ${error?.message || "unknown error"}. Retrying every ${CONNECT_RETRY_MS / 1000} s…`;
}

export function createApp({ root, transport, now = () => Date.now() }) {
  if (!root) throw new Error("A root element is required");
  if (!transport) throw new Error("A state transport is required");

  let state;
  let destroyed = false;
  let unsubscribe;
  let connectionError = "";
  let uploadStatus = "";
  let lastPhase;
  let layoutBusy = false;
  const reactRoot = typeof root.nodeType === "number" ? createRoot(root) : null;

  const render = (nextState) => {
    if (destroyed) return;
    const phase = nextState?.setup?.phase;
    if (lastPhase !== undefined && phase !== lastPhase && ACTION_ERROR.test(connectionError)) connectionError = "";
    lastPhase = phase;
    state = nextState;
    const props = {
      state,
      now: now(),
      connectionError,
      uploadStatus,
      transportKind: transport.kind,
      onCommand,
      onGenerateLayout,
      onUseDefaultLayout,
      onUploadPhotos,
      onRetryConnect,
      onDismissError,
    };
    if (reactRoot) reactRoot.render(React.createElement(App, props));
    else root.innerHTML = renderApp(state, props.now, connectionError);
  };

  // Failures that arrive after the game has already moved on are moot (a double
  // click, or the server got there first), so they are not reported.
  const movedOn = (before) => before?.setup?.phase !== state?.setup?.phase;

  const onCommand = async (command) => {
    connectionError = "";
    const stateAtCommandStart = state;
    try {
      const nextState = await transport.command(command);
      if (state !== stateAtCommandStart) return;
      render(nextState || state);
    } catch (error) {
      if (movedOn(stateAtCommandStart)) return;
      connectionError = `COMMAND NOT SENT — ${error.message}`;
      render(state);
    }
  };

  const onDismissError = () => {
    connectionError = "";
    render(state);
  };

  const onUploadPhotos = async (files) => {
    if (typeof transport.uploadPhotos !== "function") return;
    connectionError = "";
    uploadStatus = "Uploading room photos to the game server…";
    render(state);
    try {
      const result = await transport.uploadPhotos(files);
      uploadStatus = `${result.count || 0} room photos on the game server${result.reviewReady ? " — ready to scan" : " — waiting for more photos"}.`;
    } catch (error) {
      uploadStatus = "";
      connectionError = `PHOTO UPLOAD FAILED — ${error.message}`;
    }
    render(state);
  };

  const runLayoutChoice = async (operation, progressMessage, successMessage, failureHint = "") => {
    if (typeof operation !== "function") return onCommand("SCAN_ROOM");
    if (layoutBusy) return undefined; // a second click while one is running would only fight it
    layoutBusy = true;
    connectionError = "";
    uploadStatus = progressMessage;
    render(state);
    const stateAtCommandStart = state;
    try {
      const nextState = await operation();
      uploadStatus = successMessage;
      // HTTP layout generation publishes the authoritative proposal over SSE;
      // its POST response is the sanitized layout document, not a full state.
      if (state === stateAtCommandStart && nextState?.setup) render(nextState);
      else render(state);
    } catch (error) {
      uploadStatus = "";
      if (!movedOn(stateAtCommandStart)) {
        connectionError = layoutFailureMessage(error, failureHint);
        render(state);
      }
    } finally {
      layoutBusy = false;
    }
    return undefined;
  };

  const onGenerateLayout = () => runLayoutChoice(
    transport.generateRoomLayout?.bind(transport),
    "Mapping the uploaded room photos…",
    "Personalized room layout ready.",
    "You can still continue with the Normal Room Layout.",
  );

  const onUseDefaultLayout = () => runLayoutChoice(
    transport.useDefaultLayout?.bind(transport),
    "Loading the normal room layout…",
    "Normal room layout ready.",
  );

  const onFallbackClick = async (event) => {
    const button = event.target.closest("button[data-command]");
    if (!button || button.disabled) return;
    button.disabled = true;
    await onCommand(button.dataset.command);
  };
  if (!reactRoot) root.addEventListener("click", onFallbackClick);

  // Keep trying until the server answers, so starting it after the page is open
  // just works (no reload). A dead server behind the dev proxy shows up as a 5xx
  // or a failed fetch, so those get the "is it running?" hint.
  let retryTimer;
  // A working connection that later drops is announced, and cleared when it is back.
  const connectionHooks = {
    onConnectionLost() {
      if (destroyed) return;
      connectionError = LOST_CONNECTION;
      render(state);
    },
    onConnectionRestored() {
      if (destroyed) return;
      if (connectionError.startsWith(SERVER_UNAVAILABLE)) {
        connectionError = "";
        render(state);
      }
    },
  };
  const connectToServer = () => {
    let connection;
    try {
      connection = transport.connect(render, connectionHooks);
    } catch (error) {
      connection = Promise.reject(error);
    }
    Promise.resolve(connection)
      .then((cleanup) => {
        const resolvedCleanup = typeof cleanup === "function" ? cleanup : undefined;
        if (destroyed) {
          resolvedCleanup?.();
          return;
        }
        unsubscribe = resolvedCleanup;
        if (connectionError.startsWith(SERVER_UNAVAILABLE)) {
          connectionError = "";
          render(state);
        }
      })
      .catch((error) => {
        if (destroyed) return;
        connectionError = describeConnectionFailure(error);
        render(state);
        retryTimer = setTimeout(connectToServer, CONNECT_RETRY_MS);
      });
  };
  connectToServer();

  // "Try again now" on the waiting screen: skip the wait, unless already connected.
  function onRetryConnect() {
    if (state || destroyed) return;
    clearTimeout(retryTimer);
    connectToServer();
  }

  const freshnessTimer = setInterval(() => {
    if (state) render(state);
  }, 1_000);

  return {
    getState: () => state,
    getConnectionError: () => connectionError,
    // The handlers the screens are given, exposed so they can be exercised directly.
    actions: { onCommand, onGenerateLayout, onUseDefaultLayout, onUploadPhotos, onDismissError, onRetryConnect },
    destroy() {
      destroyed = true;
      clearInterval(freshnessTimer);
      clearTimeout(retryTimer);
      unsubscribe?.();
      if (!reactRoot) root.removeEventListener("click", onFallbackClick);
      reactRoot?.unmount();
      transport.close?.();
    },
  };
}

export function isPhotosPath(pathname = "") {
  return String(pathname).replace(/\/+$/, "") === "/photos";
}

if (typeof document !== "undefined") {
  const root = document.querySelector("#app");
  if (isPhotosPath(globalThis.location?.pathname)) {
    document.title = "Room photos";
    createRoot(root).render(React.createElement(PhotosPage));
  } else {
    createApp({ root, transport: createBrowserTransport() });
  }
}
