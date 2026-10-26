/**
 * One BrowserWindow per document, where it opens, its edited state, and the
 * Open panel that leads to them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, dialog, screen, shell } from "electron";
import * as documents from "./documents.js";
import { preloadPath } from "./paths.js";
import { parsePlacement, placeWindow } from "./placement.js";
import { addRecentDocument } from "./recent.js";
import { isViewerUrl, viewerUrl } from "./routes.js";
import { getState, setState } from "./state.js";

const isMac = process.platform === "darwin";

/** The state.json key for where the user last left a document window. */
const PLACEMENT_KEY = "window";

/** The size of the first window, before the user has sized one. */
const DEFAULT_SIZE = { width: 1000, height: 800 };

/**
 * Document windows share one macOS tab group, so Window > Merge All Windows
 * gathers them, and the tab bar's + button opens a document as a new tab.
 */
const TABBING_IDENTIFIER = "pdflion";

/** @type {Map<string, BrowserWindow>} document token -> window */
const windows = new Map();

/**
 * Windows whose document has unsaved changes. Electron's isDocumentEdited()
 * works only on macOS.
 * @type {WeakSet<BrowserWindow>}
 */
const editedWindows = new WeakSet();

/** Link schemes that open in the default browser or mail app. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

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
 * Opens a PDF in a new window, or focuses the window that already shows it.
 * If the file can't be read, shows an error instead and opens no window.
 *
 * @param {string} file absolute path
 * @param {BrowserWindow} [tabbedWith] macOS: a window to add the new window
 *   to as a tab
 * @returns {Promise<void>}
 */
export async function openDocument(file, tabbedWith) {
  let realPath;
  try {
    // Resolves symlinks and letter case, so each file has exactly one path.
    realPath = await fs.realpath(file);
    await checkReadable(realPath);
  } catch (error) {
    await showOpenError(file, /** @type {NodeJS.ErrnoException} */ (error));
    return;
  }

  const existing = findWindow(realPath);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const token = documents.register(realPath);
  const name = path.basename(realPath);
  const { bounds, maximized } = newWindowPlacement();
  const win = new BrowserWindow({
    title: name,
    ...bounds,
    show: !maximized,
    tabbingIdentifier: TABBING_IDENTIFIER,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });
  if (maximized) {
    win.maximize();
    win.show();
  }
  if (tabbedWith && !tabbedWith.isDestroyed()) tabbedWith.addTabbedWindow(win);
  windows.set(token, win);
  win.on("closed", () => {
    windows.delete(token);
    documents.unregister(token);
  });
  const remember = () => rememberPlacement(win);
  win.on("resized", remember).on("moved", remember);
  win.on("maximize", remember).on("unmaximize", remember);
  win.on("new-window-for-tab", () => showOpenPanel(win));
  // pdf.js zooms the pages on a pinch. Chromium's own pinch zoom, which
  // Electron leaves off by default, would scale the whole viewer. Setting the
  // limits fails until there's a page to apply them to.
  win.webContents.on("did-finish-load", () => win.webContents.setVisualZoomLevelLimits(1, 1));
  keepOnViewer(win);
  if (!isMac) {
    // The window shows the page's title, marked while edited.
    win.on("page-title-updated", (event, title) => {
      event.preventDefault();
      win.setTitle(windowTitle(win, title));
    });
  }

  setRepresentedFile(win, realPath);
  win.loadURL(viewerUrl(token, name));
}

/**
 * @param {BrowserWindow | null | undefined} win
 * @returns {boolean} whether `win` is a window showing a document
 */
export function isDocumentWindow(win) {
  return win != null && !win.isDestroyed() && documentToken(win) !== undefined;
}

/**
 * @param {BrowserWindow} win
 * @returns {string | undefined} the token of the document `win` shows
 */
export function documentToken(win) {
  for (const [token, other] of windows) {
    if (other === win) return token;
  }
}

/**
 * @param {BrowserWindow} win
 * @returns {string | undefined} the path of the file `win` shows
 */
export function documentFile(win) {
  const token = documentToken(win);
  return token && documents.resolve(token);
}

/**
 * Makes a window stand for `file`: in its title bar's proxy icon on macOS,
 * and in recent documents (File > Open Recent, plus the Dock menu on macOS and
 * the taskbar's jump list on Windows).
 *
 * @param {BrowserWindow} win
 * @param {string} file real path
 */
export function setRepresentedFile(win, file) {
  if (isMac) win.setRepresentedFilename(file);
  addRecentDocument(file);
}

/**
 * Records whether a window's document has unsaved changes, and shows it: as
 * the dot in the close button on macOS, and as a "*" before the title on
 * Windows, like Notepad.
 *
 * @param {BrowserWindow} win
 * @param {boolean} edited
 */
export function setEdited(win, edited) {
  if (edited) editedWindows.add(win);
  else editedWindows.delete(win);
  if (isMac) win.setDocumentEdited(edited);
  else win.setTitle(windowTitle(win, win.webContents.getTitle()));
}

/**
 * @param {BrowserWindow} win
 * @returns {boolean} whether the document in `win` has unsaved changes
 */
export function isEdited(win) {
  return editedWindows.has(win);
}

/**
 * Shows the Open panel and opens each chosen PDF. Does nothing while the
 * panel is already up, e.g. when the Dock icon is clicked again.
 *
 * @param {BrowserWindow} [tabbedWith] macOS: a window whose tab bar's + button
 *   was clicked, to add the new windows to as tabs
 * @returns {Promise<void>} settles once the chosen files have opened, or
 *   failed to
 */
export async function showOpenPanel(tabbedWith) {
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
  await Promise.all(filePaths.map((file) => openDocument(file, tabbedWith)));
}

/**
 * Where a new document window goes: see placement.js.
 *
 * @returns {import("./placement.js").Placement}
 */
function newWindowPlacement() {
  const remembered = parsePlacement(getState(PLACEMENT_KEY));
  const primary = screen.getPrimaryDisplay();
  const workAreas = [primary, ...screen.getAllDisplays().filter(({ id }) => id !== primary.id)].map(
    (display) => display.workArea,
  );
  const occupied = [...windows.values()].map((win) => win.getNormalBounds());
  return {
    bounds: placeWindow(remembered?.bounds ?? null, DEFAULT_SIZE, workAreas, occupied),
    maximized: remembered?.maximized ?? false,
  };
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
 * Keeps a window on the viewer, so `window.pdflion` never reaches another
 * page. Links open in the default browser or mail app instead.
 *
 * @param {BrowserWindow} win
 */
function keepOnViewer(win) {
  win.webContents.on("will-navigate", (event) => {
    if (!isViewerUrl(event.url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_PROTOCOLS.has(URL.parse(url)?.protocol ?? "")) shell.openExternal(url);
    return { action: "deny" };
  });
}

/**
 * @param {BrowserWindow} win
 * @param {string} title the page's title
 * @returns {string} the window title Windows shows for it
 */
function windowTitle(win, title) {
  return isEdited(win) ? `*${title}` : title;
}

/**
 * @param {string} file real path
 * @returns {BrowserWindow | undefined}
 */
function findWindow(file) {
  for (const [token, win] of windows) {
    if (documents.resolve(token) === file) return win;
  }
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
