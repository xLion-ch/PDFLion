/**
 * Messages between main and the viewer's preload. Tabs display untrusted
 * PDFs, so every incoming message is checked for its sender and its payload
 * before main acts on it. strip.js handles the tab strip's messages.
 *
 * The channel names are repeated in src/preload/preload.cjs, which can't
 * import this module.
 */
import path from "node:path";
import { ipcMain } from "electron";
import { isViewerUrl } from "./routes.js";
import { saveDocument, saveDocumentAs } from "./saving.js";
import * as tabs from "./tabs.js";
import { openDocuments } from "./windows.js";

/** More than anyone drops at once, and few enough to open as tabs. */
const MAX_DROPPED_FILES = 100;

/** Windows' longest path. macOS's PATH_MAX is 1024. */
const MAX_PATH_LENGTH = 32767;

/** Larger than any PDF pdf.js can hold in memory. */
const MAX_DOCUMENT_BYTES = 2 ** 31;

/**
 * Commands whose pdf.js call the page may only make in response to the user,
 * such as requestFullscreen() for Presentation Mode. A shortcut reaches the
 * page before the menu and counts, but a click on the native menu doesn't.
 */
const COMMANDS_NEEDING_ACTIVATION = new Set(["presentation"]);

/**
 * Commands sent with runCommand() and waiting for bridge.js to finish them.
 * @type {Map<number, { webContents: Electron.WebContents, settle: (result: unknown) => void }>}
 */
const pendingCommands = new Map();
let lastCommandId = 0;

/** Must run once the app is ready, before any window loads. */
export function handleIpc() {
  // PDFs dropped on a document open as tabs of its window.
  ipcMain.on("pdflion:open-files", (event, paths) => {
    const tab = tabs.fromWebContents(event.sender);
    if (!tab || !fromViewer(event) || !isPathList(paths)) return;
    openDocuments(paths, tabs.windowOf(tab) ?? undefined);
  });

  ipcMain.on("pdflion:set-edited", (event, edited) => {
    const tab = tabs.fromWebContents(event.sender);
    if (!tab || !fromViewer(event) || typeof edited !== "boolean") return;
    tabs.setEdited(tab, edited);
  });

  ipcMain.handle("pdflion:save", (event, bytes) => {
    const tab = tabs.fromWebContents(event.sender);
    if (!tab || !fromViewer(event) || !isDocumentBytes(bytes)) return null;
    return saveDocument(tab, bytes);
  });

  ipcMain.handle("pdflion:save-as", (event, bytes) => {
    const tab = tabs.fromWebContents(event.sender);
    if (!tab || !fromViewer(event) || !isDocumentBytes(bytes)) return null;
    return saveDocumentAs(tab, bytes);
  });

  ipcMain.on("pdflion:command-done", (event, id, result) => {
    const pending = pendingCommands.get(id);
    if (pending?.webContents === event.sender && fromViewer(event)) pending.settle(result);
  });
}

/**
 * Runs a menu command, such as `zoomIn`, in a tab's bridge.js.
 *
 * @param {tabs.Tab} tab
 * @param {string} command
 * @returns {Promise<unknown>} what the command returned, e.g. whether `save`
 *   saved, or null if the tab went away first
 */
export async function runCommand(tab, command) {
  const { webContents } = tab;
  if (webContents.isDestroyed()) return null;
  if (COMMANDS_NEEDING_ACTIVATION.has(command)) {
    // Runs nothing, but as a user gesture, which gives the page activation.
    await webContents.executeJavaScript("void 0", true).catch(() => {});
  }
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
export function fromViewer(event) {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && isViewerUrl(frame.url);
}

/**
 * Only `.pdf` files: the preloads send only files Chromium types as
 * `application/pdf`, which it does by their extension.
 *
 * @param {unknown} paths
 * @returns {paths is string[]}
 */
export function isPathList(paths) {
  return (
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.length <= MAX_DROPPED_FILES &&
    paths.every(
      (file) =>
        typeof file === "string" &&
        file.length <= MAX_PATH_LENGTH &&
        !file.includes("\0") &&
        path.isAbsolute(file) &&
        path.extname(file).toLowerCase() === ".pdf",
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
