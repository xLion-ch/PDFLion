/**
 * App lifecycle and the ways documents come in. On both platforms each
 * document gets its own window. On macOS the app keeps running after its last
 * window closes, until the user quits with Cmd+Q. On Windows it quits with its
 * last window, and a single process shows every document.
 */
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { handleIpc } from "./ipc.js";
import { installMenu } from "./menu.js";
import { handlePermissions } from "./permissions.js";
import { handleProtocol, registerScheme } from "./protocol.js";
import { guardUnsavedChanges } from "./unsaved.js";
import { openDocument, showOpenPanel } from "./windows.js";

const isMac = process.platform === "darwin";

/**
 * The bundle ID, electron-builder's `appId`. Keep the two in sync. On Windows
 * the installer gives its shortcuts this AppUserModelID, and the taskbar only
 * groups windows with a pinned or Start menu shortcut, and shows the recent
 * files in its jump list, if the process has the same ID. Electron's default
 * is `electron.app.PDFLion`.
 */
const APP_ID = "io.github.c14ud3.pdflion";

/**
 * Files macOS asked to open before the app was ready, or null once it is.
 * @type {string[] | null}
 */
let openFileQueue = [];

// Every renderer is sandboxed, not only windows whose webPreferences say so.
app.enableSandbox();
registerScheme();

const launchFiles = commandLineFiles();

// On Windows, opening a PDF from Explorer starts another PDFLion process. It
// hands its files to the one already running and quits. macOS sends open-file
// to the running app instead.
if (isMac || app.requestSingleInstanceLock({ files: launchFiles })) {
  start();
} else {
  app.quit();
}

function start() {
  if (!isMac) app.setAppUserModelId(APP_ID);

  // macOS sends open-file during launch, before `ready`, when the app is
  // started by opening a document from Finder.
  app.on("open-file", (event, file) => {
    event.preventDefault();
    if (openFileQueue) openFileQueue.push(file);
    else openDocument(file);
  });

  // Windows only, and always after `ready`. Chromium may reorder and add to
  // the second process's argv, so its files come as additionalData.
  app.on("second-instance", (_event, _argv, _workingDirectory, data) => {
    const files = secondInstanceFiles(data);
    if (files.length === 0) showOpenPanel();
    for (const file of files) openDocument(file);
  });

  // Without a listener, Electron quits when the last window closes. Mac apps
  // keep running, Windows apps quit.
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  app.whenReady().then(() => {
    handlePermissions();
    handleProtocol();
    handleIpc();
    guardUnsavedChanges();
    installMenu();

    const files = [...openFileQueue, ...launchFiles];
    openFileQueue = null;
    // Like Preview, a launch without a document shows the Open panel.
    const opening =
      files.length === 0 ? showOpenPanel() : Promise.all(files.map((file) => openDocument(file)));
    // A Windows app has no Dock to wait in. If the launch opened no window,
    // because the panel was cancelled or no file could be read, quit.
    if (!isMac) {
      opening.finally(() => {
        if (BrowserWindow.getAllWindows().length === 0) app.quit();
      });
    }

    // Clicking the Dock icon with no windows open.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) showOpenPanel();
    });
  });
}

/**
 * Files named on the command line, as in `npm start -- file.pdf`, or the file
 * Windows Explorer opens with PDFLion. Under `electron .` the first two
 * arguments are Electron and the app path. npm runs scripts from the package
 * root, so relative paths resolve against the directory npm was started in.
 *
 * @returns {string[]}
 */
function commandLineFiles() {
  const cwd = process.env.INIT_CWD ?? process.cwd();
  return process.argv
    .slice(process.defaultApp ? 2 : 1)
    .filter((arg) => !arg.startsWith("-"))
    .map((arg) => path.resolve(cwd, arg));
}

/**
 * @param {unknown} data what a second instance passed to
 *   requestSingleInstanceLock()
 * @returns {string[]} the files on its command line
 */
function secondInstanceFiles(data) {
  const files = /** @type {{ files?: unknown } | null} */ (data)?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((file) => typeof file === "string" && path.isAbsolute(file));
}
