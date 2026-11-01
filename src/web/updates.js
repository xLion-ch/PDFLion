/**
 * The web app's updates, as the desktop's src/main/updates.js does them
 * through electron-updater. A new version is a new sw.js, which the browser
 * installs alongside the running one: the service worker downloads what
 * changed, and keeps the new version waiting (sw.js). The shell then offers
 * it, with Restart Now, Later and Release Notes. Restart Now saves every
 * document and the session first, has the new worker take over, and
 * reloads, and the session brings the tabs back. Later leaves it until
 * nothing runs the old version any more, as when iPadOS has ended the app,
 * and the next launch offers it again if it's still waiting.
 *
 * It checks at launch, when the device comes back online, when the app
 * shows again after a while hidden, and every 6 hours, as the desktop does.
 * Only Check for Updates… says when it can't check, or that there's
 * nothing new.
 */
import {
  LATER,
  RELEASE_NOTES,
  RESTART_NOW,
  updateCheckFailed,
  upToDate,
  webUpdateReady,
} from "../shared/wording.js";
import * as dialogs from "./dialogs.js";

/** Where a release's notes are, by its tag, `v<version>`. */
const RELEASES_URL = "https://github.com/xLion-ch/PDFLion/releases/tag/";

/** How often to check while the app is open, in ms, as on the desktop. */
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/** How long the app must have been hidden to check when it shows again, in ms. */
const HIDDEN_BEFORE_CHECK = 15 * 60 * 1000;

/** How long Restart Now waits for the new version to take over, in ms. */
const RESTART_TIMEOUT = 10_000;

/** How long to wait for a worker to say its version, in ms. */
const VERSION_TIMEOUT = 5_000;

/** @type {ServiceWorkerRegistration} */
let registration;

/** The running version. */
let runningVersion = "";

/**
 * Saves every document and the session, before the page reloads.
 * @type {(ask: boolean) => Promise<boolean>}
 */
let beforeRestart = async () => true;

/** Whether the prompt shows. */
let offering = false;

/** Whether the page is about to reload for a new version. */
let restarting = false;

/** When the app was last hidden, in ms. */
let hiddenAt = 0;

/**
 * Starts checking for updates, and offers one that's waiting already.
 *
 * @param {ServiceWorkerRegistration} serviceWorkerRegistration the shell's,
 *   which controls the page
 * @param {object} options
 * @param {string} options.version the running one
 * @param {(ask: boolean) => Promise<boolean>} options.beforeRestart saves
 *   every document and the session, and answers whether to go ahead, which
 *   it asks about unsaved changes only if `ask` is true
 */
export function followUpdates(serviceWorkerRegistration, options) {
  registration = serviceWorkerRegistration;
  runningVersion = options.version;
  beforeRestart = options.beforeRestart;

  // A new version took over: after Restart Now, or from another of the
  // app's pages. This page's files are the old version's, so it reloads.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (restarting) {
      location.reload();
      return;
    }
    restarting = true;
    beforeRestart(false).finally(() => location.reload());
  });

  registration.addEventListener("updatefound", () => {
    if (registration.installing) offerOnceInstalled(registration.installing);
  });
  if (registration.installing) offerOnceInstalled(registration.installing);
  if (registration.waiting) offer(registration.waiting);

  window.addEventListener("online", check);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
    } else if (hiddenAt > 0 && Date.now() - hiddenAt >= HIDDEN_BEFORE_CHECK) {
      hiddenAt = 0;
      check();
    }
  });
  setInterval(check, CHECK_INTERVAL);
  check();
}

/**
 * An automatic check, which says nothing: a new version, once installed,
 * is offered by the `updatefound` listener.
 */
function check() {
  if (!navigator.onLine || restarting) return;
  registration.update().catch((error) => console.info("PDFLion couldn't check for updates:", error));
}

/**
 * Check for Updates…: offers a new version, also one that's waiting, and
 * says when there's none, or the check failed.
 */
export async function checkForUpdates() {
  if (restarting) return;
  if (registration.waiting) {
    await offer(registration.waiting);
    return;
  }
  try {
    if (!navigator.onLine) throw new Error("The device is offline.");
    await registration.update();
  } catch (error) {
    console.info("PDFLion couldn't check for updates:", error);
    await dialogs.alert(updateCheckFailed());
    return;
  }
  const worker = registration.installing ?? registration.waiting;
  if (!worker) {
    await dialogs.alert(upToDate(runningVersion));
    return;
  }
  if (await installed(worker)) await offer(worker);
  else await dialogs.alert(updateCheckFailed());
}

/** @param {ServiceWorker} worker installing */
function offerOnceInstalled(worker) {
  installed(worker).then((done) => {
    if (done && registration.waiting === worker) offer(worker);
  });
}

/**
 * @param {ServiceWorker} worker
 * @returns {Promise<boolean>} whether it installed, rather than failed
 */
function installed(worker) {
  return new Promise((resolve) => {
    const settle = () => {
      if (worker.state === "installing") return;
      worker.removeEventListener("statechange", settle);
      resolve(worker.state !== "redundant");
    };
    worker.addEventListener("statechange", settle);
    settle();
  });
}

/**
 * The prompt for a new version that's waiting, with Restart Now, Later and
 * Release Notes, which opens the release's page and asks again.
 *
 * @param {ServiceWorker} worker
 */
async function offer(worker) {
  if (offering || restarting) return;
  offering = true;
  /** @type {string} */
  let choice;
  try {
    const version = await versionOf(worker);
    const buttons = version ? [RELEASE_NOTES, LATER, RESTART_NOW] : [LATER, RESTART_NOW];
    do {
      ({ button: choice } = await dialogs.showDialog(webUpdateReady(version), {
        buttons,
        defaultButton: RESTART_NOW,
        cancelButton: LATER,
      }));
      // A link built from the version, which the new worker says, rather
      // than from anything a release says.
      if (choice === RELEASE_NOTES) {
        window.open(RELEASES_URL + encodeURIComponent(`v${version}`), "_blank", "noopener");
      }
    } while (choice === RELEASE_NOTES);
  } finally {
    offering = false;
  }
  if (choice === RESTART_NOW) await restart(worker);
}

/**
 * Restart Now: saves everything, asking about changes that couldn't be,
 * then has the new version take over, which reloads the page.
 *
 * @param {ServiceWorker} worker waiting
 */
async function restart(worker) {
  if (restarting) return;
  restarting = true;
  if (!(await beforeRestart(true))) {
    restarting = false;
    return;
  }
  worker.postMessage("skipWaiting");
  // If it never takes over, as when an even newer version replaced it.
  setTimeout(() => location.reload(), RESTART_TIMEOUT);
}

/**
 * @param {ServiceWorker} worker
 * @returns {Promise<string | null>} its version, as it says it, or null if
 *   it doesn't
 */
function versionOf(worker) {
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), VERSION_TIMEOUT);
    port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      port1.close();
      resolve(typeof data === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(data) ? data : null);
    };
    worker.postMessage("version", [port2]);
  });
}
