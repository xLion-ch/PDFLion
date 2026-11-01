/**
 * The web app's shell, its page: it does in the browser what the desktop's
 * main process does. It shows the tab strip (src/tabs/tabs.js, through
 * `window.pdflionTabs`) and each tab as a frame, the viewer's or Home's, and
 * keeps the library (library.js), the tool settings, and the shortcuts. Each
 * frame's host (viewer-host.js, home-host.js) talks to it over a
 * MessagePort, in the shape of the desktop's IPC, and the shell checks what
 * comes in with the modules main uses: tools.js, thumbnail.js, and
 * wording.js's isPageDialog().
 *
 * The frames share the shell's origin, so the messages give the code its
 * shape, not a security boundary.
 *
 * Documents save by themselves (bridge.js's autosave) into the library,
 * which leaves the files they came from as they were, so the shell says so,
 * and Share sends a document elsewhere.
 *
 * iPadOS limits a web app's memory, and each frame runs its own pdf.js, so
 * only the documents shown last keep their frames: the others sleep, saved,
 * and load again where they were once they're shown. The open tabs are kept
 * in the library (session.js), since iPadOS ends a suspended web app without
 * warning, and come back at the next launch. New versions come through the
 * service worker (updates.js).
 */
import { blankPdf, paperSize } from "../shared/blank.js";
import { CREDITS } from "../shared/credits.js";
import { isThumbnail } from "../shared/thumbnail.js";
import { TabList } from "../shared/tablist.js";
import {
  changeToolSettings,
  parseFavourite,
  parseToolSettings,
  readToolSettings,
  removeFavourite,
} from "../shared/tools.js";
import {
  CLOSE,
  DELETE,
  OK,
  RENAME,
  RESTART_NOW,
  SHARE,
  closeUnsavedPrompt,
  closedNotInFiles,
  deletePrompt,
  formatSize,
  isPageDialog,
  notAPdf,
  notInFilesExplanation,
  notInFilesLabel,
  openError,
  pageDialog,
  renamePrompt,
  restartUnsavedPrompt,
  saveError,
  savedNotInFiles,
  savedNow,
  shareError,
  shareReady,
  webAppNotDownloaded,
  webAppUnavailable,
} from "../shared/wording.js";
import { exportBackup, importFile } from "./backup.js";
import * as dialogs from "./dialogs.js";
import { Library, cleanName, freeName, hasPdfHeader, isDocumentId, isNotInFiles } from "./library.js";
import { parseSession, parseView, viewHash } from "./session.js";
import { checkForUpdates, followUpdates } from "./updates.js";
import { PDFJS_VERSION, VERSION } from "./version.js";

/** @typedef {import("./library.js").DocumentRecord} DocumentRecord */
/** @typedef {import("../shared/tools.js").ToolSettings} ToolSettings */
/** @typedef {import("./session.js").View} View */
/** @typedef {import("./session.js").Session} Session */

/** The one window, as the desktop's tablist.js counts them. */
const WINDOW = 0;

/** The app's folder, where the shell is. */
const BASE = new URL(".", location.href);
const VIEWER_PAGE = new URL("viewer/web/viewer.html", BASE);
const HOME_PAGE = new URL("home/home.html", BASE);

/** Where the service worker serves the library's documents: `doc/<id>/<name>`. */
const DOCUMENTS_PATH = new URL("doc/", BASE).pathname;

/** More than anyone opens at once, and few enough to open as tabs. */
const MAX_FILES = 100;

/** Larger than any PDF pdf.js can hold in memory. */
const MAX_DOCUMENT_BYTES = 2 ** 31;

/** How long closing a tab waits for its document to save, in ms. */
const CLOSE_SAVE_TIMEOUT = 60_000;

/**
 * How many documents keep their frames loaded. The others sleep. A guess
 * until it's tried on an iPad, whose memory decides it.
 */
const MAX_LOADED_DOCUMENTS = 4;

/**
 * How long the session waits to be stored after a document's view changed,
 * in ms, since it changes with every scroll. Other changes are stored at
 * once.
 */
const VIEW_DELAY = 1000;

/** Which modifier the shortcuts use here: ⌘ on Apple's keyboards. */
const commandKey = PDFLionKeys.commandKeyHere();

/**
 * @typedef {object} Tab
 * @property {string} id random, as on the desktop
 * @property {"document" | "home"} kind
 * @property {string | null} documentId the library's, for a document
 * @property {string} name what the strip shows
 * @property {HTMLIFrameElement | null} frame the viewer or Home, or null
 *   while the tab sleeps
 * @property {MessagePort | null} port to the frame's host, once it has connected
 * @property {View | null} view where the document was, as its viewer last
 *   said, which it loads at after sleeping or a launch
 * @property {number} shownAt when it was last shown, by a count of tabs shown
 * @property {boolean} sleeping whether it's saving before it sleeps
 * @property {boolean} edited whether the document has changes that aren't
 *   stored yet
 * @property {boolean} closing
 * @property {boolean} saveFailed whether its last save failed, which an
 *   alert said
 */

const tabList = new TabList();

/** @type {Map<string, Tab>} by id */
const tabs = new Map();

/** @type {Library} */
let library;

/** @type {ToolSettings} */
let toolSettings;

/** Documents the user heard this session were saved but aren't in Files. */
const toldNotInFiles = new Set();

/** Whether the user ever heard what saving in PDFLion means. */
let explained = false;

/**
 * Commands sent to the frames' bridge.js, waiting for it to finish them.
 * @type {Map<number, { tab: Tab, settle: (result: unknown) => void }>}
 */
const pendingCommands = new Map();
let lastCommand = 0;

/**
 * Each thumbnail's version, by document id, so that Home makes a new URL
 * only for a new thumbnail.
 * @type {Map<string, number>}
 */
const thumbnailVersions = new Map();

