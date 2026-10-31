/**
 * Updates from PDFLion's GitHub releases, through electron-updater. CI makes
 * a release of every push to main, with the update files electron-builder
 * writes next to the installers (latest.yml, latest-linux.yml). The packaged
 * app checks 10 s after launch and every 6 hours, while automatic checks are
 * on, downloads a newer release in the background, checks its SHA-512 against
 * those files, and asks whether to restart now.
 *
 * - macOS: Squirrel.Mac, Electron's own updater, installs the .zip when
 *   PDFLion quits, or at once with Restart Now. It takes the update from
 *   electron-updater, and only if it satisfies the running app's designated
 *   requirement, which scripts/after-sign.js makes the bundle ID.
 * - Windows: the NSIS installer installs it silently, for the user, when
 *   PDFLion quits, or at once with Restart Now.
 * - Linux: dpkg installs the .deb, through pkexec, which asks for an
 *   administrator's password. So only Restart Now installs it, never a quit or
 *   a shutdown.
 *
 * Releases have no signature, so whoever can publish one on xLion-ch/PDFLion
 * can run code on every installed copy. The checks are PDFLion's only network
 * requests of its own, and tell GitHub the IP address of each copy, nothing
 * more.
 *
 * In the dev app, updates are off unless an end-to-end test points it at a
 * local feed with --pdflion-update-config=<app-update.yml>. The packaged app
 * ignores that switch, so nothing on its command line can redirect them.
 */
import { app, autoUpdater as squirrel, BrowserWindow, dialog, shell } from "electron";
import {
  LATER,
  RELEASE_NOTES,
  RESTART_NOW,
  updateCheckFailed,
  updateDownloadFailed,
  updateNotInstallable,
  updateNotInstalled,
  updateOnReadOnlyVolume,
  updateReady,
  upToDate,
} from "../shared/wording.js";
import { getState, setState } from "./state.js";
import { reviewUnsavedChanges } from "./unsaved.js";

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

const RELEASES_URL = "https://github.com/xLion-ch/PDFLion/releases/tag/";

const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const STATE_KEY = "updates";

/**
 * How this copy updates, for the texts about it: where Check for Updates… is,
 * in the app menu on macOS, and whether installing asks for a password.
 * @type {import("../shared/wording.js").UpdateHost}
 */
const HOST = {
  checkForUpdates: isMac ? "PDFLion > Check for Updates…" : "Help > Check for Updates…",
  needsPassword: isLinux,
};

/**
 * Squirrel.Mac's error for an app it can't replace: on a disk image, or in
 * Downloads, where macOS runs a downloaded app from a read-only copy.
 */
const READ_ONLY_VOLUME = /read-only volume/i;

/**
 * The ready prompt's buttons in each platform's order, as the save prompt's in
 * unsaved.js: Restart Now where Save goes, Later where Cancel goes.
 */
const BUTTONS = isMac
  ? [RESTART_NOW, LATER, RELEASE_NOTES]
  : isWindows
    ? [RESTART_NOW, RELEASE_NOTES, LATER]
    : [RELEASE_NOTES, LATER, RESTART_NOW];

/** An app-update.yml for a local feed, which only the dev app reads. */
const testConfig = app.isPackaged ? "" : app.commandLine.getSwitchValue("pdflion-update-config");

/**
 * Whether this copy of PDFLion updates itself: a packaged build, or the dev
 * app pointed at a local feed.
 */
export const hasUpdater = app.isPackaged || testConfig !== "";

/** @type {Promise<import("electron-updater").AppUpdater> | undefined} */
let updaterPromise;

/** @type {NodeJS.Timeout | undefined} */
let checkTimer;

/** Versions the user chose Later for, which only the menu offers again. */
const postponed = new Set();

/** Whether a check from the menu runs, which offers what it finds itself. */
let checkingFromMenu = false;

/** Whether the ready prompt shows. */
let offering = false;

/** Whether Restart Now asks about unsaved changes, or installs. */
let restarting = false;

/** macOS: the version electron-updater last handed to Squirrel.Mac. */
let handedOver = "";

/** macOS: whether Squirrel.Mac has that version, checked and ready to install. */
let squirrelReady = false;

