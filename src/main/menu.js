/**
 * The native application menu: the menu bar on macOS, each window's menu bar
 * on Windows and Linux. Standard items use Electron roles. Items that act on
 * the document send a command to the bridge.js of the focused window's active
 * tab, and are disabled unless that's a document. Items that act on tabs are
 * disabled where they can't act.
 *
 * On macOS, shortcuts follow Preview. Windows and Linux use Ctrl where macOS
 * uses ⌘, except where noted. bridge.js keeps pdf.js from acting on the ones
 * pdf.js also binds, so keep its isMenuShortcut() in sync with them.
 *
 * A `&` in a label marks the access key on Windows and Linux: `&File` opens
 * with Alt+F. macOS drops it (Electron's menu controller runs every label
 * through FixUpWindowsStyleLabel), so role items get labels that read as their
 * defaults there. A literal `&` is written `&&`.
 */
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, Menu, shell } from "electron";
import { creditsText } from "../shared/credits.js";
import { t } from "../shared/i18n.js";
import { runCommand } from "./ipc.js";
import { aboutIconPath, pdfjsVersionPath } from "./paths.js";
import { clearRecentDocuments, menuDocuments, onRecentDocumentsChange } from "./recent.js";
import { exportSettings, importSettings } from "./settingsfile.js";
import * as tabs from "./tabs.js";
import { closeTab } from "./unsaved.js";
import { automaticChecks, checkForUpdates, hasUpdater, setAutomaticChecks } from "./updates.js";
import {
  documentWindows,
  mergeAllWindows,
  moveTabToNewWindow,
  newDocument,
  openDocument,
  showHome,
  showOpenPanel,
} from "./windows.js";

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

const REPOSITORY_URL = "https://github.com/xLion-ch/PDFLion";

/** Ids of the items made by commandItem(), enabled only for documents. */
const documentItems = new Set();

/**
 * Ids of the items made by tabItem(), each enabled when its function says so.
 * @type {Map<string, (win: BrowserWindow | null) => boolean>}
 */
const tabItems = new Map();

/** @param {BrowserWindow | null} win */
const hasSeveralTabs = (win) => win !== null && tabs.tabsOf(win).length > 1;

/**
 * Whether the focused window's active tab is a document that has another
 * with it, to move to a window of its own.
 *
 * @param {BrowserWindow | null} win
 */
const canMoveToNewWindow = (win) =>
  activeDocument(win) !== undefined &&
  win !== null &&
  tabs.tabsOf(win).filter((tab) => !tabs.isHome(tab)).length > 1;

export function installMenu() {
  setAboutPanel();
  setMenu();
  app.on("browser-window-focus", updateItems);
  app.on("browser-window-blur", updateItems);
  // Closing the focused window doesn't always emit a blur first.
  app.on("browser-window-created", (_event, win) => win.on("closed", updateItems));
  tabs.onTabsChange(updateItems);
  // File > Open Recent lists them on Windows and Linux. On macOS the role does.
  if (!isMac) onRecentDocumentsChange(setMenu);
}

/**
 * The About panel: PDFLion's version, and the projects it's built on and with
 * (credits.js), with the versions of pdf.js, Electron, Chromium and Node.js.
 * macOS shows it from the app menu, Windows and Linux from Help > About
 * PDFLion. On Linux it's GTK's About dialog.
 */
function setAboutPanel() {
  const version = app.getVersion();
  const credits = creditsText({
    "pdf.js": pdfjsVersion(),
    Electron: process.versions.electron,
    Chromium: process.versions.chrome,
    "Node.js": process.versions.node,
  });
  app.setAboutPanelOptions({
    applicationName: app.name,
    // macOS adds "Version" itself, and GTK shows the version on its own line.
    applicationVersion: isMac || isLinux ? version : t("aboutVersion", { version }),
    // GTK's dialog has no credits, so they go below the version.
    ...(isLinux ? { copyright: credits } : { credits }),
    ...(isMac
      ? // Otherwise macOS adds the bundle's build number: Electron's in dev,
        // and the version again once packaged.
        { version: "" }
      : { iconPath: aboutIconPath }),
  });
}

