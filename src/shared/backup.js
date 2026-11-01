/**
 * The files PDFLion exports and imports, so that another computer, or an
 * iPad, starts with the same settings: `PDFLion Settings.json`, the same on
 * every platform. It holds what the user chose: the tool settings, the
 * favourites, and on desktop whether updates are checked automatically. It
 * leaves out what belongs to one machine or one moment, such as where windows
 * were and which documents were recent.
 *
 * The web app's backup is a ZIP (zip.js) of the settings file,
 * `Library.json`, which lists the documents PDFLion keeps there with their
 * records, `Documents/<name>.pdf`, each document under its own name, so
 * that they can be reached without PDFLion, and `Thumbnails/<id>.png`.
 *
 * A settings file or a backup comes from anywhere, so reading one checks
 * every part as tools.js checks state.json, and keeps only what it knows.
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

/** The list of the documents in a backup. */
export const LIBRARY_FILE_NAME = "Library.json";

/** Where a backup has its documents and their thumbnails. */
export const DOCUMENTS_FOLDER = "Documents/";
export const THUMBNAILS_FOLDER = "Thumbnails/";

/** The most Library.json may hold: some hundred thousand documents. */
export const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;

/** What Library.json says it is. */
const LIBRARY_FORMAT = "pdflion-library";

/** The version of Library.json this writes, and the newest it reads. */
export const LIBRARY_VERSION = 1;

/** The longest name a document may have, as library.js allows. */
const MAX_NAME_LENGTH = 255;

/** Where a document came from, as library.js keeps it. */
const SOURCES = ["files", "new", "drop"];

/**
 * @typedef {object} BackupDocument a document's record in Library.json, as
 *   the web app's library keeps it, with where the backup has its files
 * @property {string} id
 * @property {string} name
 * @property {number} size
 * @property {number} createdAt
 * @property {number} openedAt
 * @property {number} modifiedAt
 * @property {number} revision
 * @property {number} exportedRevision
 * @property {"files" | "new" | "drop"} source
 * @property {string | null} sha256
 * @property {string} file its path in the backup, `Documents/<name>`
 * @property {string | null} thumbnail its thumbnail's path, `Thumbnails/<id>.png`
 */

/** @typedef {"too-large" | "not-library" | "newer"} LibraryFileError */

/**
 * @param {Date} at
 * @returns {string} the backup's file name, by the local date, such as
 *   `PDFLion Backup 2026-10-31.zip`
 */
export function backupFileName(at) {
  const pad = (/** @type {number} */ number) => String(number).padStart(2, "0");
  return `PDFLion Backup ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.zip`;
}

/**
 * @param {{ id: string, name: string }[]} documents
 * @returns {Map<string, string>} each document's path in a backup, by its
 *   id: its name in DOCUMENTS_FOLDER, with " 2", " 3" and so on before the
 *   extension where names repeat, as Files and Finder tell them apart
 */
export function documentFiles(documents) {
  /** @type {Set<string>} */
  const taken = new Set();
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const { id, name } of documents) {
    const dot = name.lastIndexOf(".");
    const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      const suffix = ` ${n}${extension}`;
      candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
    }
    taken.add(candidate.toLowerCase());
    files.set(id, `${DOCUMENTS_FOLDER}${candidate}`);
  }
  return files;
}

/**
 * @param {BackupDocument[]} documents
 * @param {object} exported
 * @param {string} exported.app the version of PDFLion
 * @param {string} exported.platform such as `web`
 * @param {Date} exported.at
 * @returns {string} Library.json
 */
export function writeLibraryFile(documents, { app, platform, at }) {
  const file = {
    format: LIBRARY_FORMAT,
    version: LIBRARY_VERSION,
    exportedAt: at.toISOString(),
    exportedBy: { app, platform },
    documents: documents.map(parseBackupDocument).filter((document) => document !== null),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * @param {string} text Library.json
 * @returns {{ documents: BackupDocument[], rejected: number } | { error: LibraryFileError }}
 *   the documents that are right, each id once, and how many weren't
 */
export function readLibraryFile(text) {
  if (new TextEncoder().encode(text).length > MAX_LIBRARY_BYTES) return { error: "too-large" };
  let file;
  try {
    file = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { error: "not-library" };
  }
  if (!isRecord(file) || file.format !== LIBRARY_FORMAT || !Array.isArray(file.documents)) {
    return { error: "not-library" };
  }
  const { version } = file;
  if (!Number.isSafeInteger(version) || /** @type {number} */ (version) < 1) {
    return { error: "not-library" };
  }
  if (/** @type {number} */ (version) > LIBRARY_VERSION) return { error: "newer" };
  /** @type {BackupDocument[]} */
  const documents = [];
  const ids = new Set();
  const files = new Set();
  let rejected = 0;
  for (const value of file.documents) {
    const document = parseBackupDocument(value);
    if (!document || ids.has(document.id) || files.has(document.file)) {
      rejected++;
      continue;
    }
    ids.add(document.id);
    files.add(document.file);
    documents.push(document);
  }
  return { documents, rejected };
}

/**
 * @param {unknown} value
 * @returns {BackupDocument | null} the record, rebuilt from its known
 *   fields, if every one is right: ids are UUIDs, a name is a file's name
 *   of at most 255 characters, dates and revisions are numbers, and the
 *   paths are in their folders
 */
function parseBackupDocument(value) {
  if (!isRecord(value)) return null;
  const { id, name, size, createdAt, openedAt, modifiedAt, revision, exportedRevision, source, sha256, file, thumbnail } =
    value;
  const isTime = (/** @type {unknown} */ time) => typeof time === "number" && Number.isFinite(time) && time >= 0;
  const valid =
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) &&
    isFileName(name) &&
    Number.isSafeInteger(size) &&
    /** @type {number} */ (size) > 0 &&
    isTime(createdAt) &&
    isTime(openedAt) &&
    isTime(modifiedAt) &&
    Number.isSafeInteger(revision) &&
    /** @type {number} */ (revision) >= 0 &&
    Number.isSafeInteger(exportedRevision) &&
    /** @type {number} */ (exportedRevision) >= -1 &&
    /** @type {number} */ (exportedRevision) <= /** @type {number} */ (revision) &&
    typeof source === "string" &&
    SOURCES.includes(source) &&
    (sha256 === null || (typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256))) &&
    typeof file === "string" &&
    file.startsWith(DOCUMENTS_FOLDER) &&
    isFileName(file.slice(DOCUMENTS_FOLDER.length)) &&
    (thumbnail === null || thumbnail === `${THUMBNAILS_FOLDER}${id}.png`);
  if (!valid) return null;
  return /** @type {BackupDocument} */ ({
    id,
    name,
    size,
    createdAt,
    openedAt,
    modifiedAt,
    revision,
    exportedRevision,
    source,
    sha256,
    file,
    thumbnail,
  });
}

/**
 * @param {unknown} name
 * @returns {boolean} whether it's a single file's name, as library.js's
 *   cleanName() leaves one
 */
function isFileName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    name === name.trim() &&
    name !== "." &&
    name !== ".." &&
    !/[\u0000-\u001f\u007f/\\]/.test(name)
  );
}