/** Must run once the app is ready, before any window opens. */
export function startUpdates() {
  if (!hasUpdater) return;
  scheduleChecks();

  // A quit at the end of a Windows session would start the installer while
  // Windows ends every process, which could leave PDFLion half installed. So
  // once Windows asks to end the session, quitting installs nothing. Restart
  // Now still does, and the next launch offers the update again.
  if (isWindows) {
    app.on("browser-window-created", (_event, win) => {
      const skipInstalling = () => {
        updaterPromise?.then((updater) => (updater.autoInstallOnAppQuit = false));
      };
      win.on("query-session-end", skipInstalling).on("session-end", skipInstalling);
    });
  }
}

/** @returns {boolean} whether PDFLion checks for updates by itself */
export function automaticChecks() {
  const stored = /** @type {{ automatic?: unknown } | undefined} */ (getState(STATE_KEY));
  return stored?.automatic !== false;
}

/**
 * @param {boolean} automatic which the menu's checkbox or an import of
 *   settings sets, also where PDFLion doesn't update itself
 */
export function setAutomaticChecks(automatic) {
  setState(STATE_KEY, { automatic });
  if (hasUpdater) scheduleChecks();
}

/**
 * Whether Restart Now is underway: Windows and Linux then wait for it to quit,
 * rather than quitting when the save prompts close the last window.
 */
export function isRestartingForUpdate() {
  return restarting;
}

/**
 * Check for Updates…: checks, downloads what it finds, and offers it, also a
 * version the user chose Later for. Unlike an automatic check, it says when
 * PDFLion is up to date, and when the check, the download or, on macOS,
 * handing the update to Squirrel.Mac failed.
 */
export async function checkForUpdates() {
  if (!hasUpdater || checkingFromMenu) return;
  checkingFromMenu = true;
  /** @type {import("electron-updater").UpdateCheckResult | null} */
  let result;
  try {
    try {
      result = await (await getUpdater()).checkForUpdates();
    } catch {
      await showMessage({ type: "warning", ...updateCheckFailed() });
      return;
    }
    if (!result?.isUpdateAvailable) {
      await showMessage({ type: "info", ...upToDate(app.getVersion()) });
      return;
    }
    const { version } = result.updateInfo;
    try {
      await result.downloadPromise;
      if (isMac) await whenSquirrelReady();
    } catch (error) {
      // On macOS, an error after electron-updater handed the update over is
      // Squirrel.Mac's.
      await showMessage(
        isMac && handedOver === version
          ? squirrelFailed(version, /** @type {Error} */ (error))
          : { type: "warning", ...updateDownloadFailed(version) },
      );
      return;
    }
  } finally {
    checkingFromMenu = false;
  }
  await offer(result.updateInfo.version);
}

/** Checks 10 s from now and every 6 hours after, while automatic checks are on. */
function scheduleChecks() {
  clearTimeout(checkTimer);
  if (!automaticChecks()) return;
  const check = () => {
    checkInBackground();
    checkTimer = setTimeout(check, CHECK_INTERVAL_MS);
  };
  checkTimer = setTimeout(check, FIRST_CHECK_DELAY_MS);
}

/**
 * An automatic check, which says nothing unless an update has downloaded.
 * The update-downloaded listener offers it.
 */
async function checkInBackground() {
  try {
    const result = await (await getUpdater()).checkForUpdates();
    await result?.downloadPromise;
  } catch {
    // electron-updater logs it.
  }
}

/** @returns {Promise<import("electron-updater").AppUpdater>} */
function getUpdater() {
  updaterPromise ??= createUpdater();
  return updaterPromise;
}

/**
 * Loads electron-updater only once it's needed. It's CommonJS, so its
 * classes come from its default export.
 *
 * @returns {Promise<import("electron-updater").AppUpdater>}
 */
async function createUpdater() {
  const { default: updaterModule } = await import("electron-updater");
  // Not its autoUpdater, which picks the Linux updater by the package-type
  // file only the .deb has, and would be the AppImage one in the dev app.
  const updater = isMac
    ? new updaterModule.MacUpdater()
    : isWindows
      ? new updaterModule.NsisUpdater()
      : new updaterModule.DebUpdater();
  updater.autoDownload = true;
  updater.allowDowngrade = false;
  // electron-updater allows them while the running version is one, as a pull
  // request's build is.
  updater.allowPrerelease = false;
  // On macOS also what makes electron-updater hand the update to Squirrel.Mac
  // as soon as it has it, rather than at Restart Now.
  updater.autoInstallOnAppQuit = !isLinux;
  updater.disableWebInstaller = true;
  // electron-updater sends every check a random ID it keeps in userData, for
  // rolling out releases in stages, which PDFLion's don't. GitHub would see
  // the same ID from each copy wherever it is.
  updater.requestHeaders = { "x-user-staging-id": "" };
  if (testConfig) {
    updater.forceDevUpdateConfig = true;
    updater.updateConfigPath = testConfig;
  }

  if (isMac) {
    // electron-updater's update-downloaded comes once it has the zip. Then
    // Squirrel.Mac fetches it from electron-updater's proxy and checks it
    // against the running app's designated requirement, and on a read-only
    // volume it refuses. Only its own update-downloaded means the update can
    // install, about a second later. electron-updater's MacUpdater listens
    // before this does, so it knows by then too.
    updater.on("update-downloaded", ({ version }) => {
      handedOver = version;
      squirrelReady = false;
    });
    squirrel.on("update-downloaded", () => {
      squirrelReady = true;
      if (!checkingFromMenu && !postponed.has(handedOver)) offer(handedOver);
    });
  } else {
    updater.on("update-downloaded", ({ version }) => {
      if (!checkingFromMenu && !postponed.has(version)) offer(version);
    });
  }
  return updater;
}