/** @returns {string | null} the version of the pdf.js build being served */
function pdfjsVersion() {
  try {
    const { version } = JSON.parse(fs.readFileSync(pdfjsVersionPath, "utf8"));
    if (typeof version === "string") return version;
  } catch (error) {
    console.warn(`Couldn't read the pdf.js version from ${pdfjsVersionPath}:`, error);
  }
  return null;
}

function setMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
  updateItems();
}

/** @returns {Electron.MenuItemConstructorOptions[]} */
function template() {
  return [
    ...onMac(appMenu()),
    {
      label: t("menuFile"),
      submenu: [
        // pdf.js binds a plain N (next page), but not ⌘N or Ctrl+N. On macOS
        // it works without a window, like Open.
        {
          id: "newDocument",
          label: t("menuNew"),
          accelerator: "CmdOrCtrl+N",
          click: () => newDocument(),
        },
        { label: t("menuOpen"), accelerator: "CmdOrCtrl+O", click: () => showOpenPanel() },
        // The role is macOS only.
        isMac
          ? {
              role: "recentDocuments",
              label: t("menuOpenRecent"),
              submenu: [{ role: "clearRecentDocuments", label: t("menuClearMenu") }],
            }
          : recentDocumentsItem(),
        // Selects the window's home tab, or adds one. pdf.js binds a plain H
        // (the hand tool), but not ⇧⌘H or Ctrl+Shift+H. Like New, it works on
        // macOS without a window.
        {
          id: "home",
          label: t("menuHome"),
          accelerator: "Shift+CmdOrCtrl+H",
          click: (_item, win) => showHome(win instanceof BrowserWindow ? win : undefined),
        },
        { type: "separator" },
        {
          id: "closeTab",
          label: t("menuCloseTab"),
          accelerator: "CmdOrCtrl+W",
          // On Home, which stays, it closes the window, as a browser's
          // last tab does.
          click: (_item, win) => {
            const tab = win instanceof BrowserWindow ? tabs.activeTab(win) : undefined;
            if (tab) closeTab(tab);
            else closeWindow(win);
          },
        },
        {
          id: "closeWindow",
          label: t("menuCloseWindow"),
          accelerator: "Shift+CmdOrCtrl+W",
          click: (_item, win) => closeWindow(win),
        },
        commandItem(t("menuSave"), "save", "CmdOrCtrl+S"),
        commandItem(t("menuSaveAs"), "saveAs", "Shift+CmdOrCtrl+S"),
        { type: "separator" },
        commandItem(t("menuPrint"), "print", "CmdOrCtrl+P"),
        { type: "separator" },
        // The tool settings and favourites, to take to another computer. They
        // work without a window, like New.
        { id: "exportSettings", label: t("menuExportSettings"), click: () => exportSettings() },
        { id: "importSettings", label: t("menuImportSettings"), click: () => importSettings() },
        // Exit, which has no shortcut on Windows: Alt+F4 closes the window,
        // and closing the last one quits. Linux apps have Quit, with the
        // role's Ctrl+Q.
        ...onWindowsAndLinux(
          { type: "separator" },
          { role: "quit", label: isLinux ? t("menuQuit") : t("menuExit") },
        ),
      ],
    },
    {
      // Electron's editMenu role for each platform, plus Find, with Undo and
      // Redo reaching pdf.js's annotations too. Copy and Select All act on the
      // text layer, or on form fields and annotations while one has focus.
      label: t("menuEdit"),
      submenu: [
        undoItem(t("menuUndo"), "undo", "CmdOrCtrl+Z"),
        // The redo role's shortcuts.
        undoItem(t("menuRedo"), "redo", process.platform === "win32" ? "Ctrl+Y" : "Shift+CmdOrCtrl+Z"),
        { type: "separator" },
        { role: "cut", label: t("menuCut") },
        { role: "copy", label: t("menuCopy") },
        { role: "paste", label: t("menuPaste") },
        ...onMac({ role: "pasteAndMatchStyle", label: t("menuPasteAndMatchStyle") }),
        { role: "delete", label: t("menuDelete") },
        ...onWindowsAndLinux({ type: "separator" }),
        { role: "selectAll", label: t("menuSelectAll") },
        { type: "separator" },
        commandItem(t("menuFind"), "find", "CmdOrCtrl+F"),
        { type: "separator" },
        // A new page, as ⌘N is a new document. Preview's has no shortcut.
        commandItem(t("menuInsertBlankPage"), "insertBlankPage", "Shift+CmdOrCtrl+N"),
        // Turns the eraser on and off, as its button does.
        commandItem(t("menuEraser"), "eraser", "Shift+CmdOrCtrl+E"),
        ...onMac(
          { type: "separator" },
          {
            label: t("menuSpeech"),
            submenu: [
              { role: "startSpeaking", label: t("menuStartSpeaking") },
              { role: "stopSpeaking", label: t("menuStopSpeaking") },
            ],
          },
        ),
      ],
    },
    {
      // Not the zoomIn and resetZoom roles: they scale the whole UI, not the page.
      label: t("menuView"),
      submenu: [
        // Not Ctrl+Alt+S on Windows, which is AltGr+S, a character on many
        // keyboards. F4 is pdf.js's own shortcut for it, and Acrobat's.
        commandItem(t("menuToggleSidebar"), "toggleSidebar", isMac ? "Alt+Cmd+S" : "F4"),
        // ⌥⌘6 is Preview's Contact Sheet. Not Ctrl+Alt+6 on Windows, which is
        // AltGr+6, a character on many keyboards, so O for Overview there.
        commandItem(t("menuPageOverview"), "pageOverview", isMac ? "Alt+Cmd+6" : "Shift+Ctrl+O"),
        { type: "separator" },
        commandItem(t("menuActualSize"), "actualSize", "CmdOrCtrl+0"),
        commandItem(t("menuZoomIn"), "zoomIn", "CmdOrCtrl+Plus"),
        // ⌘= as well, since + needs Shift on many keyboards.
        { ...commandItem(t("menuZoomIn"), "zoomIn", "CmdOrCtrl+=", "zoomInEquals"), visible: false },
        commandItem(t("menuZoomOut"), "zoomOut", "CmdOrCtrl+-"),
        { type: "separator" },
        commandItem(t("menuRotateLeft"), "rotateLeft", "CmdOrCtrl+L"),
        commandItem(t("menuRotateRight"), "rotateRight", "CmdOrCtrl+R"),
        { type: "separator" },
        commandItem(t("menuPresentation"), "presentation", "Shift+CmdOrCtrl+F"),
        // ⌃⌘F on macOS, F11 on Windows and Linux.
        { role: "togglefullscreen", label: t("menuFullScreen") },
        // Windows and Linux apps have no Window menu.
        ...onWindowsAndLinux({ type: "separator" }, ...tabMenuItems()),
        ...(app.isPackaged
          ? []
          : [
              { type: "separator" },
              // Not the reload role, whose ⌘R is Rotate Right.
              { role: "forceReload" },
              { role: "toggleDevTools" },
            ]),
      ],
    },
    // Windows and Linux apps have no Window menu: the title bar minimizes and
    // closes. On macOS it's the windowMenu role's, with the tab items.
    ...onMac({
      role: "window",
      label: t("menuWindow"),
      submenu: [
        { role: "minimize", label: t("menuMinimize") },
        { role: "zoom", label: t("menuZoom") },
        { type: "separator" },
        ...tabMenuItems(),
        { type: "separator" },
        { role: "front", label: t("menuBringAllToFront") },
      ],
    }),
    {
      role: "help",
      label: t("menuHelp"),
      submenu: [
        { label: t("menuGitHub"), click: () => shell.openExternal(REPOSITORY_URL) },
        // On macOS, they and About are in the app menu.
        ...onWindowsAndLinux(...updateMenuItems()),
        ...onWindowsAndLinux({ type: "separator" }, { role: "about", label: t("menuAbout", { app: app.name }) }),
      ],
    },
  ];
}