/** @type {((tabs: object[]) => void) | null} tabs.js's */
let stripListener = null;

/** Where the strip's last context menu was asked for. */
let stripMenuAt = { x: 0, y: 0 };

/** Whether an update of every Home is on its way. */
let updatingHomes = false;

/** How many times a tab was shown, for the tabs' `shownAt`. */
let shownCount = 0;

/** Whether the session is stored with each change, once it's restored. */
let keepingSession = false;

/** @type {ReturnType<typeof setTimeout> | null} the session's next storing */
let sessionTimer = null;

/** When the session is next stored, in ms. */
let sessionDue = 0;

const frames = /** @type {HTMLElement} */ (document.getElementById("frames"));

// The shell runs only as the page itself, never in another's frame, since a
// `<meta>` CSP can't set frame-ancestors.
if (window.top === window) {
  window.pdflionTabs = stripApi();
  // The strip, once the API it uses is there.
  const strip = document.createElement("script");
  strip.src = new URL("tabs/tabs.js", BASE).href;
  document.head.append(strip);
  window.addEventListener("message", connect);
  start().catch((error) => {
    console.error("PDFLion couldn't start:", error);
    dialogs.alert(
      error instanceof DownloadError
        ? webAppNotDownloaded()
        : webAppUnavailable(String(error?.message ?? error)),
    );
  });
} else {
  document.body.replaceChildren();
}

async function start() {
  const registration = await controlledByServiceWorker();
  library = await Library.open();
  // Asks the browser to keep the library when storage runs low. Safari
  // answers without asking the user.
  navigator.storage?.persist?.().catch(() => {});
  toolSettings = readToolSettings(
    await library.setting("toolSettings"),
    await library.setting("favourites"),
  );
  explained = (await library.setting("notInFilesExplained")) === true;
  for (const id of (await library.thumbnails()).keys()) thumbnailVersions.set(id, 1);
  followKeys();
  followDrops();
  stopPinching();
  if (!(await restoreSession())) showHome();
  keepSession();
  followUpdates(registration, { version: VERSION, beforeRestart: saveEverything });
}

/** The first download of the app failed, or wasn't what its service worker lists. */
class DownloadError extends Error {}

/**
 * Registers the service worker, which keeps the app for offline use and
 * serves the library's documents, and waits until it controls the page, so
 * that the frames load through it. The first time, that's once it has
 * downloaded the app.
 *
 * @returns {Promise<ServiceWorkerRegistration>}
 * @throws {DownloadError} if the first download fails
 */
async function controlledByServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("This browser has no service workers.");
  const { serviceWorker } = navigator;
  const controlled = new Promise((resolve) =>
    serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
  );
  const registration = await serviceWorker.register(new URL("sw.js", BASE), {
    type: "module",
    scope: BASE.pathname,
    updateViaCache: "none",
  });
  if (serviceWorker.controller) return registration;
  // Without an active worker, the first install, which may fail.
  const { installing } = registration;
  const failed = new Promise((_resolve, reject) => {
    installing?.addEventListener("statechange", () => {
      if (installing.state === "redundant" && !registration.active) {
        reject(new DownloadError("The service worker didn't install."));
      }
    });
  });
  await Promise.race([
    (async () => {
      // An active worker that doesn't control the page, as after a reload
      // that bypassed it, takes it over when asked.
      const { active } = await serviceWorker.ready;
      if (serviceWorker.controller) return;
      active?.postMessage("claim");
      await controlled;
    })(),
    failed,
  ]);
  return registration;
}

// ---------------------------------------------------------------------------
// Tabs

/** @returns {object} `window.pdflionTabs`, as src/preload/tabs.cjs gives it on the desktop */
function stripApi() {
  return {
    /** @param {(tabs: object[]) => void} callback */
    onState(callback) {
      stripListener = callback;
      render();
    },
    /**
     * @param {string} id
     * @param {boolean} focus
     */
    select(id, focus) {
      const tab = tabs.get(id);
      if (tab) activate(tab, { focus });
    },
    /** @param {string} id */
    close(id) {
      const tab = tabs.get(id);
      if (tab) closeTab(tab);
    },
    /** @param {string} id */
    contextMenu(id) {
      const tab = tabs.get(id);
      if (tab) showTabMenu(tab, stripMenuAt);
    },
    /** Closes the tab's menu, once a long press that opened it drags the tab. */
    closeMenu() {
      dialogs.closeMenus();
    },
    /**
     * @param {string} id
     * @param {number} index
     */
    move(id, index) {
      if (!tabs.has(id) || !Number.isInteger(index) || index < 0 || index >= tabs.size) return;
      tabList.move(id, WINDOW, index);
      render();
    },
    // There's one window, so tabs can't go to another or be torn off.
    dragStarted() {},
    drop() {},
    dragEnded() {},
  };
}

document.addEventListener(
  "contextmenu",
  (event) => {
    stripMenuAt = { x: event.clientX, y: event.clientY };
  },
  true,
);

/**
 * Adds a tab, but doesn't show it.
 *
 * @param {Tab["kind"]} kind
 * @param {string | null} documentId
 * @param {string} name
 * @param {number} index where it goes in the strip
 * @param {{ load?: boolean, view?: View | null }} [options] whether it loads
 *   its page now, rather than once it's shown, and where its document was
 * @returns {Tab}
 */
function addTab(kind, documentId, name, index, { load = true, view = null } = {}) {
  /** @type {Tab} */
  const tab = {
    id: crypto.randomUUID(),
    kind,
    documentId,
    name,
    frame: null,
    port: null,
    view,
    shownAt: 0,
    sleeping: false,
    edited: false,
    closing: false,
    saveFailed: false,
  };
  tabs.set(tab.id, tab);
  tabList.add(WINDOW, tab.id, index);
  if (load) loadFrame(tab);
  return tab;
}

