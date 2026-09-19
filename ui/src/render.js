import {
  canRunAction,
  formatSeconds,
  healthStatus,
  isStale,
  playerPosition,
  progressPercent,
  trackingCoverage,
  GAME_ACTIONS,
  SETUP_PHASES,
} from "./state.js";

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const escapeAttr = escapeHtml;
const upper = (value) => String(value || "").replaceAll("-", " ").toUpperCase();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, finite(value, min)));

function phaseLabel(phase) {
  if (phase === SETUP_PHASES.LAYOUT_PROPOSED) return "LAYOUT PROPOSED";
  if (phase === SETUP_PHASES.LAYOUT_ACCEPTED) return "LAYOUT ACCEPTED";
  if (phase === SETUP_PHASES.RUNNING) return "GAME RUNNING";
  if (phase === SETUP_PHASES.ENDED) return "GAME ENDED";
  if (phase === SETUP_PHASES.SCANNING) return "SCANNING ROOM";
  return "READY TO SCAN";
}

function statusPill(status, label = status) {
  const normalized = String(status || "unknown").toLowerCase();
  return `<span class="status-pill status-${escapeAttr(normalized)}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(upper(label))}</span>`;
}

function commandButton(state, action, label) {
  const disabled = !canRunAction(state, action) ? " disabled" : "";
  return `<button class="control-button" type="button" data-command="${escapeAttr(action)}"${disabled}>${escapeHtml(label)}</button>`;
}

function renderHostPanel(state) {
  const setup = state.setup || {};
  const phase = setup.phase || SETUP_PHASES.IDLE;
  return `
    <section class="host-panel panel" aria-labelledby="host-title">
      <div class="host-copy">
        <p class="eyebrow">HOST SETUP</p>
        <h2 id="host-title">${escapeHtml(phaseLabel(phase))}</h2>
        <p class="muted">${escapeHtml(setup.message || "The master Pi controls setup and game state.")}</p>
      </div>
      <div class="setup-controls" aria-label="Host controls">
        ${commandButton(state, GAME_ACTIONS.SCAN_ROOM, "Scan Room")}
        ${commandButton(state, GAME_ACTIONS.ACCEPT_LAYOUT, "Accept Layout")}
        ${commandButton(state, GAME_ACTIONS.RESCAN, "Rescan")}
        ${commandButton(state, GAME_ACTIONS.START_GAME, "Start Game")}
        ${commandButton(state, GAME_ACTIONS.END_GAME, "End Game")}
        ${commandButton(state, GAME_ACTIONS.RESET_GAME, "Reset Game")}
      </div>
    </section>`;
}

function mapStyle(item) {
  const left = clamp(item.x, 0, 100);
  const top = clamp(item.y, 0, 100);
  const width = clamp(item.width, 1, 100);
  const height = clamp(item.height, 1, 100);
  return `left:${left}%;top:${top}%;width:${width}%;height:${height}%;`;
}

