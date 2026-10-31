/**
 * The files PDFLion exports and imports, so that another computer, or an
 * iPad, starts with the same settings: `PDFLion Settings.json`, the same on
 * every platform. It holds what the user chose: the tool settings, the
 * favourites, and on desktop whether updates are checked automatically. It
 * leaves out what belongs to one machine or one moment, such as where windows
 * were and which documents were recent.
 *
 * A settings file comes from anywhere, so reading it checks every part as
 * tools.js checks state.json, and keeps only what it knows.
 * Free of Electron and Node, in src/shared/, so that the web app can use it
 * too, and unit tests under plain Node.
 */
import { MAX_FAVOURITES, parseEraser, parseFavourite } from "./tools.js";

/** What Export Settings… suggests. */
export const SETTINGS_FILE_NAME = "PDFLion Settings.json";

/** The most a settings file may hold. Hundreds of favourites take some tens of KiB. */
export const MAX_SETTINGS_BYTES = 1024 * 1024;

/** What a settings file says it is. */
const FORMAT = "pdflion-settings";

/** The version this writes, and the newest it reads. */
export const SETTINGS_VERSION = 1;

/**
 * @typedef {object} ImportedSettings what a settings file holds, each part
 *   null where it has none, or a wrong one
 * @property {import("./tools.js").EraserSettings | null} eraser
 * @property {boolean | null} penOnly
 * @property {import("./tools.js").Favourite[]} favourites those that are
 *   right, without repeats
 * @property {boolean | null} automaticUpdates
 */

/** @typedef {"too-large" | "not-settings" | "newer"} SettingsFileError */

/**
 * @param {object} settings
 * @param {import("./tools.js").ToolSettings} settings.toolSettings
 * @param {boolean | null} settings.automaticUpdates null where there's no such
 *   setting, as in the web app
 * @param {object} exported
 * @param {string} exported.app the version of PDFLion
 * @param {string} exported.platform such as `darwin`
 * @param {Date} exported.at
 * @returns {string} the file
 */
export function writeSettingsFile({ toolSettings, automaticUpdates }, { app, platform, at }) {
  const file = {
    format: FORMAT,
    version: SETTINGS_VERSION,
    exportedAt: at.toISOString(),
    exportedBy: { app, platform },
    toolSettings: { eraser: toolSettings.eraser, penOnly: toolSettings.penOnly },
    favourites: toolSettings.favourites,
    ...(automaticUpdates === null ? {} : { updates: { automatic: automaticUpdates } }),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * @param {string} text the file, which a text editor may have saved with a
 *   byte order mark
 * @returns {{ settings: ImportedSettings } | { error: SettingsFileError }}
 */
export function readSettingsFile(text) {
  if (new TextEncoder().encode(text).length > MAX_SETTINGS_BYTES) return { error: "too-large" };
  let file;
  try {
    file = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { error: "not-settings" };
  }
  if (!isRecord(file) || file.format !== FORMAT) return { error: "not-settings" };
  const { version } = file;
  if (!Number.isSafeInteger(version) || /** @type {number} */ (version) < 1) {
    return { error: "not-settings" };
  }
  if (/** @type {number} */ (version) > SETTINGS_VERSION) return { error: "newer" };

  const toolSettings = isRecord(file.toolSettings) ? file.toolSettings : {};
  const updates = isRecord(file.updates) ? file.updates : {};
  const favourites = Array.isArray(file.favourites) ? file.favourites.map(parseFavourite) : [];
  /** @type {Set<string>} */
  const seen = new Set();
  return {
    settings: {
      eraser: parseEraser(toolSettings.eraser),
      penOnly: typeof toolSettings.penOnly === "boolean" ? toolSettings.penOnly : null,
      favourites: favourites
        .filter((favourite) => {
          const key = JSON.stringify(favourite);
          if (favourite === null || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, MAX_FAVOURITES),
      automaticUpdates: typeof updates.automatic === "boolean" ? updates.automatic : null,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>} whether it's a plain object
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