/**
 * Gives a tab its frame, which loads its page: a document where it was.
 *
 * @param {Tab} tab
 */
function loadFrame(tab) {
  const frame = document.createElement("iframe");
  frame.className = "page";
  frame.title = tab.name;
  frame.allow = "fullscreen; clipboard-write";
  frame.src =
    tab.kind === "home"
      ? HOME_PAGE.href
      : viewerUrl(/** @type {string} */ (tab.documentId), tab.name, tab.view);
  tab.frame = frame;
  frames.append(frame);
}

/**
 * Takes a tab's frame away, without saving.
 *
 * @param {Tab} tab
 */
function unloadFrame(tab) {
  tab.port?.close();
  tab.port = null;
  tab.frame?.remove();
  tab.frame = null;
  for (const pending of [...pendingCommands.values()]) {
    if (pending.tab === tab) pending.settle(null);
  }
}

/**
 * Takes a tab away at once, without saving.
 *
 * @param {Tab} tab
 */
function removeTab(tab) {
  if (!tabs.delete(tab.id)) return;
  tabList.remove(tab.id);
  unloadFrame(tab);
  render();
}

/**
 * Has the documents shown longest ago sleep, beyond MAX_LOADED_DOCUMENTS.
 */
function sleepTabs() {
  const active = activeTab();
  const loaded = [...tabs.values()].filter((tab) => tab.kind === "document" && tab.frame);
  const sleepy = loaded
    .filter((tab) => tab !== active && !tab.sleeping && !tab.closing)
    .sort((a, b) => a.shownAt - b.shownAt);
  const excess = loaded.length - loaded.filter((tab) => tab.sleeping).length - MAX_LOADED_DOCUMENTS;
  for (const tab of sleepy.slice(0, Math.max(0, excess))) sleep(tab);
}

/**
 * Saves a tab's document, then takes its frame away, unless it's shown
 * meanwhile, or its changes couldn't be saved.
 *
 * @param {Tab} tab
 */
async function sleep(tab) {
  tab.sleeping = true;
  const saved = await runCommand(tab, "saveNow", CLOSE_SAVE_TIMEOUT);
  tab.sleeping = false;
  if (!tabs.has(tab.id) || tab.closing || tab === activeTab()) return;
  if (tab.edited && saved !== true) return;
  unloadFrame(tab);
}

/**
 * @param {string} id
 * @param {string} name
 * @param {View | null} [view] where to show it
 * @returns {string} the viewer's URL for a document of the library
 */
function viewerUrl(id, name, view = null) {
  const hash = view ? `#${viewHash(view)}` : "";
  return `${VIEWER_PAGE.href}?${new URLSearchParams({ file: documentPath(id, name) })}${hash}`;
}

/**
 * @param {string} id
 * @param {string} name
 * @returns {string} where the service worker serves it, as bridge.js names it
 */
function documentPath(id, name) {
  return `${DOCUMENTS_PATH}${id}/${encodeURIComponent(name)}`;
}

/** @returns {Tab | null} */
function activeTab() {
  const id = tabList.activeTab(WINDOW);
  return (id && tabs.get(id)) ?? null;
}

/**
 * @param {string} documentId
 * @returns {Tab | null} the tab that shows it
 */
function tabOf(documentId) {
  return [...tabs.values()].find((tab) => tab.documentId === documentId) ?? null;
}

/** Shows the active tab, and the strip, unless there's only one. */
function render() {
  const ids = tabList.tabsOf(WINDOW);
  const active = activeTab();
  for (const tab of tabs.values()) {
    if (!tab.frame) continue;
    const shown = tab === active;
    tab.frame.classList.toggle("active", shown);
    tab.frame.inert = !shown;
  }
  document.body.classList.toggle("oneTab", ids.length <= 1);
  document.title = active?.kind === "document" ? `${active.name} – PDFLion` : "PDFLion";
  stripListener?.(
    ids.map((id) => {
      const tab = /** @type {Tab} */ (tabs.get(id));
      const home = tab.kind === "home";
      return {
        id,
        name: home ? "Home" : tab.name,
        home,
        edited: tab.edited,
        active: tab === active,
      };
    }),
  );
  scheduleSession();
}

/**
 * Shows a tab, loading it if it sleeps. The document of the tab left saves
 * now, so that changes with pdf.js's page tools, which autosave holds back,
 * are stored. Documents shown longest ago may sleep.
 *
 * @param {Tab} tab
 * @param {{ focus?: boolean }} [options] whether keys then go to it
 */
function activate(tab, { focus = true } = {}) {
  const previous = activeTab();
  tabList.activate(tab.id);
  tab.shownAt = ++shownCount;
  if (!tab.frame) loadFrame(tab);
  render();
  if (previous && previous !== tab && previous.edited) runCommand(previous, "saveNow");
  if (focus) tab.frame?.contentWindow?.focus();
  sleepTabs();
}

/** Shows Home: the home tab, or a new one after the active tab. */
function showHome() {
  const home = [...tabs.values()].find((tab) => tab.kind === "home");
  if (home) {
    activate(home);
    return;
  }
  const active = activeTab();
  const index = active ? tabList.tabsOf(WINDOW).indexOf(active.id) + 1 : 0;
  activate(addTab("home", null, "Home", index));
}

/**
 * Closes a tab, once its document has saved, and says if the document isn't
 * in Files. A document made with New and never changed goes, as TextEdit
 * does it. Without tabs, Home shows.
 *
 * @param {Tab} tab
 */