/**
 * macOS: resolves once Squirrel.Mac has the update electron-updater handed it,
 * and rejects with Squirrel's error.
 *
 * @returns {Promise<void>}
 */
function whenSquirrelReady() {
  if (squirrelReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ready = () => {
      squirrel.off("error", fail);
      resolve();
    };
    /** @param {Error} error */
    const fail = (error) => {
      squirrel.off("update-downloaded", ready);
      reject(error);
    };
    squirrel.once("update-downloaded", ready).once("error", fail);
  });
}

/**
 * macOS: what to say when Squirrel.Mac refused an update.
 *
 * @param {string} version
 * @param {Error} error
 * @returns {Electron.MessageBoxOptions}
 */
function squirrelFailed(version, error) {
  if (READ_ONLY_VOLUME.test(String(error?.message))) {
    return { type: "warning", ...updateOnReadOnlyVolume(version, HOST) };
  }
  return { type: "warning", ...updateNotInstallable(version) };
}

/**
 * Asks whether to install a downloaded update now. Release Notes opens the
 * release on GitHub and asks again.
 *
 * @param {string} version
 */
async function offer(version) {
  if (offering || restarting) return;
  offering = true;
  let choice;
  try {
    do {
      const { response } = await showMessage({
        type: "info",
        ...updateReady(version, HOST),
        buttons: BUTTONS,
        defaultId: BUTTONS.indexOf(RESTART_NOW),
        cancelId: BUTTONS.indexOf(LATER),
        noLink: true,
      });
      choice = BUTTONS[response] ?? LATER;
      // A link built from the version, which electron-updater has checked,
      // rather than one from the release's text.
      if (choice === RELEASE_NOTES) {
        shell.openExternal(RELEASES_URL + encodeURIComponent(`v${version}`));
      }
    } while (choice === RELEASE_NOTES);
  } finally {
    offering = false;
  }
  if (choice === LATER) postponed.add(version);
  else await restart(version);
}

/**
 * Restart Now: asks about every edited tab, as quitting does, then installs
 * and quits, and relaunches the new version. electron-updater's
 * quitAndInstall() can't be taken back: on Windows it starts the installer
 * before quitting, and on macOS Squirrel.Mac closes every window, then quits
 * once they're closed, so the prompts come first.
 *
 * @param {string} version
 */
async function restart(version) {
  if (restarting) return;
  restarting = true;
  if (!(await reviewUnsavedChanges())) {
    restarting = false;
    return;
  }
  if (await install()) return;
  restarting = false;
  await showMessage({ type: "warning", ...updateNotInstalled(version, HOST) });
  // On Windows and Linux, the save prompts may have closed every window.
  if (!isMac && BrowserWindow.getAllWindows().length === 0) app.quit();
}

/**
 * @returns {Promise<boolean>} whether installing started, and PDFLion quits.
 *   False if it failed, as when the password prompt was cancelled on Linux,
 *   which electron-updater reports as an error while quitAndInstall() runs.
 */
async function install() {
  const updater = await getUpdater();
  let failed = false;
  const fail = () => (failed = true);
  updater.on("error", fail);
  try {
    // Silently, and start the new version.
    updater.quitAndInstall(true, true);
  } finally {
    updater.off("error", fail);
  }
  return !failed;
}

/**
 * Attached to the focused window, if there is one.
 *
 * @param {Electron.MessageBoxOptions} options
 * @returns {Promise<Electron.MessageBoxReturnValue>}
 */
function showMessage(options) {
  const win = BrowserWindow.getFocusedWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}
