/**
 * Home: the recent documents, with their thumbnails, and the ways to open a
 * document from there. A home tab's page (src/home/) asks through
 * `window.pdflionHome` (src/preload/home.cjs). Its `pdflion-home:*` messages
 * are checked like the viewer's: they must come from the top frame of a home
 * tab, at Home's URL, and name documents by their recent ids, so the page
 * never sends a path. Main sends every home tab the list whenever it, the
 * open tabs or a thumbnail change.
 *
 * The viewer sends each document's thumbnail on `pdflion:thumbnail`, which
 * main stores without decoding it (thumbnails.js).
 *
 * The channel names are repeated in src/preload/home.cjs and preload.cjs,
 * which can't import this module.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dialog, ipcMain, Menu, shell } from "electron";
import { isThumbnail } from "../shared/thumbnail.js";
import { CANCEL, REMOVE, missingRecent } from "../shared/wording.js";
import { fromViewer, isPathList } from "./ipc.js";
import {
  clearRecentDocuments,
  findRecentDocument,
  onRecentDocumentsChange,
  recentDocuments,
  recentIdOf,
  removeRecentDocument,
} from "./recent.js";
import { isHomeUrl, thumbnailUrl } from "./routes.js";
import * as tabs from "./tabs.js";
import { saveThumbnail, thumbnailVersion } from "./thumbnails.js";
import { newDocument, openDocuments, showOpenPanel } from "./windows.js";

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

/** The context menu's item that shows the file where it is. */
const SHOW_IN_FOLDER = isMac
  ? "Show in Finder"
  : process.platform === "win32"
    ? "Show in Explorer"
    : "Show in Files";

/**
 * @typedef {object} HomeDocument what Home shows of a recent document
 * @property {string} id
 * @property {string} name the file's
 * @property {string} folder where it is, with the home folder as `~` on
 *   macOS and Linux
 * @property {number | null} openedAt when it was last opened, in ms
 * @property {string | null} thumbnail its URL, if there's one
 * @property {boolean} open whether a tab shows it
 * @property {boolean} missing whether its file is gone
 */

/** Whether an update of every home tab is on its way. */
let sending = false;

/** Must run once the app is ready, before any window loads. */
export function handleHome() {
  // The page asks for the list once it listens.
  ipcMain.on("pdflion-home:ready", (event) => {
    const tab = homeTab(event);
    if (tab) homeState().then((state) => send(tab, state));
  });

  ipcMain.on("pdflion-home:open", (event, id) => {
    const tab = homeTab(event);
    const entry = findRecentDocument(id);
    if (tab && entry) openRecent(tab, entry);
  });

  ipcMain.on("pdflion-home:show-open-panel", (event) => {
    const tab = homeTab(event);
    if (tab) showOpenPanel(tabs.windowOf(tab) ?? undefined);
  });

  ipcMain.on("pdflion-home:new-document", (event) => {
    const tab = homeTab(event);
    if (tab) newDocument(tabs.windowOf(tab) ?? undefined);
  });

  ipcMain.on("pdflion-home:remove", (event, id) => {
    const entry = findRecentDocument(id);
    if (homeTab(event) && entry) removeRecentDocument(entry.id);
  });

  ipcMain.on("pdflion-home:clear", (event) => {
    if (homeTab(event)) clearRecentDocuments();
  });

  ipcMain.on("pdflion-home:show-in-folder", (event, id) => {
    const entry = findRecentDocument(id);
    if (homeTab(event) && entry) shell.showItemInFolder(entry.path);
  });

  ipcMain.on("pdflion-home:context-menu", (event, id) => {
    const tab = homeTab(event);
    const entry = findRecentDocument(id);
    if (tab && entry) showContextMenu(tab, entry);
  });

  // PDFs dropped on Home open in its window, the first in its place.
  ipcMain.on("pdflion-home:open-files", (event, paths) => {
    const tab = homeTab(event);
    if (tab && isPathList(paths)) openDocuments(paths, tabs.windowOf(tab) ?? undefined);
  });

  // The first page of a document with a file, which the viewer rendered.
  ipcMain.on("pdflion:thumbnail", (event, bytes) => {
    const tab = tabs.fromWebContents(event.sender);
    const file = tab && fromViewer(event) ? tabs.documentFile(tab) : undefined;
    const id = file && recentIdOf(file);
    if (!id || !isThumbnail(bytes)) return;
    saveThumbnail(id, bytes).then(updateHomes, (error) => {
      console.warn(`Couldn't keep the thumbnail of ${file}:`, error);
    });
  });

  onRecentDocumentsChange(updateHomes);
  tabs.onTabsChange(updateHomes);
}

