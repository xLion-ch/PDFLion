/**
 * One tab per document, and home tabs. A tab is a WebContentsView showing the
 * viewer, or Home, in a window whose own page is the tab strip. Moving a tab
 * to another window moves its view, and its page, with any unsaved changes,
 * comes along. A document opened in a window whose active tab is Home takes
 * the home tab's place.
 *
 * This module lays out each window's views, titles the window after its
 * active tab, and tells the strip what to show. Closing a tab here never asks
 * about unsaved changes: unsaved.js does that first.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { app, BrowserWindow, WebContentsView, shell } from "electron";
import { blankPdf, paperSize } from "../shared/blank.js";
import { TabList } from "../shared/tablist.js";
import * as documents from "./documents.js";
import { homePreloadPath, preloadPath } from "./paths.js";
import { addRecentDocument } from "./recent.js";
import { HOME_URL, isHomeUrl, isViewerUrl, viewerUrl } from "./routes.js";

const isMac = process.platform === "darwin";

/** The strip's height, as tabs.css draws it. It shows with two tabs or more. */
const STRIP_HEIGHT = 36;

/** Link schemes that open in the default browser or mail app. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** What the strip and the window's title call a home tab. */
const HOME_NAME = "Home";

/**
 * @typedef {object} Tab
 * @property {string} id random and unrelated to the token, since the strip
 *   and drags between windows carry it
 * @property {"document" | "home"} kind
 * @property {string | null} token the document's, from documents.js, or null
 *   for Home
 * @property {WebContentsView} view
 * @property {Electron.WebContents} webContents the view's page. The view
 *   forgets it once it's destroyed, and this keeps answering isDestroyed()
 * @property {string} title the viewer page's title
 * @property {boolean} edited whether the document has unsaved changes
 * @property {boolean} fullScreen whether the page is in HTML full screen, as
 *   in Presentation Mode
 */

/** @type {Map<string, Tab>} tab id -> tab */
const tabs = new Map();

const list = new TabList();

/** Windows whose events this module listens to. */
const adopted = new WeakSet();

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Opens a document in a new tab of `win`, and selects it. If the window's
 * active tab is Home, the document takes its place.
 *
 * @param {BrowserWindow} win
 * @param {string} token from documents.register()
 * @returns {Tab}
 */
export function openTab(win, token) {
  const active = win.isDestroyed() ? undefined : activeTab(win);
  const home = active?.kind === "home" ? active : undefined;
  const index = home ? list.tabsOf(win.id).indexOf(home.id) : undefined;
  const tab = addTab(win, "document", token, index);
  if (home) closeTab(home);
  return tab;
}

/**
 * Opens Home in a new tab of `win`, after its active tab, and selects it.
 *
 * @param {BrowserWindow} win
 * @returns {Tab}
 */
export function openHomeTab(win) {
  const active = win.isDestroyed() ? undefined : activeTab(win);
  const index = active ? list.tabsOf(win.id).indexOf(active.id) + 1 : undefined;
  return addTab(win, "home", null, index);
}

/**
 * @param {BrowserWindow} win
 * @param {"document" | "home"} kind
 * @param {string | null} token the document's, or null for Home
 * @param {number} [index] where the tab goes; defaults to the end
 * @returns {Tab}
 */
function addTab(win, kind, token, index) {
  adopt(win);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: kind === "home" ? homePreloadPath : preloadPath,
    },
  });
  const { webContents } = view;
  /** @type {Tab} */
  const tab = {
    id: randomUUID(),
    kind,
    token,
    view,
    webContents,
    title: "",
    edited: false,
    fullScreen: false,
  };
  tab.title = documentName(tab);
  tabs.set(tab.id, tab);
  list.add(win.id, tab.id, index);

  if (kind === "home") keepOnHome(webContents);
  else keepOnViewer(webContents);
  // pdf.js zooms the pages on a pinch. Chromium's own pinch zoom, which
  // Electron leaves off by default, would scale the whole viewer. Setting the
  // limits fails until there's a page to apply them to.
  webContents.on("did-finish-load", () => webContents.setVisualZoomLevelLimits(1, 1));
  // pdf.js's beforeunload handler blocks unloading whenever a document has
  // form data or annotations, even saved ones. The prompts in unsaved.js
  // replace it.
  webContents.on("will-prevent-unload", (event) => event.preventDefault());
  webContents.on("page-title-updated", (_event, title) => {
    if (kind === "home") return;
    tab.title = title;
    const tabWindow = windowOf(tab);
    if (tabWindow && activeTab(tabWindow) === tab) updateTitle(tabWindow);
  });
  // The window goes full screen for Presentation Mode, but the view keeps its
  // size: it has to fill the window, over the strip.
  webContents.on("enter-html-full-screen", () => setFullScreen(tab, true));
  webContents.on("leave-html-full-screen", () => setFullScreen(tab, false));
  // A page that goes away by other means than closeTab() takes its tab along,
  // once Electron has finished destroying it.
  webContents.once("destroyed", () => {
    setImmediate(() => {
      if (isOpen(tab)) closeTab(tab);
    });
  });

  win.contentView.addChildView(view);
  selectTab(tab);
  webContents.loadURL(token === null ? HOME_URL : viewerUrl(token, documentName(tab)));
  changed();
  return tab;
}

