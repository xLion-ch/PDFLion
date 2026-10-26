/**
 * Messages between main and the viewer's preload. Viewer windows display
 * untrusted PDFs, so every incoming message is checked for its sender and its
 * payload before main acts on it.
 *
 * The channel names are repeated in src/preload/preload.cjs, which can't
 * import this module.
 */
import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { isViewerUrl } from "./routes.js";
import { saveDocument, saveDocumentAs } from "./saving.js";
import { openDocument } from "./windows.js";

/** More than anyone drops at once, and few enough to open as windows. */
const MAX_DROPPED_FILES = 100;

/** macOS's PATH_MAX. */
const MAX_PATH_LENGTH = 1024;

/** Larger than any PDF pdf.js can hold in memory. */
const MAX_DOCUMENT_BYTES = 2 ** 31;

/**
 * Commands sent with runCommand() and waiting for bridge.js to finish them.
 * @type {Map<number, { webContents: Electron.WebContents, settle: (result: unknown) => void }>}
 */
const pendingCommands = new Map();
let lastCommandId = 0;

/** Must run once the app is ready, before any window loads. */
export function handleIpc() {
  ipcMain.on("pdflion:open-files", (event, paths) => {
    if (!fromViewer(event) || !isPathList(paths)) return;
    for (const file of paths) openDocument(file);
  });

  ipcMain.on("pdflion:set-edited", (event, edited) => {
    if (!fromViewer(event) || typeof edited !== "boolean") return;
    BrowserWindow.fromWebContents(event.sender)?.setDocumentEdited(edited);
  });

  ipcMain.handle("pdflion:save", (event, bytes) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !fromViewer(event) || !isDocumentBytes(bytes)) return null;
    return saveDocument(win, bytes);
  });

  ipcMain.handle("pdflion:save-as", (event, bytes) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !fromViewer(event) || !isDocumentBytes(bytes)) return null;
    return saveDocumentAs(win, bytes);
  });

  ipcMain.on("pdflion:command-done", (event, id, result) => {
    const pending = pendingCommands.get(id);
    if (pending?.webContents === event.sender && fromViewer(event)) pending.settle(result);
  });
}

/**
 * Runs a menu command, such as `zoomIn`, in a window's bridge.js.
 *
 * @param {BrowserWindow} win
 * @param {string} command
 * @returns {Promise<unknown>} what the command returned, e.g. whether `save`
 *   saved, or null if the window went away first
 */
export function runCommand(win, command) {
  const { webContents } = win;
  const id = ++lastCommandId;
  return new Promise((resolve) => {
    const gone = () => settle(null);
    /** @param {unknown} result */
    const settle = (result) => {
      pendingCommands.delete(id);
      webContents.off("destroyed", gone).off("render-process-gone", gone);
      resolve(result);
    };
    pendingCommands.set(id, { webContents, settle });
    webContents.once("destroyed", gone).once("render-process-gone", gone);
    webContents.send("pdflion:command", id, command);
  });
}

/**
 * Whether a message comes from the top frame of a page showing the viewer.
 *
 * @param {Electron.IpcMainEvent | Electron.IpcMainInvokeEvent} event
 * @returns {boolean}
 */
function fromViewer(event) {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && isViewerUrl(frame.url);
}

/**
 * @param {unknown} paths
 * @returns {paths is string[]}
 */
function isPathList(paths) {
  return (
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.length <= MAX_DROPPED_FILES &&
    paths.every(
      (file) =>
        typeof file === "string" &&
        file.length <= MAX_PATH_LENGTH &&
        !file.includes("\0") &&
        path.isAbsolute(file),
    )
  );
}

/**
 * @param {unknown} bytes
 * @returns {bytes is Uint8Array}
 */
function isDocumentBytes(bytes) {
  return bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_DOCUMENT_BYTES;
}
