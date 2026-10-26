/**
 * One BrowserWindow per document, plus the Open panel that leads to them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import * as documents from "./documents.js";
import { preloadPath } from "./paths.js";
import { isViewerUrl, viewerUrl } from "./routes.js";

/** @type {Map<string, BrowserWindow>} document token -> window */
const windows = new Map();

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

  win.setRepresentedFilename(realPath);
  app.addRecentDocument(realPath);
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
 * Shows the Open panel and opens each chosen PDF. Does nothing while the
 * panel is already up, e.g. when the Dock icon is clicked again.
 *
 * @returns {Promise<void>}
 */
export async function showOpenPanel() {
  if (openPanelShown) return;
  openPanelShown = true;
  try {
    const { filePaths } = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
    });
    for (const file of filePaths) openDocument(file);
  } finally {
    openPanelShown = false;
  }
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