async function closeTab(tab) {
  if (tab.closing || !tabs.has(tab.id)) return;
  tab.closing = true;
  if (tab.kind === "document") {
    const saved = await runCommand(tab, "saveNow", CLOSE_SAVE_TIMEOUT);
    if (tab.edited && saved !== true) {
      const close = await dialogs.confirm(closeUnsavedPrompt(tab.name), CLOSE, {
        destructive: true,
      });
      if (!close) {
        tab.closing = false;
        return;
      }
    }
  }
  removeTab(tab);
  if (tabs.size === 0) showHome();
  if (tab.documentId) await afterClosing(tab.documentId);
}

/** @param {string} documentId of a tab that closed */
async function afterClosing(documentId) {
  if (tabOf(documentId)) return;
  const record = await library.document(documentId);
  if (!record) return;
  const made = record.source === "new";
  if (made && record.revision === 0) {
    await library.remove(documentId);
    thumbnailVersions.delete(documentId);
  } else if (isNotInFiles(record)) {
    dialogs.snackbar(closedNotInFiles(record.name, made), {
      action: SHARE,
      onAction: () => shareDocument(documentId, null),
    });
  }
  updateHomes();
}

/**
 * @param {Tab} tab
 * @param {{ x: number, y: number }} at
 */
function showTabMenu(tab, at) {
  /** @type {import("./dialogs.js").MenuItem[]} */
  const items = [
    { label: "Close Tab", action: () => closeTab(tab) },
    {
      label: "Close Other Tabs",
      disabled: tabs.size < 2,
      action: () => {
        for (const other of [...tabs.values()]) if (other !== tab) closeTab(other);
      },
    },
  ];
  const { documentId } = tab;
  if (documentId) {
    items.push(
      { label: "", separator: true },
      { label: SHARE, action: () => shareDocument(documentId, null) },
    );
  }
  dialogs.showMenu(items, at);
}

/**
 * Sends a command to a tab's bridge.js, as the desktop's runCommand() in
 * ipc.js does.
 *
 * @param {Tab} tab
 * @param {string} command
 * @param {number} [timeout] in ms, after which it settles with null
 * @returns {Promise<unknown>} what bridge.js answered, or null if the tab
 *   went away first, or hadn't loaded
 */
function runCommand(tab, command, timeout = 0) {
  const { port } = tab;
  if (!port) return Promise.resolve(null);
  const id = ++lastCommand;
  return new Promise((resolve) => {
    /** @param {unknown} result */
    const settle = (result) => {
      if (!pendingCommands.delete(id)) return;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = timeout > 0 ? setTimeout(() => settle(null), timeout) : undefined;
    pendingCommands.set(id, { tab, settle });
    port.postMessage({ type: "command", id, command });
  });
}

// ---------------------------------------------------------------------------
// The frames' messages

/**
 * A frame's host connects with a MessagePort, which the shell takes only
 * from one of its own frames, with the page of the tab's kind.
 *
 * @param {MessageEvent} event
 */
function connect(event) {
  if (event.origin !== location.origin || event.data?.pdflion !== "connect") return;
  const tab = [...tabs.values()].find((other) => other.frame?.contentWindow === event.source);
  const [port] = event.ports;
  if (!tab || !port || event.data.kind !== (tab.kind === "home" ? "home" : "viewer")) return;
  tab.port?.close();
  tab.port = port;
  port.onmessage = ({ data }) => {
    receive(tab, port, data).catch((error) => console.error(`${data?.type} failed:`, error));
  };
  if (tab.kind === "document") sendSaveStatus(tab);
}

/**
 * @param {Tab} tab
 * @param {MessagePort} port
 * @param {unknown} data `{ type, args, id? }`, with an id for a reply
 */
async function receive(tab, port, data) {
  if (port !== tab.port || typeof data !== "object" || data === null) return;
  const { type, args, id } = /** @type {Record<string, unknown>} */ (data);
  const handlers = tab.kind === "home" ? HOME_MESSAGES : VIEWER_MESSAGES;
  if (typeof type !== "string" || !Object.hasOwn(handlers, type) || !Array.isArray(args)) return;
  const result = await handlers[type](tab, ...args);
  if (typeof id === "number") port.postMessage({ type: "reply", id, result: result ?? null });
}

/**
 * What the viewer's host sends, as the desktop's preload.cjs sends it to
 * main, each checked as main checks it.
 * @type {Record<string, (tab: Tab, ...args: any[]) => unknown>}
 */
const VIEWER_MESSAGES = {
  save: (tab, bytes) => (isDocumentBytes(bytes) ? saveDocument(tab, bytes) : null),
  setEdited(tab, edited) {
    if (typeof edited !== "boolean" || tab.edited === edited) return;
    tab.edited = edited;
    render();
  },
  pageDialog: (tab, reason, items) =>
    isPageDialog(reason, items) ? showPageDialog(tab, reason, items) : false,
  getToolSettings: () => toolSettings,
  setToolSettings(_tab, changes) {
    const parsed = parseToolSettings(changes);
    if (parsed) updateToolSettings(parsed);
  },
  favouriteMenu(tab, value, x, y) {
    const favourite = parseFavourite(value);
    if (!favourite) return;
    const remove = () =>
      updateToolSettings({ favourites: removeFavourite(toolSettings.favourites, favourite) });
    dialogs.showMenu([{ label: "Remove Favourite", action: remove }], inFrame(tab, x, y));
  },
  closeMenu: () => dialogs.closeMenus(),
  showHome: () => showHome(),
  view(tab, value) {
    const view = parseView(value);
    if (!view) return;
    tab.view = view;
    scheduleSession(VIEW_DELAY);
  },
  thumbnail(tab, png) {
    if (tab.documentId && isThumbnail(png)) keepThumbnail(tab.documentId, png);
  },
  share: (tab, bytes) =>
    tab.documentId && (bytes === null || isDocumentBytes(bytes))
      ? shareDocument(tab.documentId, bytes)
      : false,
  openFiles: (_tab, files, dropped) => isFileList(files) && openFiles(files, dropped === true),
  newDocument: () => newDocument(),
  showAbout: () => showAbout(),
  key: (_tab, action) => typeof action === "string" && runShortcut(action),
  commandDone(tab, id, result) {
    const pending = pendingCommands.get(id);
    if (pending?.tab === tab) pending.settle(result);
  },
};

/**
 * What Home's host sends, as the desktop's home.cjs sends it to main, naming
 * documents by their ids.
 * @type {Record<string, (tab: Tab, ...args: any[]) => unknown>}
 */
const HOME_MESSAGES = {
  ready: (tab) => sendHomeState(tab),
  open: (_tab, id) => isDocumentId(id) && openDocuments([id]),
  openFiles: (_tab, files, dropped) => isFileList(files) && openFiles(files, dropped === true),
  newDocument: () => newDocument(),
  remove: (_tab, id) => isDocumentId(id) && deleteDocument(id),
  contextMenu: (tab, id, x, y) => isDocumentId(id) && showDocumentMenu(id, inFrame(tab, x, y)),
  infoMenu: (tab, x, y) => showInfoMenu(inFrame(tab, x, y)),
  importFile: (_tab, file) => file instanceof File && importFile(file, backupHost()),
  key: (_tab, action) => typeof action === "string" && runShortcut(action),
};

/**
 * @param {Tab} tab
 * @param {unknown} x in the frame
 * @param {unknown} y
 * @returns {{ x: number, y: number }} that place in the shell
 */
function inFrame(tab, x, y) {
  const { left, top } = tab.frame?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const finite = (/** @type {unknown} */ value) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return { x: left + finite(x), y: top + finite(y) };
}

/**
 * @param {unknown} bytes
 * @returns {bytes is Uint8Array}
 */
function isDocumentBytes(bytes) {
  return bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_DOCUMENT_BYTES;
}

/**
 * @param {unknown} files
 * @returns {files is File[]}
 */
function isFileList(files) {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.length <= MAX_FILES &&
    files.every((file) => file instanceof File)
  );
}

