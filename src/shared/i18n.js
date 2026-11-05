/**
 * PDFLion's texts (texts.js) for ES modules: main's, in the language
 * Electron runs in, and the web app's shell's, in the browser's. A module
 * that shows a text calls t() each time, so that it's in the language set
 * by then. Free of Electron and Node, in src/shared/.
 */
import "./texts.js";

/** @typedef {import("./texts.js").Translate} Translate */

const texts = /** @type {any} */ (globalThis).PDFLionTexts;

/** @type {Translate} */
let translate = texts.translator([]);

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Picks the language of PDFLion's texts: the first of `locales` it has, or
 * English.
 *
 * @param {readonly unknown[]} locales most wanted first, such as
 *   `navigator.languages`, or Electron's app.getLocale() and
 *   app.getPreferredSystemLanguages()
 */
export function setLanguage(locales) {
  translate = texts.translator(locales);
  for (const listener of listeners) listener();
}

/**
 * @param {() => void} listener called after each setLanguage()
 * @returns {() => void} what stops it
 */
export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} [values] for the braces in the text
 * @returns {string} the text in the language set
 */
export function t(id, values) {
  return translate(id, values);
}

/** @returns {string} the language set, such as `de` or `de-ch` */
export function language() {
  return translate.language;
}

/** @returns {string} the language set as a BCP 47 tag, for Intl */
export function locale() {
  return translate.locale;
}

/**
 * @param {string[]} items
 * @returns {string} them joined with "and", in the language set
 */
export function list(items) {
  return translate.list(items);
}