/**
 * macOS's app menu: the appMenu role's own items, in PDFLion's language, and
 * where PDFLion updates itself, Check for Updates… after About.
 *
 * @returns {Electron.MenuItemConstructorOptions}
 */
function appMenu() {
  return {
    role: "appMenu",
    submenu: [
      { role: "about", label: t("menuAbout", { app: app.name }) },
      ...updateMenuItems(),
      { type: "separator" },
      { role: "services", label: t("menuServices") },
      { type: "separator" },
      { role: "hide", label: t("menuHide", { app: app.name }) },
      { role: "hideOthers", label: t("menuHideOthers") },
      { role: "unhide", label: t("menuShowAll") },
      { type: "separator" },
      { role: "quit", label: t("menuQuitApp", { app: app.name }) },
    ],
  };
}

/**
 * Check for Updates… and the checkbox for automatic checks, where PDFLion
 * updates itself (updates.js): after About in the app menu on macOS, and
 * before About, at the end of the Help menu, on Windows and Linux.
 *
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function updateMenuItems() {
  if (!hasUpdater) return [];
  return [
    { type: "separator" },
    { id: "checkForUpdates", label: t("menuCheckForUpdates"), click: () => checkForUpdates() },
    {
      id: "automaticUpdates",
      label: t("menuAutomaticUpdates"),
      type: "checkbox",
      checked: automaticChecks(),
      // Electron has flipped `checked` by then.
      click: (item) => setAutomaticChecks(item.checked),
    },
  ];
}

/**
 * The items that switch and move tabs, like Safari's: in the Window menu on
 * macOS, at the end of View on Windows and Linux. The extra shortcuts are
 * hidden items: ⇧⌘] and ⇧⌘[ on macOS, Ctrl+Page Down and Ctrl+Page Up on
 * Windows and Linux. pdf.js binds none of them (onKeyDown in web/app.js).
 *
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function tabMenuItems() {
  /** @param {BrowserWindow} win */
  const showNext = (win) => {
    const tab = tabs.nextTab(win);
    if (tab) tabs.selectTab(tab);
  };
  /** @param {BrowserWindow} win */
  const showPrevious = (win) => {
    const tab = tabs.previousTab(win);
    if (tab) tabs.selectTab(tab);
  };
  return [
    tabItem(t("menuPreviousTab"), "previousTab", "Ctrl+Shift+Tab", hasSeveralTabs, showPrevious),
    tabItem(t("menuNextTab"), "nextTab", "Ctrl+Tab", hasSeveralTabs, showNext),
    {
      ...tabItem(
        t("menuPreviousTab"),
        "previousTabAlternate",
        isMac ? "Shift+Cmd+[" : "Ctrl+PageUp",
        hasSeveralTabs,
        showPrevious,
      ),
      visible: false,
    },
    {
      ...tabItem(
        t("menuNextTab"),
        "nextTabAlternate",
        isMac ? "Shift+Cmd+]" : "Ctrl+PageDown",
        hasSeveralTabs,
        showNext,
      ),
      visible: false,
    },
    tabItem(t("menuMoveTab"), "moveTabToNewWindow", undefined, canMoveToNewWindow, (win) => {
      const tab = tabs.activeTab(win);
      if (tab) moveTabToNewWindow(tab);
    }),
    tabItem(
      t("menuMergeWindows"),
      "mergeAllWindows",
      undefined,
      () => documentWindows().length > 1,
      () => mergeAllWindows(),
    ),
  ];
}

