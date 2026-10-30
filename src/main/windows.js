/**
 * Document windows: where they open, which one is in front, and the Open
 * panel that leads to them. Each window's own page is the tab strip, and its
 * documents are tabs (tabs.js). Opening a document adds a tab to the
 * frontmost window, and a new window opens only when there's none.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, dialog, screen } from "electron";
import * as documents from "./documents.js";
import { tabsPreloadPath } from "./paths.js";
import { parsePlacement, placeWindow } from "./placement.js";
import { TABS_URL } from "./routes.js";
import { getState, setState } from "./state.js";
import * as tabs from "./tabs.js";

const isLinux = process.platform === "linux";

/** The state.json key for where the user last left a document window. */
const PLACEMENT_KEY = "window";

/** The size of the first window, before the user has sized one. */
const DEFAULT_SIZE = { width: 1000, height: 800 };

/**
 * The narrowest a document window's content gets: its toolbar fits down to
 * this width once it has taken every step it has (`layoutToolbar()` in
 * bridge.js). Measured in English and German, for a document of 1000 pages,
 * with favourites, on 29 October 2026, when German needed 555 px.
 */
const MIN_WIDTH = 560;

/**
 * Document windows, the most recently focused first.
 * @type {BrowserWindow[]}
 */
const windows = [];

/**
 * Phrased like Preview's "couldn't be opened because …" alerts.
 * @type {Record<string, string>}
 */
const OPEN_ERRORS = {
  ENOENT: "there is no such file",
  EACCES: "you don’t have permission to view it",
  EPERM: "you don’t have permission to view it",
  EISDIR: "it isn’t a file",
};

let openPanelShown = false;

/**
 * Opens PDFs as tabs, in the order given, and selects the last one. A file
 * that's already open gets its tab selected instead. Files that can't be read
 * show an error and open nothing.
 *
 * @param {string[]} files absolute paths
 * @param {BrowserWindow} [target] the window to add the tabs to; defaults to
 *   the frontmost window, or a new one
 * @returns {Promise<void>}
 */
export async function openDocuments(files, target) {
  const realPaths = await Promise.all(
    files.map(async (file) => {
      try {
        // Resolves symlinks and letter case, so each file has exactly one path.
        const realPath = await fs.realpath(file);
        await checkReadable(realPath);
        return realPath;
      } catch (error) {
        await showOpenError(file, /** @type {NodeJS.ErrnoException} */ (error));
        return null;
      }
    }),
  );

  for (const realPath of realPaths) {
    if (realPath === null) continue;
    const existing = tabs.findTab(realPath);
    if (existing) {
      tabs.selectTab(existing);
      showWindow(/** @type {BrowserWindow} */ (tabs.windowOf(existing)));
      continue;
    }
    const win = target && !target.isDestroyed() ? target : (frontmostWindow() ?? createWindow());
    const tab = tabs.openTab(win, documents.register(realPath));
    tabs.setRepresentedFile(tab, realPath);
    showWindow(win);
  }
}

/**
 * @param {string} file absolute path
 * @returns {Promise<void>}
 */
export function openDocument(file) {
  return openDocuments([file]);
}

/** File > New: an untitled document as a tab of the frontmost window, or of a new one. */
export function newDocument() {
  const win = frontmostWindow() ?? createWindow();
  tabs.newDocument(win);
  showWindow(win);
}

/**
 * @param {BrowserWindow | null | undefined} win
 * @returns {boolean} whether `win` is a window showing documents
 */
export function isDocumentWindow(win) {
  return win != null && !win.isDestroyed() && tabs.activeTab(win) !== undefined;
}

/**
 * @returns {BrowserWindow[]} the document windows, the frontmost first
 */
export function documentWindows() {
  return windows.filter(isDocumentWindow);
}

/**
 * @returns {BrowserWindow | undefined} the focused document window, else the
 *   one focused last
 */
function frontmostWindow() {
  return documentWindows()[0];
}

/**
 * Moves a tab into a new window of its own, which opens where new windows
 * open, or with `bounds` if given.
 *
 * @param {tabs.Tab} tab
 * @param {Electron.Rectangle} [bounds] screen coordinates, kept on screen
 */
export function moveTabToNewWindow(tab, bounds) {
  const win = createWindow(bounds && onScreen(bounds));
  tabs.moveTab(tab, win, 0);
  showWindow(win);
}

/** Moves every tab into the frontmost window, which the others then leave. */
export function mergeAllWindows() {
  const [target, ...others] = documentWindows();
  if (!target) return;
  const active = tabs.activeTab(target);
  for (const win of others) {
    for (const tab of tabs.tabsOf(win)) tabs.moveTab(tab, target);
  }
  if (active) tabs.selectTab(active);
}