/**
 * Opens a new untitled document with one blank page in a new tab of `win`,
 * and selects it. It's called `Untitled.pdf`, or `Untitled 2.pdf` and so on,
 * with the lowest number no open tab has. Its page is US Letter or A4,
 * whichever the system's region uses. It stays in memory until it's saved.
 *
 * @param {BrowserWindow} win
 * @returns {Tab}
 */
export function newDocument(win) {
  const bytes = blankPdf(paperSize(app.getLocaleCountryCode()));
  return openTab(win, documents.registerUntitled(untitledName(), bytes));
}

/**
 * Makes a tab its window's active tab: shown, in the title, and, with
 * `focus`, the one keys go to.
 *
 * @param {Tab} tab
 * @param {{ focus?: boolean }} [options]
 */
export function selectTab(tab, { focus = true } = {}) {
  const win = windowOf(tab);
  if (!win) return;
  list.activate(tab.id);
  layout(win);
  if (isMac) win.setRepresentedFilename(documentFile(tab) ?? "");
  updateTitle(win);
  sendState(win);
  if (focus) focusTab(tab);
  changed();
}

/**
 * Moves a tab to `index` among the tabs of `win`, its own window or another,
 * and selects it. A window left without tabs closes. It asks about nothing,
 * since the tab lives on.
 *
 * @param {Tab} tab
 * @param {BrowserWindow} win
 * @param {number} [index] from 0 to the number of other tabs in `win`;
 *   defaults to the end
 */
export function moveTab(tab, win, index) {
  const from = windowOf(tab);
  if (!from) return;
  adopt(win);
  const others = list.tabsOf(win.id).filter((id) => id !== tab.id).length;
  list.move(tab.id, win.id, index ?? others);
  if (from !== win) {
    from.contentView.removeChildView(tab.view);
    win.contentView.addChildView(tab.view);
    // Electron gives the tab's page its new window, so menus and dialogs
    // attached to it follow. The page doesn't reload.
  }
  selectTab(tab);
  if (from !== win) afterTabLeft(from);
}

/**
 * Closes a tab, and its window if it was the last one there. It asks about
 * nothing: unsaved.js has done that.
 *
 * @param {Tab} tab
 */
export function closeTab(tab) {
  const win = windowOf(tab);
  discard(tab);
  if (win) afterTabLeft(win);
  changed();
}

/** @returns {Tab[]} every open tab, in every window */
export function allTabs() {
  return [...tabs.values()];
}

/**
 * @param {Electron.WebContents} webContents
 * @returns {Tab | undefined} the tab whose page `webContents` shows
 */
export function fromWebContents(webContents) {
  for (const tab of tabs.values()) {
    if (tab.webContents === webContents) return tab;
  }
}

/**
 * @param {BrowserWindow} win
 * @param {unknown} id
 * @returns {Tab | undefined} the tab with that id, if it's in `win`
 */
export function tabInWindow(win, id) {
  const tab = typeof id === "string" ? tabs.get(id) : undefined;
  return tab && list.windowOf(tab.id) === win.id ? tab : undefined;
}

/**
 * @param {BrowserWindow} win
 * @returns {Tab | undefined} the tab `win` shows
 */
export function activeTab(win) {
  if (win.isDestroyed()) return undefined;
  const id = list.activeTab(win.id);
  return id === null ? undefined : tabs.get(id);
}

/**
 * @param {BrowserWindow} win
 * @returns {Tab[]} its tabs, left to right
 */
export function tabsOf(win) {
  if (win.isDestroyed()) return [];
  return list.tabsOf(win.id).map((id) => /** @type {Tab} */ (tabs.get(id)));
}

/**
 * @param {BrowserWindow} win
 * @returns {Tab | undefined} the tab right of the active one, or the first
 */
export function nextTab(win) {
  const id = list.next(win.id);
  return id === null ? undefined : tabs.get(id);
}

/**
 * @param {BrowserWindow} win
 * @returns {Tab | undefined} the tab left of the active one, or the last
 */