/**
 * Shows a page dialog that bridge.js asked for by its reason.
 *
 * @param {Tab} tab
 * @param {string} reason
 * @param {string[] | undefined} items
 * @returns {Promise<boolean>} whether the user went ahead, for a prompt
 */
async function showPageDialog(tab, reason, items) {
  const { message, detail, confirm, cancelByDefault } = pageDialog(reason, tab.name, items);
  if (!confirm) {
    await dialogs.alert({ message, detail });
    return false;
  }
  return dialogs.confirm({ message, detail }, confirm, { cancelByDefault });
}

// ---------------------------------------------------------------------------
// The library

/**
 * Keeps PDFs from the file picker or a drop, and opens them as tabs, the
 * first in place of Home if it's showing. A file the library has already,
 * byte for byte, opens that document.
 *
 * @param {File[]} files
 * @param {boolean} dropped
 */
async function openFiles(files, dropped) {
  /** @type {string[]} */
  const ids = [];
  for (const file of files) {
    try {
      const id = await keepFile(file, dropped ? "drop" : "files");
      if (id) ids.push(id);
    } catch (error) {
      console.error(`Couldn't keep ${file.name}:`, error);
      const { name, message } = /** @type {Error} */ (error);
      await dialogs.alert(
        name === "QuotaExceededError"
          ? saveError(file.name, { code: name, message })
          : openError(file.name, { message }),
      );
    }
  }
  if (ids.length > 0) await openDocuments(ids);
}

/**
 * @param {File} file
 * @param {DocumentRecord["source"]} source
 * @returns {Promise<string | null>} the document's id, or null if it's no PDF
 */
async function keepFile(file, source) {
  if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) {
    await dialogs.alert(notAPdf(file.name));
    return null;
  }
  const buffer = await file.arrayBuffer();
  if (!(await hasPdfHeader(file))) {
    await dialogs.alert(notAPdf(file.name));
    return null;
  }
  const sha256 = await digest(buffer);
  const existing = await library.findBySha256(sha256);
  if (existing) return existing.id;
  const record = await library.add({
    name: cleanName(file.name) ?? "Untitled.pdf",
    blob: new Blob([buffer], { type: "application/pdf" }),
    source,
    sha256,
  });
  return record.id;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} its SHA-256, in hex
 */
async function digest(buffer) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Makes `Untitled.pdf` in the library, one blank page of the paper size of
 * the browser's region, and opens it.
 */
async function newDocument() {
  const name = freeName(await library.documents(), "Untitled.pdf");
  const record = await library.add({
    name,
    blob: new Blob([blankPdf(paperSize(regionOf(navigator.language)))], {
      type: "application/pdf",
    }),
    source: "new",
    sha256: null,
  });
  await openDocuments([record.id]);
}

/**
 * @param {string} language such as `en-US`, or `de`
 * @returns {string} its region, such as `US`, or the likeliest, or "" if unknown
 */
function regionOf(language) {
  try {
    return new Intl.Locale(language).maximize().region ?? "";
  } catch {
    return "";
  }
}

/**
 * Opens documents of the library as tabs after the active one, the first in
 * place of Home if it's showing, and shows the last. One that's open
 * already shows its tab.
 *
 * @param {string[]} ids
 */
async function openDocuments(ids) {
  const active = activeTab();
  const home = active?.kind === "home" ? active : null;
  const order = tabList.tabsOf(WINDOW);
  let index = active ? order.indexOf(active.id) + (home ? 0 : 1) : order.length;
  /** @type {Tab | null} */
  let last = null;
  let added = false;
  for (const id of ids) {
    const record = await library.update(id, { openedAt: Date.now() });
    if (!record) continue;
    last = tabOf(id);
    if (!last) {
      last = addTab("document", id, record.name, index++);
      added = true;
    }
  }
  if (last) activate(last);
  if (home && added) removeTab(home);
  updateHomes();
}

