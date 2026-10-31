/**
 * App lifecycle and the ways documents come in. On every platform each
 * document gets its own tab, in the frontmost window, and Home shows when no
 * document does. On macOS the app keeps running after its last window closes,
 * until the user quits with Cmd+Q. On Windows and Linux it quits with its last
 * window, and a single process shows every document.
 */
import { app, BrowserWindow } from "electron";
import { commandLineFiles, secondInstanceFiles } from "./arguments.js";
import { handleHome } from "./home.js";
import { handleIpc } from "./ipc.js";
import { installMenu } from "./menu.js";
import { handlePermissions } from "./permissions.js";
import { handleProtocol, registerScheme } from "./protocol.js";
import { handleStrip } from "./strip.js";
import { handleToolSettings } from "./toolsettings.js";
import { guardUnsavedChanges } from "./unsaved.js";
import { isRestartingForUpdate, startUpdates } from "./updates.js";
import { openDocument, openDocuments, showHome } from "./windows.js";

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

/**
 * The bundle ID, electron-builder's `appId`. Keep the two in sync. On Windows
 * the installer gives its shortcuts this AppUserModelID, and the taskbar only
 * groups windows with a pinned or Start menu shortcut, and shows the recent
 * files in its jump list, if the process has the same ID. Electron's default
 * is `electron.app.PDFLion`.
 */
const APP_ID = "io.github.xlion-ch.pdflion";

/**
 * Files macOS asked to open before the app was ready, or null once it is.
 * @type {string[] | null}
 */
let openFileQueue = [];

// Every renderer is sandboxed, not only windows whose webPreferences say so.
app.enableSandbox();
registerScheme();

// npm runs scripts from the package root, so relative paths resolve against
// the directory npm was started in.
const launchFiles = commandLineFiles(process.argv, {
  defaultApp: process.defaultApp ?? false,
  cwd: process.env.INIT_CWD ?? process.cwd(),
});

// On Windows and Linux, opening a PDF from Explorer or a file manager starts
// another PDFLion process. It hands its files to the one already running and
// quits. macOS sends open-file to the running app instead.
if (isMac || app.requestSingleInstanceLock({ files: launchFiles })) {
  start();
} else {
  app.quit();
}

function start() {
  if (isWindows) app.setAppUserModelId(APP_ID);

  // macOS sends open-file during launch, before `ready`, when the app is
  // started by opening a document from Finder.
  app.on("open-file", (event, file) => {
    event.preventDefault();
    if (openFileQueue) openFileQueue.push(file);
    else openDocument(file);
  });

  // Windows and Linux, and always after `ready`. Chromium may reorder and add
  // to the second process's argv, so its files come as additionalData. A
  // second launch without files brings the front window forward with Home.
  app.on("second-instance", (_event, _argv, _workingDirectory, data) => {
    const files = secondInstanceFiles(data);
    if (files.length === 0) showHome();
    else openDocuments(files);
  });

  // Without a listener, Electron quits when the last window closes. Mac apps
  // keep running, Windows and Linux apps quit, but not while an update's
  // Restart Now closes them: it quits by itself.
  app.on("window-all-closed", () => {
    if (!isMac && !isRestartingForUpdate()) app.quit();
  });

  app.whenReady().then(() => {
    handlePermissions();
    handleProtocol();
    handleIpc();
    handleHome();
    handleStrip();
    handleToolSettings();
    guardUnsavedChanges();
    installMenu();
    startUpdates();

    const files = [...openFileQueue, ...launchFiles];
    openFileQueue = null;
    // A launch without a document shows Home, and so does one whose files
    // couldn't be read, once it has said so.
    openDocuments(files).finally(() => {
      if (BrowserWindow.getAllWindows().length === 0) showHome();
    });

    // Clicking the Dock icon with no windows open.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) showHome();
    });
  });
}