/**
 * An item that acts on the tabs of the focused window.
 *
 * @param {string} label
 * @param {string} id unique
 * @param {string | undefined} accelerator
 * @param {(win: BrowserWindow | null) => boolean} isEnabled for the focused window
 * @param {(win: BrowserWindow) => void} run with the focused document window
 * @returns {Electron.MenuItemConstructorOptions}
 */
function tabItem(label, id, accelerator, isEnabled, run) {
  tabItems.set(id, isEnabled);
  return {
    id,
    label,
    accelerator,
    click: (_item, win) => {
      const focused = win instanceof BrowserWindow ? win : null;
      if (isEnabled(focused) && focused) run(focused);
    },
  };
}

/**
 * Edit > Undo or Redo. pdf.js keeps its own history of annotations, which
 * Chromium's undo and redo, those of the roles, don't reach. So bridge.js
 * gets the command first, and takes it while a drawing tool is on, unless
 * text is being typed, which Chromium undoes and redoes. pdf.js handles ⌘Z
 * and ⇧⌘Z itself while a drawing tool is on, before the menu sees them.
 *
 * @param {string} label
 * @param {"undo" | "redo"} command
 * @param {string} accelerator the role's
 * @returns {Electron.MenuItemConstructorOptions}
 */
function undoItem(label, command, accelerator) {
  return {
    id: command,
    label,
    accelerator,
    click: async (_item, win) => {
      const tab = win instanceof BrowserWindow ? activeDocument(win) : undefined;
      if (!tab) {
        // Another window, such as the About panel, as the role would.
        if (isMac) Menu.sendActionToFirstResponder(`${command}:`);
        return;
      }
      if ((await runCommand(tab, command)) === true || tab.webContents.isDestroyed()) return;
      tab.webContents[command]();
    },
  };
}

