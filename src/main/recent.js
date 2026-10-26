/**
 * Recently opened documents. On macOS the system keeps the list, for the Dock
 * menu and File > Open Recent. On Windows, app.addRecentDocument() feeds only
 * the taskbar's jump list, and only once the installer has associated PDFs
 * with PDFLion. Linux has no such call in Electron. So on Windows and Linux
 * PDFLion keeps its own list in state.json, for File > Open Recent.
 */
import path from "node:path";
import { app } from "electron";
import { getState, setState } from "./state.js";

const isMac = process.platform === "darwin";

/** Whether Electron can add to the system's list: on macOS and Windows. */
const hasSystemList = isMac || process.platform === "win32";

const STATE_KEY = "recentDocuments";

/** As many as Windows apps usually list. */
const MAX_RECENT_DOCUMENTS = 10;

/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {string} file real path */
export function addRecentDocument(file) {
  if (hasSystemList) app.addRecentDocument(file);
  if (isMac) return;
  const files = [file, ...recentDocuments().filter((other) => other !== file)];
  update(files.slice(0, MAX_RECENT_DOCUMENTS));
}

/**
 * Windows and Linux only. On macOS, File > Open Recent has the
 * clearRecentDocuments role.
 */
export function clearRecentDocuments() {
  if (hasSystemList) app.clearRecentDocuments();
  update([]);
}

/**
 * Windows and Linux only.
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
 * Windows and Linux only.
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
