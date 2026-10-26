/**
 * Recently opened documents. On macOS the system keeps the list, for the Dock
 * menu and File > Open Recent. On Windows, app.addRecentDocument() feeds only
 * the taskbar's jump list, and only once the installer has associated PDFs
 * with PDFLion. So on Windows PDFLion also keeps its own list in state.json,
 * for File > Open Recent.
 */
import path from "node:path";
import { app } from "electron";
import { getState, setState } from "./state.js";

const isMac = process.platform === "darwin";

const STATE_KEY = "recentDocuments";

/** As many as Windows apps usually list. */
const MAX_RECENT_DOCUMENTS = 10;

/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {string} file real path */
export function addRecentDocument(file) {
  app.addRecentDocument(file);
  if (isMac) return;
  const files = [file, ...recentDocuments().filter((other) => other !== file)];
  update(files.slice(0, MAX_RECENT_DOCUMENTS));
}

/** Windows only. On macOS, File > Open Recent has the clearRecentDocuments role. */
export function clearRecentDocuments() {
  app.clearRecentDocuments();
  update([]);
}

/**
 * Windows only.
 * @returns {string[]} real paths, most recent first
 */
export function recentDocuments() {
  const files = getState(STATE_KEY);
  if (!Array.isArray(files)) return [];
  return files
    .filter((file) => typeof file === "string" && path.isAbsolute(file))
    .slice(0, MAX_RECENT_DOCUMENTS);
}

/**
 * Windows only.
 * @param {() => void} listener called whenever recentDocuments() changes
 */
export function onRecentDocumentsChange(listener) {
  listeners.add(listener);
}

/** @param {string[]} files */
function update(files) {
  setState(STATE_KEY, files);
  for (const listener of listeners) listener();
}
