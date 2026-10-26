/**
 * One BrowserWindow per document, its edited state, and the Open panel that
 * leads to them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import * as documents from "./documents.js";
import { preloadPath } from "./paths.js";
import { isViewerUrl, viewerUrl } from "./routes.js";

const isMac = process.platform === "darwin";

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
 * @returns {Promise<void>}
 */
export async function openDocument(file) {
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
  const win = new BrowserWindow({
    title: name,
    width: 1000,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });
  windows.set(token, win);
  win.on("closed", () => {
    windows.delete(token);
    documents.unregister(token);
  });
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
 * and in recent documents (the Dock menu and File > Open Recent on macOS, the
 * taskbar's jump list on Windows).
 *
 * @param {BrowserWindow} win
 * @param {string} file real path
 */
export function setRepresentedFile(win, file) {
  if (isMac) win.setRepresentedFilename(file);
  app.addRecentDocument(file);
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
  await Promise.all(filePaths.map(openDocument));
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