/**
 * Stores a new revision of a tab's document, as bridge.js's autosave or
 * Save hands it over.
 *
 * @param {Tab} tab
 * @param {Uint8Array} bytes
 * @returns {Promise<string | null>} its path, or null if it wasn't stored
 */
async function saveDocument(tab, bytes) {
  const documentId = /** @type {string} */ (tab.documentId);
  try {
    const record = await library.save(documentId, new Blob([bytes], { type: "application/pdf" }));
    tab.saveFailed = false;
    afterSaving(tab, record);
    return documentPath(record.id, record.name);
  } catch (error) {
    console.error(`Couldn't save ${tab.name}:`, error);
    // Once, until a save works again: autosave tries again with each change.
    if (!tab.saveFailed) {
      tab.saveFailed = true;
      const { name, message } = /** @type {Error} */ (error);
      dialogs.alert(saveError(tab.name, { code: name, message }));
    }
    return null;
  }
}

/**
 * After a save, says once a session that the document isn't in Files, and
 * the first time ever what that means.
 *
 * @param {Tab} tab
 * @param {DocumentRecord} record as saved
 */
function afterSaving(tab, record) {
  sendSaveStatus(tab, record);
  updateHomes();
  if (!isNotInFiles(record) || toldNotInFiles.has(record.id)) return;
  toldNotInFiles.add(record.id);
  const made = record.source === "new";
  const share = () => shareDocument(record.id, null);
  if (explained) {
    dialogs.snackbar(savedNotInFiles(made), { action: SHARE, onAction: share });
    return;
  }
  explained = true;
  library.setSetting("notInFilesExplained", true);
  dialogs
    .showDialog(notInFilesExplanation(record.name, made), {
      buttons: [SHARE, OK],
      defaultButton: OK,
      cancelButton: OK,
    })
    .then(({ button }) => {
      if (button === SHARE) share();
    });
}

/**
 * Tells a tab's bridge.js whether its document is in Files, for the
 * toolbar's status.
 *
 * @param {Tab} tab
 * @param {DocumentRecord} [record] the document's, if it's at hand
 */
async function sendSaveStatus(tab, record) {
  record ??= tab.documentId ? await library.document(tab.documentId) : undefined;
  if (!record || !tab.port) return;
  const status = isNotInFiles(record) ? notInFilesLabel(record.source === "new") : null;
  tab.port.postMessage({ type: "saveStatus", status });
}

/**
 * Shares a document through the system's share sheet, whose Save to Files
 * puts it back into Files, which ends its "not in Files" status. Where the
 * browser can't share files, it downloads it instead.
 *
 * @param {string} documentId
 * @param {Uint8Array | null} bytes the document as its tab has it, or null
 *   for the stored revision, after its tab has saved
 * @returns {Promise<boolean>} whether it was shared
 */
async function shareDocument(documentId, bytes) {
  let record = await library.document(documentId);
  if (!record) return false;
  const tab = tabOf(documentId);
  /** @type {Blob} */
  let blob;
  if (bytes) {
    blob = new Blob([bytes], { type: "application/pdf" });
  } else {
    if (tab?.edited) await runCommand(tab, "saveNow");
    const stored = await library.read(documentId);
    if (!stored) return false;
    ({ record, blob } = stored);
  }
  // What's shared is the stored revision, unless the tab has changes that
  // couldn't be stored.
  const revision = tab?.edited ? null : record.revision;
  const shared = await shareFile(new File([blob], record.name, { type: "application/pdf" }));
  if (shared && revision !== null) {
    const sha256 = await digest(await blob.arrayBuffer());
    const updated = await library.update(documentId, {
      exportedRevision: Math.max(revision, record.exportedRevision),
      sha256,
    });
    for (const other of tabs.values()) {
      if (updated && other.documentId === documentId) sendSaveStatus(other, updated);
    }
    updateHomes();
  }
  return shared;
}

/**
 * @param {File} file
 * @returns {Promise<boolean>} whether it was shared, or downloaded
 */
async function shareFile(file) {
  if (!navigator.canShare?.({ files: [file] })) {
    download(file);
    return true;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (error) {
      const { name } = /** @type {Error} */ (error);
      if (name === "AbortError") return false;
      // The tap's activation ran out while the document saved: one more tap.
      if (name === "NotAllowedError" && attempt === 0) {
        if (await dialogs.confirm(shareReady(file.name), SHARE)) continue;
        return false;
      }
      console.error(`Couldn't share ${file.name}:`, error);
      await dialogs.alert(shareError(file.name, /** @type {Error} */ (error)));
      return false;
    }
  }
}