export function previousTab(win) {
  const id = list.previous(win.id);
  return id === null ? undefined : tabs.get(id);
}

/**
 * @param {Tab} tab
 * @returns {BrowserWindow | null} the window the tab is in, or null once it's
 *   closed
 */
export function windowOf(tab) {
  const id = list.windowOf(tab.id);
  const win = id === undefined ? null : BrowserWindow.fromId(id);
  return win && !win.isDestroyed() ? win : null;
}

/**
 * @param {Tab} tab
 * @returns {boolean} whether the tab shows Home rather than a document
 */
export function isHome(tab) {
  return tab.kind === "home";
}

/**
 * @param {BrowserWindow} win
 * @returns {Tab | undefined} a home tab of `win`, the leftmost
 */
export function homeTabOf(win) {
  return tabsOf(win).find(isHome);
}

/**
 * @param {string} file real path
 * @returns {Tab | undefined} the tab showing `file`
 */
export function findTab(file) {
  for (const tab of tabs.values()) {
    if (documentFile(tab) === file) return tab;
  }
}

/**
 * @param {Tab} tab
 * @returns {boolean} whether the tab is still open
 */
export function isOpen(tab) {
  return tabs.get(tab.id) === tab;
}

/**
 * @param {Tab} tab a document's
 * @returns {string}
 */
export function documentToken(tab) {
  return tab.token ?? "";
}

/**
 * @param {Tab} tab
 * @returns {string | undefined} the path of the file the tab shows, or
 *   undefined for an untitled document and for Home
 */
export function documentFile(tab) {
  return tab.token === null ? undefined : documents.resolve(tab.token);
}

/**
 * @param {Tab} tab
 * @returns {boolean} whether the tab shows a document from File > New that
 *   hasn't been saved yet
 */
export function isUntitled(tab) {
  return tab.token !== null && documents.untitled(tab.token) !== undefined;
}

/**
 * @param {Tab} tab
 * @returns {string} the name the tab, the title and the save prompt show: the
 *   file's, the untitled document's, or Home
 */
export function documentName(tab) {
  if (tab.token === null) return HOME_NAME;
  const file = documentFile(tab);
  return file ? path.basename(file) : (documents.untitled(tab.token)?.name ?? "");
}

/**
 * Makes a tab stand for `file`, after opening it or saving it under a new
 * name: in the strip, in the title bar's proxy icon on macOS while it's the
 * active tab, and in recent documents (File > Open Recent, plus the Dock menu
 * on macOS and the taskbar's jump list on Windows).
 *
 * @param {Tab} tab
 * @param {string} file real path
 */
export function setRepresentedFile(tab, file) {
  const win = windowOf(tab);
  if (win) {
    if (isMac && activeTab(win) === tab) win.setRepresentedFilename(file);
    sendState(win);
  }
  addRecentDocument(file);
}

/**
 * Records whether a tab's document has unsaved changes, and shows it: see
 * updateTitle(), and the strip's dot.
 *
 * @param {Tab} tab
 * @param {boolean} edited
 */
export function setEdited(tab, edited) {
  tab.edited = edited;
  const win = windowOf(tab);
  if (!win) return;
  updateTitle(win);
  sendState(win);
}

/**
 * @param {Tab} tab
 * @returns {boolean} whether the tab's document has unsaved changes
 */
export function isEdited(tab) {
  return tab.edited;
}

/**
 * @param {() => void} listener called whenever tabs open, close, move or
 *   get selected
 */
export function onTabsChange(listener) {
  listeners.add(listener);
}

/** @returns {string} `Untitled.pdf`, or `Untitled N.pdf` with the lowest N no open tab has */
function untitledName() {
  const names = new Set([...tabs.values()].map(documentName));
  for (let number = 1; ; number++) {
    const name = number === 1 ? "Untitled.pdf" : `Untitled ${number}.pdf`;
    if (!names.has(name)) return name;
  }
}

/**
 * Listens to a window's events the first time it gets a tab.
 *
 * @param {BrowserWindow} win
 */
function adopt(win) {
  if (adopted.has(win)) return;
  adopted.add(win);
  const { id } = win;
  // The content's size, rather than the window's: on Windows and Linux the
  // menu bar takes its room once the window shows, and gives it back in full
  // screen, without a resize.
  win.contentView.on("bounds-changed", () => layout(win));
  // Leaving the window's full screen, as with its green button, ends the
  // page's, as in Presentation Mode. Electron does that only for the window's
  // own page.
  win.on("leave-full-screen", () => {
    for (const tab of tabsOf(win)) {
      if (!tab.fullScreen || tab.webContents.isDestroyed()) continue;
      tab.webContents
        .executeJavaScript("document.fullscreenElement && document.exitFullscreen()")
        .catch(() => {});
    }
  });
  // Focusing a window focuses its own page, the strip. Keys go to the
  // document instead, as in browsers.
  win.on("focus", () => {
    const active = activeTab(win);
    if (active) focusTab(active);
  });
  win.webContents.on("did-finish-load", () => sendState(win));
  win.on("closed", () => {
    for (const tabId of list.tabsOf(id)) discard(/** @type {Tab} */ (tabs.get(tabId)));
    changed();
  });
}

