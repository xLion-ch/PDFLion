/**
 * Recently opened documents. PDFLion keeps its own list on every platform, in
 * state.json, for Home and, on Windows and Linux, for File > Open Recent
 * (recentlist.js). It feeds the system's lists too: on macOS the one the Dock
 * menu and File > Open Recent show, and on Windows the taskbar's jump list,
 * once the installer has associated PDFs with PDFLion. Electron has no such
 * list on Linux.
 */
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { addRecent, MAX_RECENT_IN_MENU, readRecentList, removeRecent } from "./recentlist.js";
import { getState, setState } from "./state.js";
import { deleteThumbnail } from "./thumbnails.js";

/** Whether Electron can add to the system's list: on macOS and Windows. */
const hasSystemList = process.platform === "darwin" || process.platform === "win32";

const STATE_KEY = "recent";

/**
 * Where earlier versions kept the paths of their list, on Windows and Linux.
 * It's read until there's a list of the new kind, and left as it is, for an
 * earlier version to go on reading.
 */
const EARLIER_STATE_KEY = "recentDocuments";

/** @type {import("./recentlist.js").RecentEntry[] | null} read on first use */
let entries = null;

/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {string} file real path, just opened or saved under a new name */
export function addRecentDocument(file) {
  if (hasSystemList) app.addRecentDocument(file);
  const { entries: next, dropped } = addRecent(list(), file, Date.now(), randomUUID);
  for (const entry of dropped) deleteThumbnail(entry.id);
  update(next);
}

/** @returns {import("./recentlist.js").RecentEntry[]} most recent first */
export function recentDocuments() {
  return [...list()];
}

/** @returns {string[]} the paths File > Open Recent lists on Windows and Linux */
export function menuDocuments() {
  return list()
    .slice(0, MAX_RECENT_IN_MENU)
    .map((entry) => entry.path);
}

/**
 * @param {unknown} id
 * @returns {import("./recentlist.js").RecentEntry | undefined}
 */
export function findRecentDocument(id) {
  return list().find((entry) => entry.id === id);
}

/**
 * @param {string} file real path
 * @returns {string | undefined} its recent id, if it's in the list
 */
export function recentIdOf(file) {
  return list().find((entry) => entry.path === file)?.id;
}

/** @param {string} id removes that document from the list, with its thumbnail */
export function removeRecentDocument(id) {
  deleteThumbnail(id);
  update(removeRecent(list(), id));
}

/**
 * Empties PDFLion's list, with the thumbnails, and the system's. On macOS,
 * File > Open Recent's own Clear Menu empties only the system's.
 */
export function clearRecentDocuments() {
  if (hasSystemList) app.clearRecentDocuments();
  for (const entry of list()) deleteThumbnail(entry.id);
  update([]);
}

/** @param {() => void} listener called whenever the list changes */
export function onRecentDocumentsChange(listener) {
  listeners.add(listener);
}

/** @returns {import("./recentlist.js").RecentEntry[]} */
function list() {
  if (!entries) {
    const stored = getState(STATE_KEY);
    entries = readRecentList(stored ?? getState(EARLIER_STATE_KEY), randomUUID);
  }
  return entries;
}

/** @param {import("./recentlist.js").RecentEntry[]} next */
function update(next) {
  entries = next;
  setState(STATE_KEY, next);
  for (const listener of listeners) listener();
}