/**
 * The home tab that sent a message: the top frame of a home tab's page, at
 * Home's URL.
 *
 * @param {Electron.IpcMainEvent} event
 * @returns {tabs.Tab | undefined}
 */
export function homeTab(event) {
  const frame = event.senderFrame;
  if (frame === null || frame.parent !== null || !isHomeUrl(frame.url)) return undefined;
  const tab = tabs.fromWebContents(event.sender);
  return tab && tabs.isHome(tab) ? tab : undefined;
}

/**
 * Opens a recent document in a home tab's window, where it takes the home
 * tab's place, or selects its tab if it's open. If its file is gone, offers to
 * take it off the list.
 *
 * @param {tabs.Tab} tab
 * @param {import("./recentlist.js").RecentEntry} entry
 */
async function openRecent(tab, entry) {
  const win = tabs.windowOf(tab);
  if (!(await exists(entry.path))) {
    if (!win) return;
    const buttons = isLinux ? [CANCEL, REMOVE] : [REMOVE, CANCEL];
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      ...missingRecent(path.basename(entry.path)),
      buttons,
      defaultId: buttons.indexOf(REMOVE),
      cancelId: buttons.indexOf(CANCEL),
      noLink: true,
    });
    if (buttons[response] === REMOVE) removeRecentDocument(entry.id);
    return;
  }
  openDocuments([entry.path], win ?? undefined);
}

/**
 * The native context menu of a document on Home.
 *
 * @param {tabs.Tab} tab
 * @param {import("./recentlist.js").RecentEntry} entry
 */
function showContextMenu(tab, entry) {
  const win = tabs.windowOf(tab);
  if (!win) return;
  Menu.buildFromTemplate([
    { label: "Open", click: () => openRecent(tab, entry) },
    { label: SHOW_IN_FOLDER, click: () => shell.showItemInFolder(entry.path) },
    { type: "separator" },
    { label: "Remove from Recent", click: () => removeRecentDocument(entry.id) },
  ]).popup({ window: win });
}

/**
 * Sends every home tab the list, once for any number of changes in a row.
 */
function updateHomes() {
  if (sending) return;
  sending = true;
  setImmediate(async () => {
    sending = false;
    const homes = tabs.allTabs().filter(tabs.isHome);
    if (homes.length === 0) return;
    const state = await homeState();
    for (const tab of homes) send(tab, state);
  });
}

/**
 * @param {tabs.Tab} tab
 * @param {HomeDocument[]} state
 */
function send(tab, state) {
  if (tabs.isOpen(tab) && !tab.webContents.isDestroyed()) {
    tab.webContents.send("pdflion-home:state", state);
  }
}

/** @returns {Promise<HomeDocument[]>} the recent documents, as Home shows them */
function homeState() {
  return Promise.all(
    recentDocuments().map(async ({ id, path: file, openedAt }) => {
      const [present, version] = await Promise.all([exists(file), thumbnailVersion(id)]);
      return {
        id,
        name: path.basename(file),
        folder: displayFolder(path.dirname(file)),
        openedAt,
        thumbnail: version === null ? null : thumbnailUrl(id, version),
        open: tabs.findTab(file) !== undefined,
        missing: !present,
      };
    }),
  );
}

/**
 * @param {string} folder absolute path
 * @returns {string} `folder`, with the home folder as `~` on macOS and Linux
 */
function displayFolder(folder) {
  if (process.platform === "win32") return folder;
  const home = os.homedir();
  if (folder === home) return "~";
  return folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}

/**
 * @param {string} file
 * @returns {Promise<boolean>} whether it's there, as far as PDFLion can tell
 */
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT";
  }
}