/**
 * Forgets a tab and closes its page.
 *
 * @param {Tab} tab
 */
function discard(tab) {
  const win = windowOf(tab);
  if (win) win.contentView.removeChildView(tab.view);
  list.remove(tab.id);
  tabs.delete(tab.id);
  if (tab.token !== null) documents.unregister(tab.token);
  // Without waiting for beforeunload, which pdf.js would use to block it.
  if (!tab.webContents.isDestroyed()) tab.webContents.close();
}

/**
 * Sends keys to a tab's document.
 *
 * @param {Tab} tab
 */
function focusTab(tab) {
  if (!tab.webContents.isDestroyed()) tab.webContents.focus();
}

/**
 * Closes a window a tab has left if it has none left, or shows its new
 * active tab.
 *
 * @param {BrowserWindow} win
 */
function afterTabLeft(win) {
  const active = activeTab(win);
  if (active) selectTab(active, { focus: win.isFocused() });
  else win.close();
}

/**
 * Shows the active tab's view and hides the others. The view sits below the
 * strip, or fills the window while the strip is hidden or the page is full
 * screen.
 *
 * @param {BrowserWindow} win
 */
function layout(win) {
  const { width, height } = win.getContentBounds();
  const windowTabs = tabsOf(win);
  const active = activeTab(win);
  for (const tab of windowTabs) {
    const top = windowTabs.length > 1 && !tab.fullScreen ? STRIP_HEIGHT : 0;
    tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    tab.view.setVisible(tab === active);
  }
}

/**
 * @param {Tab} tab
 * @param {boolean} fullScreen
 */
function setFullScreen(tab, fullScreen) {
  tab.fullScreen = fullScreen;
  const win = windowOf(tab);
  if (win) layout(win);
}

/**
 * Titles a window after its active tab's page, or PDFLion while it's Home.
 * With one tab, the title also shows unsaved changes: `name.pdf — Edited` on
 * macOS, as Preview and TextEdit do, and `*name.pdf` on Windows and Linux, as
 * Notepad and gedit do. With several, the strip shows them on each tab. On
 * macOS the close button's dot means that some tab in the window has changes,
 * since closing would ask.
 *
 * @param {BrowserWindow} win
 */
function updateTitle(win) {
  const windowTabs = tabsOf(win);
  const active = activeTab(win);
  if (!active) return;
  const edited = windowTabs.length === 1 && active.edited;
  if (active.kind === "home") win.setTitle(app.name);
  else if (!edited) win.setTitle(active.title);
  else win.setTitle(isMac ? `${active.title} — Edited` : `*${active.title}`);
  if (isMac) win.setDocumentEdited(windowTabs.some((tab) => tab.edited));
}

/**
 * Sends the strip its window's tabs. The strip shows them with two tabs or
 * more, and is covered by the active tab's view with one.
 *
 * @param {BrowserWindow} win
 */
function sendState(win) {
  const active = activeTab(win);
  win.webContents.send(
    "pdflion-tabs:state",
    tabsOf(win).map((tab) => ({
      id: tab.id,
      name: documentName(tab),
      home: tab.kind === "home",
      edited: tab.edited,
      active: tab === active,
    })),
  );
}

/**
 * Keeps a home tab on Home, so `window.pdflionHome` never reaches another
 * page. Home has no links.
 *
 * @param {Electron.WebContents} webContents
 */
function keepOnHome(webContents) {
  webContents.on("will-navigate", (event) => {
    if (!isHomeUrl(event.url)) event.preventDefault();
  });
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/**
 * Keeps a tab on the viewer, so `window.pdflion` never reaches another page.
 * Links open in the default browser or mail app instead.
 *
 * @param {Electron.WebContents} webContents
 */
function keepOnViewer(webContents) {
  webContents.on("will-navigate", (event) => {
    if (!isViewerUrl(event.url)) event.preventDefault();
  });
  webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_PROTOCOLS.has(URL.parse(url)?.protocol ?? "")) shell.openExternal(url);
    return { action: "deny" };
  });
}

function changed() {
  for (const listener of listeners) listener();
}
