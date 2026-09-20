/**
 * The UI/Pi adapter boundary. The Pi owns the response snapshot; the UI only
 * sends these requests and renders the latest response/event.
 *
 * @typedef {Object} AdapterCommand
 * @property {string} type
 * @property {Object} [payload]
 *
 * @typedef {Object} Adapter
 * @property {(onState: (state: Object) => void) => (void|(() => void)|Promise<void|(() => void)>)} connect
 * @property {(command: AdapterCommand) => Promise<Object>} command
 * @property {() => void} [close]
 */

/**
 * @param {string} type
 * @param {Object} [payload]
 * @returns {AdapterCommand}
 */
export function adapterCommand(type, payload) {
  return payload === undefined ? { type } : { type, payload };
}

/**
 * The snapshot fields consumed by the current v1 UI. Additional Pi fields are
 * intentionally allowed so the adapter can evolve without UI-owned state.
 *
 * @typedef {Object} MasterSnapshot
 * @property {Object} setup
 * @property {Object} floorPlan
 * @property {Object} burgerLevel
 * @property {Array<Object>} players
 * @property {Array<Object>} recipes
 * @property {Array<Object>} orders
 * @property {Object} [order] Legacy single-order alias accepted by the renderer.
 * @property {Array<Object>} stations
 * @property {Object} clock
 * @property {Object} score
 * @property {Object} gold
 * @property {Object} tips
 * @property {Array<Object>} submissions
 * @property {Object} serving
 * @property {Object} health
 */