function renderFloorPlan(state, now) {
  const plan = state.floorPlan || {};
  const accepted = plan.accepted === true;
  const walls = (plan.walls || []).map((wall, index) => `<div class="map-wall" style="${mapStyle(wall)}" aria-hidden="true" data-wall="${index}"></div>`).join("");
  const stations = (plan.stations || []).map((station) => `
    <div class="map-station station-${escapeAttr(station.kind || "generic")}" style="${mapStyle(station)}" data-station="${escapeAttr(station.id)}">
      <strong>${escapeHtml(station.label || station.id)}</strong>
    </div>`).join("");
  const players = (state.players || []).map((player) => {
    const position = playerPosition(player);
    const stale = !position || isStale(player, now);
    const trackingText = !position ? "TRACKING LOST" : stale ? "TRACKING STALE" : upper(player.tracking?.source || "TRACKING");
    const classes = `player-token player-${escapeAttr(player.color || player.id)}${stale ? " is-stale" : ""}`;
    const inventory = player.inventory?.length ? ` — ${player.inventory.join(", ")}` : "";
    const label = `${player.name || player.label || player.id}${!position ? ", tracking lost" : stale ? ", tracking stale" : ", tracking healthy"}${inventory}`;
    const positionStyle = position ? ` style="left:${clamp(position.x)}%;top:${clamp(position.y)}%;"` : "";
    return `
      <div class="${classes}"${positionStyle} data-player="${escapeAttr(player.id)}" data-stale="${stale}" aria-label="${escapeAttr(label)}">
        <span class="player-badge">${escapeHtml(player.label || player.id)}</span>
        <span class="player-name">${escapeHtml(player.name || "PLAYER")}</span>
        <span class="player-tracking">${escapeHtml(trackingText)}</span>
      </div>`;
  }).join("");

  return `
    <section class="map-panel panel" aria-labelledby="map-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">ROOM MIRROR</p>
          <h2 id="map-title">${accepted ? "Accepted floor plan" : "Proposed floor plan"}</h2>
        </div>
        ${statusPill(accepted ? "healthy" : "degraded", accepted ? "authoritative layout" : "awaiting approval")}
      </div>
      <div class="floor-plan ${accepted ? "is-accepted" : "is-proposed"}" role="img" aria-label="${accepted ? "Accepted" : "Proposed"} top-down floor plan with tracked players">
        <div class="map-grid" aria-hidden="true"></div>
        ${walls}
        ${stations}
        ${players}
        ${accepted ? "" : "<div class=\"map-overlay\">ACCEPT LAYOUT BEFORE STARTING</div>"}
      </div>
      <div class="map-legend" aria-label="Floor plan legend">
        <span><i class="legend-dot legend-p1"></i>P1</span>
        <span><i class="legend-dot legend-p2"></i>P2</span>
        <span><i class="legend-dot legend-stale"></i>Tracking stale</span>
      </div>
    </section>`;
}

function renderOrder(state) {
  const order = state.order;
  if (!order) return `<section class="order-panel panel"><p class="muted">No active order from master Pi.</p></section>`;
  const orderStatus = String(order.status || "active");
  const ingredients = (order.ingredients || []).map((ingredient) => `<li>${escapeHtml(ingredient)}</li>`).join("");
  return `
    <section class="order-panel panel" aria-labelledby="order-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">ACTIVE ORDER</p>
          <h2 id="order-title">${escapeHtml(order.dish || "ORDER")}</h2>
        </div>
        ${statusPill(orderStatus === "active" ? "healthy" : orderStatus, orderStatus)}
      </div>
      <div class="order-timer">
        <span class="eyebrow">ORDER TIME REMAINING</span>
        <strong>${escapeHtml(formatSeconds(order.remainingSeconds))}</strong>
      </div>
      <ul class="ingredient-list">${ingredients || "<li>Recipe details from master Pi</li>"}</ul>
    </section>`;
}

function renderScoreAndClock(state) {
  const score = state.score || {};
  const clock = state.clock || {};
  return `
    <section class="score-panel panel" aria-labelledby="score-title">
      <p class="eyebrow">ROUND SCORE</p>
      <h2 id="score-title" class="score-value">${escapeHtml(score.value ?? 0)}</h2>
      <p class="muted">${escapeHtml(score.delivered ?? 0)} dishes delivered</p>
      <div class="round-clock">
        <span class="eyebrow">ROUND CLOCK</span>
        <strong>${escapeHtml(formatSeconds(clock.remainingSeconds))}</strong>
        ${statusPill(clock.status || "unknown", clock.status || "unknown")}
      </div>
    </section>`;
}

function renderStations(state) {
  const stations = state.stations || [];
  return `
    <section class="stations-panel panel" aria-labelledby="stations-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">AUTHORITATIVE STATION STATE</p>
          <h2 id="stations-title">Cooking &amp; stations</h2>
        </div>
      </div>
      <div class="station-list">
        ${stations.length ? stations.map((station) => {
          const progress = progressPercent(station.progress);
          return `<article class="station-card station-${escapeAttr(station.kind || "generic")}">
            <div class="station-title"><h3>${escapeHtml(station.label || station.id)}</h3>${statusPill(station.status || "unknown", station.status || "unknown")}</div>
            <p class="station-item">${escapeHtml(station.item || "EMPTY")}</p>
            <div class="progress-track" role="progressbar" aria-label="${escapeAttr(station.label || station.id)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.toFixed(0)}"><span style="width:${progress.toFixed(2)}%"></span></div>
            <div class="station-meta"><span>${escapeHtml(progress.toFixed(0))}%</span><span>${station.remainingSeconds == null ? "--:--" : `${escapeHtml(formatSeconds(station.remainingSeconds))} remaining`}</span></div>
          </article>`;
        }).join("") : "<p class=\"muted\">No station state received.</p>"}
      </div>
    </section>`;
}