/**
 * Closes the focused window, which asks about each edited tab. On macOS,
 * without a document window in front, it closes whatever window is, such as
 * the About panel.
 *
 * @param {Electron.BaseWindow | undefined} win
 */
function closeWindow(win) {
  if (win) win.close();
  else if (isMac) Menu.sendActionToFirstResponder("performClose:");
}

/**
 * File > Open Recent on Windows and Linux, from the list recent.js keeps. Like
 * Office, it numbers the files, and the numbers are their access keys.
 *
 * @returns {Electron.MenuItemConstructorOptions}
 */
function recentDocumentsItem() {
  const files = menuDocuments();
  const names = files.map((file) => path.basename(file));
  // The full path only where the name alone is ambiguous.
  const isUnique = (/** @type {string} */ name) => names.indexOf(name) === names.lastIndexOf(name);
  return {
    label: t("menuOpenRecent"),
    enabled: files.length > 0,
    submenu: [
      ...files.map((file, index) => ({
        label: `${numberAccessKey(index + 1)} ${escapeAccessKeys(isUnique(names[index]) ? names[index] : file)}`,
        click: () => openDocument(file),
      })),
      { type: "separator" },
      { label: t("menuClearRecent"), click: () => clearRecentDocuments() },
    ],
  };
}

/**
 * @param {number} number
 * @returns {string} `number` with its last digit as access key: &1 to &9, 1&0
 */
function numberAccessKey(number) {
  return String(number).replace(/\d$/, "&$&");
}

/**
 * @param {string} text
 * @returns {string} `text` shown as is, without access keys
 */
function escapeAccessKeys(text) {
  return text.replaceAll("&", "&&");
}

/**
 * @param {Electron.MenuItemConstructorOptions[]} items
 * @returns {Electron.MenuItemConstructorOptions[]} `items` on macOS, else none
 */
function onMac(...items) {
  return isMac ? items : [];
}

/**
 * @param {Electron.MenuItemConstructorOptions[]} items
 * @returns {Electron.MenuItemConstructorOptions[]} `items` on Windows and
 *   Linux, else none
 */
function onWindowsAndLinux(...items) {
  return isMac ? [] : items;
}

/**
 * An item that sends `command` to the bridge.js of the focused window's
 * active tab.
 *
 * @param {string} label
 * @param {string} command a key of COMMANDS in bridge.js
 * @param {string} accelerator
 * @param {string} [id] defaults to `command`; ids must be unique
 * @returns {Electron.MenuItemConstructorOptions}
 */
function commandItem(label, command, accelerator, id = command) {
  documentItems.add(id);
  return {
    id,
    label,
    accelerator,
    click: (_item, win) => {
      const tab = win instanceof BrowserWindow ? activeDocument(win) : undefined;
      if (tab) runCommand(tab, command);
    },
  };
}

/**
 * @param {BrowserWindow | null} win
 * @returns {tabs.Tab | undefined} the window's active tab, if it's a document
 */
function activeDocument(win) {
  const tab = win ? tabs.activeTab(win) : undefined;
  return tab && !tabs.isHome(tab) ? tab : undefined;
}

function updateItems() {
  const menu = Menu.getApplicationMenu();
  const focused = BrowserWindow.getFocusedWindow();
  const enabled = activeDocument(focused) !== undefined;
  for (const id of documentItems) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = enabled;
  }
  for (const [id, isEnabled] of tabItems) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = isEnabled(focused);
  }
}