/** @param {File} file to download, where sharing files isn't possible */
function download(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Deletes a document from the library, once the user agrees, and closes its
 * tab.
 *
 * @param {string} documentId
 */
async function deleteDocument(documentId) {
  const record = await library.document(documentId);
  if (!record) return;
  const prompt = deletePrompt(record.name, {
    notInFiles: isNotInFiles(record),
    made: record.source === "new",
  });
  if (!(await dialogs.confirm(prompt, DELETE, { destructive: true }))) return;
  const tab = tabOf(documentId);
  if (tab) {
    removeTab(tab);
    if (tabs.size === 0) showHome();
  }
  await library.remove(documentId);
  thumbnailVersions.delete(documentId);
  updateHomes();
}

/**
 * Asks for a document's new name. It keeps `.pdf` at the end, for Files.
 *
 * @param {string} documentId
 */
async function renameDocument(documentId) {
  const record = await library.document(documentId);
  if (!record) return;
  const entered = await dialogs.prompt(renamePrompt(record.name), record.name, RENAME);
  let name = cleanName(entered);
  if (!name || name === record.name) return;
  if (!/\.pdf$/i.test(name)) name = `${name.slice(0, 251)}.pdf`;
  await library.update(documentId, { name });
  for (const tab of tabs.values()) {
    if (tab.documentId !== documentId) continue;
    tab.name = name;
    if (tab.frame) tab.frame.title = name;
  }
  render();
  updateHomes();
}

/**
 * @param {string} documentId
 * @param {{ x: number, y: number }} at
 */
function showDocumentMenu(documentId, at) {
  dialogs.showMenu(
    [
      { label: "Open", action: () => openDocuments([documentId]) },
      { label: SHARE, action: () => shareDocument(documentId, null) },
      { label: "Rename…", action: () => renameDocument(documentId) },
      { label: "", separator: true },
      { label: "Delete…", action: () => deleteDocument(documentId) },
    ],
    at,
  );
}

/**
 * Home's ⓘ menu: About, Check for Updates…, Export… and Import…, pen-only
 * drawing, and how much the library takes.
 *
 * @param {{ x: number, y: number }} at
 */
async function showInfoMenu(at) {
  const usage = (await navigator.storage?.estimate?.().catch(() => null))?.usage;
  /** @type {import("./dialogs.js").MenuItem[]} */
  const items = [
    { label: "About PDFLion", action: showAbout },
    { label: "Check for Updates…", action: checkForUpdates },
    { label: "", separator: true },
    { label: "Export…", action: () => exportBackup(backupHost()) },
    { label: "Import…", action: pickBackup },
    { label: "", separator: true },
    {
      label: "Draw Only with a Pen",
      checked: toolSettings.penOnly,
      action: () => updateToolSettings({ penOnly: !toolSettings.penOnly }),
    },
  ];
  if (usage !== undefined) {
    items.push(
      { label: "", separator: true },
      { label: `${formatSize(usage)} of storage used`, info: true },
    );
  }
  dialogs.showMenu(items, at);
}

function showAbout() {
  dialogs.showAbout({ version: VERSION, pdfjsVersion: PDFJS_VERSION, credits: CREDITS });
}

/**
 * Stores changed tool settings and sends every viewer all of them, as the
 * desktop's toolsettings.js does.
 *
 * @param {Partial<ToolSettings>} changes checked with tools.js
 */
async function updateToolSettings(changes) {
  const { eraser, penOnly, favourites } = changes;
  toolSettings = changeToolSettings(toolSettings, changes);
  for (const tab of tabs.values()) {
    if (tab.kind === "document") tab.port?.postMessage({ type: "toolSettings", settings: toolSettings });
  }
  if (eraser || penOnly !== undefined) {
    await library.setSetting("toolSettings", {
      eraser: toolSettings.eraser,
      penOnly: toolSettings.penOnly,
      penOnlyChosen: toolSettings.penOnlyChosen,
    });
  }
  if (favourites) await library.setSetting("favourites", favourites);
}

/**
 * @param {string} documentId
 * @param {Uint8Array} png checked with isThumbnail()
 */
async function keepThumbnail(documentId, png) {
  await library.setThumbnail(documentId, new Blob([png], { type: "image/png" }));
  thumbnailVersions.set(documentId, (thumbnailVersions.get(documentId) ?? 0) + 1);
  updateHomes();
}

/** Sends every Home the library as it is now, once for changes made together. */
function updateHomes() {
  if (updatingHomes) return;
  updatingHomes = true;
  setTimeout(async () => {
    updatingHomes = false;
    const homes = [...tabs.values()].filter((tab) => tab.kind === "home" && tab.port);
    if (homes.length === 0) return;
    const documents = await homeState();
    for (const tab of homes) tab.port?.postMessage({ type: "state", documents });
  });
}

/** @param {Tab} tab a home tab */
async function sendHomeState(tab) {
  const documents = await homeState();
  tab.port?.postMessage({ type: "state", documents });
}

/** @returns {Promise<object[]>} the library, as home-host.js takes it */
async function homeState() {
  const [records, thumbnails] = await Promise.all([library.documents(), library.thumbnails()]);
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    size: record.size,
    openedAt: record.openedAt,
    thumbnail: thumbnails.get(record.id) ?? null,
    thumbnailVersion: thumbnailVersions.get(record.id) ?? 0,
    open: tabOf(record.id) !== null,
    status: isNotInFiles(record) ? notInFilesLabel(record.source === "new") : null,
  }));
}

// ---------------------------------------------------------------------------
// The session

/**
 * Opens the tabs the session kept, each loading once it's shown, but for
 * the active one, which shows. Documents deleted meanwhile are left out.
 *
 * @returns {Promise<boolean>} whether any tab opened
 */
async function restoreSession() {
  const session = parseSession(await library.session());
  const records = new Map((await library.documents()).map((record) => [record.id, record]));
  /** @type {Tab | null} */
  let active = null;
  /** @type {Tab | null} */
  let last = null;
  for (const [index, kept] of session.tabs.entries()) {
    const record = kept.kind === "document" ? records.get(kept.documentId) : null;
    if (kept.kind === "document" && !record) continue;
    last = record
      ? addTab("document", record.id, record.name, tabs.size, { load: false, view: kept.view })
      : addTab("home", null, "Home", tabs.size, { load: false });
    if (index === session.active) active = last;
  }
  const shown = active ?? last;
  if (shown) activate(shown);
  return shown !== null;
}

/** @returns {Session} the open tabs, as session.js keeps them */
function currentSession() {
  const ids = tabList.tabsOf(WINDOW);
  const active = tabList.activeTab(WINDOW);
  return {
    tabs: ids.map((id) => {
      const tab = /** @type {Tab} */ (tabs.get(id));
      return tab.kind === "home"
        ? { kind: "home" }
        : { kind: "document", documentId: /** @type {string} */ (tab.documentId), view: tab.view };
    }),
    active: active ? ids.indexOf(active) : -1,
  };
}

