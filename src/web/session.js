/**
 * The web app's session: the open tabs, in order, the active one, and where
 * each document was, which the shell keeps in the library's `session`
 * store, since iPadOS ends a web app it suspended without warning. A launch
 * restores them, and a tab that sleeps (shell.js) wakes where it was.
 *
 * A view comes from the viewer's bridge.js, and a session from IndexedDB,
 * so both are checked before use, and a view goes into the viewer's URL
 * only as a hash this module writes.
 *
 * Free of the browser's globals, so that unit tests run it under plain
 * Node.
 */

import { isDocumentId } from "./library.js";

/** pdf.js's named zooms (`currentScaleValue`). */
const NAMED_ZOOMS = ["auto", "page-actual", "page-fit", "page-width"];

/** More than pdf.js zooms to, in percent (`MAX_SCALE` in web/ui_utils.js is 25). */
const MAX_ZOOM = 10_000;

/** More pages than any document has. */
const MAX_PAGE = 1_000_000;

/** Further than any page reaches, in PDF points. */
const MAX_OFFSET = 10_000_000;

/** More tabs than anyone keeps open. */
const MAX_TABS = 200;

/**
 * @typedef {object} View where a document was, as pdf.js's location has it
 * @property {number} page its number, from 1
 * @property {number | string} zoom a percentage, or one of NAMED_ZOOMS
 * @property {number} left the point at the view's top left, in the page's
 *   PDF points
 * @property {number} top
 */

/**
 * @typedef {{ kind: "home" } | { kind: "document", documentId: string, view: View | null }} SessionTab
 */

/**
 * @typedef {object} Session
 * @property {SessionTab[]} tabs in the strip's order
 * @property {number} active the index of the active one, or -1 without tabs
 */

/**
 * @param {unknown} value a view, as bridge.js sends it or the session keeps it
 * @returns {View | null} the view, rebuilt from its known fields, or null if
 *   it isn't one
 */
export function parseView(value) {
  if (typeof value !== "object" || value === null) return null;
  const { page, zoom, left, top } = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isInteger(page) || /** @type {number} */ (page) < 1 || /** @type {number} */ (page) > MAX_PAGE) {
    return null;
  }
  const named = typeof zoom === "string" && NAMED_ZOOMS.includes(zoom);
  const scaled = typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 && zoom <= MAX_ZOOM;
  if (!named && !scaled) return null;
  const offset = (/** @type {unknown} */ number) =>
    typeof number === "number" && Number.isFinite(number)
      ? Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(number)))
      : 0;
  return {
    page: /** @type {number} */ (page),
    zoom: /** @type {number | string} */ (zoom),
    left: offset(left),
    top: offset(top),
  };
}

/**
 * @param {View} view checked with parseView()
 * @returns {string} the view as the hash of pdf.js's viewer, without `#`,
 *   which pdf.js shows a document at once it has loaded, as its own
 *   location's `pdfOpenParams`
 */
export function viewHash({ page, zoom, left, top }) {
  return `page=${page}&zoom=${zoom},${left},${top}`;
}

/**
 * @param {unknown} value the session, as stored
 * @returns {Session} the session, rebuilt from its known fields, without
 *   tabs that aren't tabs, and with a document's tab and Home only once
 */
export function parseSession(value) {
  /** @type {Session} */
  const empty = { tabs: [], active: -1 };
  if (typeof value !== "object" || value === null) return empty;
  const { tabs, active } = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(tabs)) return empty;
  /** @type {SessionTab[]} */
  const kept = [];
  const seen = new Set();
  let activeIndex = -1;
  for (const [index, tab] of tabs.slice(0, MAX_TABS).entries()) {
    if (typeof tab !== "object" || tab === null) continue;
    const { kind, documentId, view } = /** @type {Record<string, unknown>} */ (tab);
    const key = kind === "home" ? "home" : documentId;
    if ((kind !== "home" && (kind !== "document" || !isDocumentId(documentId))) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (index === active) activeIndex = kept.length;
    kept.push(
      kind === "home"
        ? { kind: "home" }
        : { kind: "document", documentId: /** @type {string} */ (documentId), view: parseView(view) },
    );
  }
  if (activeIndex === -1 && kept.length > 0) activeIndex = kept.length - 1;
  return { tabs: kept, active: activeIndex };
}
