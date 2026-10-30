/**
 * Asks before unsaved changes are lost, when a tab or a window closes, the app
 * quits, the system shuts down, or an update installs (updates.js), the way
 * document apps do on macOS, Windows and Linux. "Unsaved" is a tab's edited
 * state, which bridge.js reports and tabs.js shows.
 *
 * A window, the app, the system or an update asks about each edited tab in
 * turn, and selects it first. Each tab closes once the user has decided about
 * it. Cancel stops there, and leaves the remaining tabs open.
 */
import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import { runCommand } from "./ipc.js";
import * as tabs from "./tabs.js";

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

/** Tabs showing the save prompt. */
const prompting = new WeakSet();

/** Windows asking about their tabs before they close. */
const closingWindows = new WeakSet();

let reviewingQuit = false;

/** Must run once the app is ready, before any window opens. */
export function guardUnsavedChanges() {
  app.on("browser-window-created", (_event, win) => {
    win.on("close", (event) => {
      if (editedTabs([win]).length === 0) return;
      event.preventDefault();
      reviewAndCloseWindow(win);
    });

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
 * Closes a tab, asking first whether to save its changes.
 *
 * @param {tabs.Tab} tab
 * @returns {Promise<boolean>} whether it closed
 */
export async function closeTab(tab) {
  if (!tab.edited) {
    tabs.closeTab(tab);
    return true;
  }
  return reviewAndCloseTab(tab);
}

/**
 * Closes every tab of a window but `keep`, asking about each edited one.
 * Cancel stops there.
 *
 * @param {tabs.Tab} keep
 */
export async function closeOtherTabs(keep) {
  const win = tabs.windowOf(keep);
  if (!win) return;
  for (const tab of tabs.tabsOf(win)) {
    if (tab === keep || !tabs.isOpen(tab)) continue;
    if (!(await closeTab(tab))) return;
  }
  if (tabs.isOpen(keep)) tabs.selectTab(keep);
}

/**
 * Asks about every edited tab in turn, as quitting does, and closes each once
 * the user has decided, but doesn't quit. For installing an update, which
 * quits only once nothing is left to ask about. Cancel stops there.
 *
 * @returns {Promise<boolean>} whether no edited tab is left: false if the
 *   user cancelled or saving failed
 */
export async function reviewUnsavedChanges() {
  for (const tab of editedTabs(BrowserWindow.getAllWindows())) {
    if (!tabs.isOpen(tab)) continue;
    if (!(await reviewAndCloseTab(tab))) return false;
  }
  return true;
}

/**
 * Stops a quit, the end of a Windows session, or a Linux shutdown, while
 * there are edited tabs, and asks about them instead.
 *
 * @param {Electron.Event} event
 */
function reviewBeforeQuitting(event) {
  if (editedTabs(BrowserWindow.getAllWindows()).length === 0) return;
  event.preventDefault();
  reviewAndQuit();
}

/**
 * Asks about each edited tab of a window, then closes it, unless the user
 * cancels or saving fails.
 *
 * @param {BrowserWindow} win
 */
async function reviewAndCloseWindow(win) {
  if (closingWindows.has(win)) return;
  closingWindows.add(win);
  try {
    for (const tab of editedTabs([win])) {
      if (!(await reviewAndCloseTab(tab))) return;
    }
  } finally {
    closingWindows.delete(win);
  }
  if (!win.isDestroyed()) win.close();
}

/**
 * Reviews edited tabs one at a time, then quits. Cancel stops the review and
 * the quit.
 */
async function reviewAndQuit() {
  if (reviewingQuit) return;
  reviewingQuit = true;
  try {
    if (!(await reviewUnsavedChanges())) return;
  } finally {
    reviewingQuit = false;
  }
  app.quit();
}

/**
 * Selects a tab and asks whether to save its changes, then closes it, unless
 * the user cancels or saving fails.
 *
 * @param {tabs.Tab} tab
 * @returns {Promise<boolean>} whether the tab closed
 */
async function reviewAndCloseTab(tab) {
  const win = tabs.windowOf(tab);
  if (!win || prompting.has(tab)) return false;
  prompting.add(tab);
  try {
    if (win.isMinimized()) win.restore();
    win.focus();
    tabs.selectTab(tab);
    const choice = await askToSave(win, tab);
    if (choice === CANCEL) return false;
    if (choice === SAVE && (await runCommand(tab, "save")) !== true) return false;
  } finally {
    prompting.delete(tab);
  }
  if (tabs.isOpen(tab)) tabs.closeTab(tab);
  return true;
}

/**
 * @param {BrowserWindow[]} windows
 * @returns {tabs.Tab[]} their tabs with unsaved changes, window by window
 */
function editedTabs(windows) {
  return windows.flatMap((win) => tabs.tabsOf(win).filter((tab) => tab.edited));
}

/**
 * @param {BrowserWindow} win
 * @param {tabs.Tab} tab
 * @returns {Promise<string>} SAVE, CANCEL or DONT_SAVE
 */
async function askToSave(win, tab) {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message: `Do you want to save the changes made to the document “${tabs.documentName(tab)}”?`,
    detail: "Your changes will be lost if you don’t save them.",
    buttons: BUTTONS,
    defaultId: BUTTONS.indexOf(SAVE),
    cancelId: BUTTONS.indexOf(CANCEL),
    // Windows would otherwise show Save and Don't Save as command links.
    noLink: true,
  });
  return BUTTONS[response] ?? CANCEL;
}
