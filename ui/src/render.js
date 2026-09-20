import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App.js";

/**
 * The same React tree is used by the browser and by the contract tests.
 * Keeping this adapter pure makes visual changes testable without a browser.
 */
export function renderApp(state, now = Date.now(), connectionError = "", transportKind) {
  return renderToStaticMarkup(React.createElement(App, { state, now, connectionError, transportKind }));
}