/**
 * Stores the session from now on: after each change, a view's a while
 * after, and at once when the app is hidden, since iPadOS may end it then.
 */
function keepSession() {
  keepingSession = true;
  storeSession();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") storeSession();
  });
  window.addEventListener("pagehide", () => storeSession());
}

/**
 * Stores the session soon, with the changes until then.
 *
 * @param {number} [delay] in ms
 */
function scheduleSession(delay = 0) {
  if (!keepingSession) return;
  const due = Date.now() + delay;
  if (sessionTimer !== null) {
    if (sessionDue <= due) return;
    clearTimeout(sessionTimer);
  }
  sessionDue = due;
  sessionTimer = setTimeout(storeSession, delay);
}

/** Stores the session now. */
async function storeSession() {
  if (sessionTimer !== null) clearTimeout(sessionTimer);
  sessionTimer = null;
  if (!keepingSession) return;
  try {
    await library.setSession(currentSession());
  } catch (error) {
    console.error("Couldn't keep the open tabs:", error);
  }
}

/**
 * Saves every document and the session, before the page reloads for a new
 * version.
 *
 * @param {boolean} ask whether to ask about changes that couldn't be saved
 * @returns {Promise<boolean>} whether to go ahead
 */
async function saveEverything(ask) {
  const documents = [...tabs.values()].filter((tab) => tab.kind === "document");
  const saved = await Promise.all(
    documents.map((tab) => runCommand(tab, "saveNow", CLOSE_SAVE_TIMEOUT)),
  );
  await storeSession();
  if (!ask) return true;
  for (const [index, tab] of documents.entries()) {
    if (!tab.edited || saved[index] === true) continue;
    const restart = await dialogs.confirm(restartUnsavedPrompt(tab.name), RESTART_NOW, {
      destructive: true,
    });
    if (!restart) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Keys and drops

/**
 * Does what a shortcut stands for, whether it was pressed in the shell or
 * in a frame, whose host hands it over.
 *
 * @param {string} action from keys.js
 */
function runShortcut(action) {
  const tab = activeTab();
  const shown = tab?.kind === "document" ? tab : null;
  switch (action) {
    case "open":
      pickFiles();
      break;
    case "newDocument":
      newDocument();
      break;
    case "closeTab":
      if (tab) closeTab(tab);
      break;
    case "save":
      if (shown) {
        runCommand(shown, "saveNow").then((saved) => {
          if (saved === true) dialogs.snackbar(savedNow(shown.name));
        });
      }
      break;
    case "share":
    case "insertBlankPage":
    case "pageOverview":
    case "eraser":
      if (shown) runCommand(shown, action);
      break;
    case "home":
      showHome();
      break;
    case "nextTab":
    case "previousTab": {
      const id = action === "nextTab" ? tabList.next(WINDOW) : tabList.previous(WINDOW);
      const next = id && tabs.get(id);
      if (next) activate(next);
      break;
    }
  }
}

function followKeys() {
  document.addEventListener("keydown", (event) => {
    const action = PDFLionKeys.shortcutOf(event, commandKey);
    if (!action) return;
    event.preventDefault();
    runShortcut(action);
  });
}

/** The shell's file picker, for ⌘O while the strip has the keys. */
let picker = /** @type {HTMLInputElement | null} */ (null);

function pickFiles() {
  if (!picker) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = true;
    input.hidden = true;
    input.addEventListener("change", () => {
      const files = [.../** @type {FileList} */ (input.files)];
      input.value = "";
      if (files.length > 0) openFiles(files.slice(0, MAX_FILES), false);
    });
    document.body.append(input);
    picker = input;
  }
  picker.click();
}

/** The shell's file picker for Import…, which iPadOS opens in response to the menu's tap. */
let backupPicker = /** @type {HTMLInputElement | null} */ (null);

function pickBackup() {
  if (!backupPicker) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.json,application/zip,application/json";
    input.hidden = true;
    input.addEventListener("change", () => {
      const [file] = /** @type {FileList} */ (input.files);
      input.value = "";
      if (file) importFile(file, backupHost());
    });
    document.body.append(input);
    backupPicker = input;
  }
  backupPicker.click();
}

/** @returns {import("./backup.js").BackupHost} what Export… and Import… use of the shell */
function backupHost() {
  return {
    library,
    toolSettings: () => toolSettings,
    updateToolSettings,
    saveAll: () => saveEverything(false),
    share: shareFile,
    imported(ids) {
      for (const id of ids) thumbnailVersions.set(id, (thumbnailVersions.get(id) ?? 0) + 1);
      updateHomes();
    },
    maxDocumentBytes: MAX_DOCUMENT_BYTES,
  };
}

/**
 * @param {DragEvent} event
 * @returns {boolean} whether it drags PDFs, by the test pdf.js uses
 */
function isPdfDrag(event) {
  return [...(event.dataTransfer?.items ?? [])].some(
    (item) => item.kind === "file" && item.type === "application/pdf",
  );
}

/**
 * A pinch on the strip zooms nothing, as in an app: Safari ignores the
 * viewport's maximum-scale. The frames stop their own.
 */
function stopPinching() {
  document.addEventListener("gesturestart", (event) => event.preventDefault());
}

/** PDFs dropped on the strip open as tabs. The frames take their own. */
function followDrops() {
  document.addEventListener("dragover", (event) => {
    if (!isPdfDrag(event)) return;
    event.preventDefault();
    /** @type {DataTransfer} */ (event.dataTransfer).dropEffect = "copy";
  });
  document.addEventListener("drop", (event) => {
    if (!isPdfDrag(event)) return;
    event.preventDefault();
    const files = [.../** @type {DataTransfer} */ (event.dataTransfer).files]
      .filter((file) => file.type === "application/pdf")
      .slice(0, MAX_FILES);
    if (files.length > 0) openFiles(files, true);
  });
}