/**
 * Shows the Open panel and opens each chosen PDF. Does nothing while the
 * panel is already up, e.g. when the Dock icon is clicked again.
 *
 * @returns {Promise<void>} settles once the chosen files have opened, or
 *   failed to
 */
export async function showOpenPanel() {
  if (openPanelShown) return;
  openPanelShown = true;
  let filePaths;
  try {
    ({ filePaths } = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
    }));
  } finally {
    openPanelShown = false;
  }
  await openDocuments(filePaths);
}

/**
 * Opens a window showing the tab strip, still without tabs.
 *
 * @param {Electron.Rectangle} [bounds] defaults to where new windows open
 * @returns {BrowserWindow}
 */
function createWindow(bounds) {
  const placement = bounds ? { bounds, maximized: false } : newWindowPlacement();
  const win = new BrowserWindow({
    ...placement.bounds,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: tabsPreloadPath,
    },
  });
  // A minimum size counts the window's frame, which on Windows and Linux
  // takes some of the width from the content, and the toolbar.
  win.setMinimumSize(MIN_WIDTH + win.getSize()[0] - win.getContentSize()[0], 0);
  if (placement.maximized) win.maximize();
  // A new window opens in front of the others.
  windows.unshift(win);
  win.on("focus", () => {
    windows.splice(windows.indexOf(win), 1);
    windows.unshift(win);
  });
  win.on("closed", () => {
    const index = windows.indexOf(win);
    if (index !== -1) windows.splice(index, 1);
  });
  const remember = () => rememberPlacement(win);
  // Linux has no events for the end of a move or resize, only for each step.
  // state.js batches the writes.
  if (isLinux) win.on("resize", remember).on("move", remember);
  else win.on("resized", remember).on("moved", remember);
  win.on("maximize", remember).on("unmaximize", remember);
  // tabs.js titles the window after its active tab, not after the strip.
  win.on("page-title-updated", (event) => event.preventDefault());
  keepOnStrip(win);
  win.loadURL(TABS_URL);
  return win;
}

/**
 * Brings a window to the front, and shows it the first time.
 *
 * @param {BrowserWindow} win
 */
function showWindow(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Where a new document window goes: see placement.js.
 *
 * @returns {import("./placement.js").Placement}
 */
function newWindowPlacement() {
  const remembered = parsePlacement(getState(PLACEMENT_KEY));
  return {
    bounds: placeWindow(
      remembered?.bounds ?? null,
      DEFAULT_SIZE,
      workAreas(),
      windows.map((win) => win.getNormalBounds()),
    ),
    maximized: remembered?.maximized ?? false,
  };
}

/**
 * @param {Electron.Rectangle} bounds
 * @returns {Electron.Rectangle} `bounds`, moved and shrunk onto a display
 */
function onScreen(bounds) {
  return placeWindow(bounds, DEFAULT_SIZE, workAreas(), []);
}

/** @returns {Electron.Rectangle[]} the displays' work areas, primary first */
function workAreas() {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter(({ id }) => id !== primary.id)].map(
    (display) => display.workArea,
  );
}

/**
 * Remembers where the user left a window, for the next one to open there.
 * Full screen and minimized are passing states, not placements.
 *
 * @param {BrowserWindow} win
 */
function rememberPlacement(win) {
  if (win.isFullScreen() || win.isMinimized()) return;
  setState(PLACEMENT_KEY, { ...win.getNormalBounds(), maximized: win.isMaximized() });
}

/**
 * Keeps a window's own page on the tab strip, which opens nothing.
 *
 * @param {BrowserWindow} win
 */
function keepOnStrip(win) {
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/**
 * Opening the file rather than checking `fs.access` also catches macOS privacy
 * protection, which denies reads that file permissions would allow.
 *
 * @param {string} file
 */
async function checkReadable(file) {
  const handle = await fs.open(file, "r");
  try {
    if (!(await handle.stat()).isFile()) {
      throw Object.assign(new Error(`${file} is not a file`), { code: "EISDIR" });
    }
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} file
 * @param {NodeJS.ErrnoException} error
 */
async function showOpenError(file, error) {
  const name = path.basename(file);
  const reason = error.code && OPEN_ERRORS[error.code];
  await dialog.showMessageBox({
    type: "warning",
    message: reason
      ? `The file “${name}” couldn’t be opened because ${reason}.`
      : `The file “${name}” couldn’t be opened.`,
    detail: reason ? undefined : error.message,
  });
}