function renderDelivery(state) {
  const event = state.delivery?.lastEvent;
  if (!event) {
    return `<section class="delivery-panel panel" aria-labelledby="delivery-title"><p class="eyebrow">DELIVERY GATE</p><h2 id="delivery-title">Awaiting plate submission</h2><p class="muted">The gateway badge validates the plate; this screen only mirrors its result.</p></section>`;
  }
  const success = event.status === "success";
  return `<section class="delivery-panel panel delivery-${success ? "success" : "failure"}" aria-labelledby="delivery-title" role="status">
    <p class="eyebrow">LATEST DELIVERY RESULT</p>
    <h2 id="delivery-title">${escapeHtml(event.message || (success ? "ORDER COMPLETE" : "WRONG ORDER"))}</h2>
    <p>${escapeHtml(event.detail || "")}</p>
    <strong class="delivery-points">${success ? `+${escapeHtml(event.points ?? 0)}` : "NO SCORE"}</strong>
  </section>`;
}

function renderHealthItem(item, now) {
  const status = healthStatus(item, now);
  return `<li class="health-item health-${escapeAttr(status)}">
    <span class="health-indicator" aria-hidden="true"></span>
    <span><strong>${escapeHtml(item.label || item.id || "SYSTEM")}</strong><small>${escapeHtml(item.detail || "")}</small></span>
    <span class="health-label">${escapeHtml(upper(status))}</span>
  </li>`;
}

function renderHealth(state, now) {
  const health = state.health || {};
  const workers = health.workers || health.cameras || [];
  const coverage = trackingCoverage(state, now);
  return `<section class="health-panel panel" aria-labelledby="health-title">
    <div class="section-heading">
      <div><p class="eyebrow">LOCAL SYSTEM HEALTH</p><h2 id="health-title">Gateway &amp; camera health</h2></div>
      ${statusPill(coverage, `tracking ${coverage}`)}
    </div>
    <ul class="health-list">
      ${health.gateway ? renderHealthItem(health.gateway, now) : ""}
      ${workers.map((worker) => renderHealthItem(worker, now)).join("")}
      ${health.inference ? renderHealthItem(health.inference, now) : ""}
    </ul>
    <p class="health-callout ${coverage === "degraded" ? "is-degraded" : ""}">${coverage === "degraded" ? "TRACKING DEGRADED — stale worker data is marked; the game is continuing." : "TRACKING COVERAGE HEALTHY"}</p>
  </section>`;
}

export function renderApp(state, now = Date.now(), connectionError = "") {
  if (!state) {
    return `<section class="loading-card"><p class="eyebrow">HTN26 / OVERCOOKED IRL</p><h1>Waiting for authoritative state…</h1><p class="muted">No game state has been received from the local transport.</p>${connectionError ? `<div id="ui-error" class="ui-error" role="alert">${escapeHtml(connectionError)}</div>` : ""}</section>`;
  }
  return `<div class="app-shell">
    <header class="topbar">
      <div><p class="eyebrow">HTN26 / OVERCOOKED IRL</p><h1>Kitchen Control</h1></div>
      <div class="connection-summary" role="status"><span class="connection-light"></span><span>LOCAL MASTER PI</span><small>${escapeHtml(state.source || "authoritative state")}</small></div>
    </header>
    ${connectionError ? `<div id="ui-error" class="ui-error" role="alert">${escapeHtml(connectionError)}</div>` : ""}
    ${renderHostPanel(state)}
    <div class="primary-grid">
      ${renderFloorPlan(state, now)}
      <div class="side-stack">${renderOrder(state)}${renderScoreAndClock(state)}</div>
    </div>
    <div class="secondary-grid">${renderStations(state)}${renderDelivery(state)}</div>
    ${renderHealth(state, now)}
    <footer class="footer-note">Every position, timer, order, score, and health value above is read from the master Pi transport. The UI does not simulate gameplay.</footer>
  </div>`;
}
