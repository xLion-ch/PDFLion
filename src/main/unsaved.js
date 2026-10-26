/**
 * Asks before unsaved changes are lost, when a document window closes, the
 * app quits, or the system shuts down, the way document apps do on macOS,
 * Windows and Linux. "Unsaved" is the window's edited state, which bridge.js
 * reports and windows.js shows.
 */
import path from "node:path";
import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import { runCommand } from "./ipc.js";
import { documentFile, isEdited } from "./windows.js";

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

const SAVE = "Save";
const CANCEL = "Cancel";
const DONT_SAVE = "Don’t Save";

/**
 * The save prompt's buttons, in each platform's order. macOS shows the first
 * one rightmost, Windows and GTK leftmost. GNOME puts Save last, rightmost.
 */
const BUTTONS = isMac
  ? [SAVE, CANCEL, DONT_SAVE]
  : isWindows
    ? [SAVE, DONT_SAVE, CANCEL]
    : [DONT_SAVE, CANCEL, SAVE];

/** Windows the user has decided about, which may now close. */
const decided = new WeakSet();

/** Windows showing the save prompt. */
const prompting = new WeakSet();

let reviewingQuit = false;

/** Must run once the app is ready, before any window opens. */
export function guardUnsavedChanges() {
  app.on("browser-window-created", (_event, win) => {
    win.on("close", (event) => {
      if (decided.has(win) || !isEdited(win)) return;
      event.preventDefault();
      reviewAndClose(win);
    });

    // pdf.js's beforeunload handler blocks unloading whenever a document has
    // form data or annotations, even saved ones. The prompts here replace it.
    win.webContents.on("will-prevent-unload", (event) => event.preventDefault());

    // Windows asks each window before it shuts down, restarts or signs out.
    // Holding it off shows "PDFLion is preventing shutdown" while the prompts
    // are up, and the session can end once PDFLion has quit.
    if (isWindows) win.on("query-session-end", reviewBeforeQuitting);
  });

  app.on("before-quit", reviewBeforeQuitting);

  // On Linux, systemd tells apps that it's about to shut down or restart.
  // Holding it off delays the shutdown while the prompts are up, but only for
  // a few seconds (InhibitDelayMaxSec, 5 by default).
  if (isLinux) {
    // Electron 45 sets up powerMonitor when it gets its first listener, and
    // then listens for shutdown only if a "shutdown" listener is already there
    // (lib/browser/api/power-monitor.ts). Node announces a listener before
    // adding it, so a first "shutdown" listener doesn't count, and shutdown
    // would never fire. Another listener has to come first.
    const start = () => {};
    powerMonitor.on("resume", start).off("resume", start);
    powerMonitor.on("shutdown", reviewBeforeQuitting);
  }
}

/**
 * Stops a quit, the end of a Windows session, or a Linux shutdown, while there
 * are edited windows the user hasn't decided about, and asks about them
 * instead.
 *
 * @param {Electron.Event} event
 */
function reviewBeforeQuitting(event) {
  const edited = BrowserWindow.getAllWindows().filter((win) => isEdited(win) && !decided.has(win));
  if (edited.length === 0) return;
  event.preventDefault();
  reviewAndQuit(edited);
}

/**
 * Asks whether to save a window's changes, then closes it, unless the user
 * cancels or saving fails.
 *
 * @param {BrowserWindow} win
 * @returns {Promise<boolean>} whether the window is closing
 */
async function reviewAndClose(win) {
  if (prompting.has(win)) return false;
  prompting.add(win);
  try {
    const choice = await askToSave(win);
    if (choice === CANCEL) return false;
    if (choice === SAVE && (await runCommand(win, "save")) !== true) return false;
  } finally {
    prompting.delete(win);
  }
  decided.add(win);
  win.close();
  return true;
}

/**
 * Reviews edited windows one at a time, then quits. Cancel stops the review
 * and the quit, and leaves the remaining windows open.
 *
 * @param {BrowserWindow[]} windows
 */
async function reviewAndQuit(windows) {
  if (reviewingQuit) return;
  reviewingQuit = true;
  try {
    for (const win of windows) {
      if (win.isDestroyed()) continue;
      if (win.isMinimized()) win.restore();
      win.focus();
      if (!(await reviewAndClose(win))) return;
    }
  } finally {
    reviewingQuit = false;
  }
  app.quit();
}

/**
 * @param {BrowserWindow} win
 * @returns {Promise<string>} SAVE, CANCEL or DONT_SAVE
 */
async function askToSave(win) {
  const name = path.basename(documentFile(win) ?? "");
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message: `Do you want to save the changes made to the document “${name}”?`,
    detail: "Your changes will be lost if you don’t save them.",
    buttons: BUTTONS,
    defaultId: BUTTONS.indexOf(SAVE),
    cancelId: BUTTONS.indexOf(CANCEL),
    // Windows would otherwise show Save and Don't Save as command links.
    noLink: true,
  });
  return BUTTONS[response] ?? CANCEL;
}
