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
import { openDocument } from "./windows.js";

/** More than anyone drops at once, and few enough to open as windows. */
const MAX_DROPPED_FILES = 100;

/** macOS's PATH_MAX. */
const MAX_PATH_LENGTH = 1024;

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
}

/**
 * Runs a menu command, such as `zoomIn`, in a window's bridge.js.
 *
 * @param {BrowserWindow} win
 * @param {string} command
 */
export function sendCommand(win, command) {
  win.webContents.send("pdflion:command", command);
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
