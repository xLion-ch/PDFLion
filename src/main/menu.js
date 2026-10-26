/**
 * The native application menu: the menu bar on macOS, each window's menu bar
 * on Windows and Linux. Standard items use Electron roles. Items that act on
 * the document send a command to the focused window's bridge.js, and are
 * disabled while no document window is focused.
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
import { creditsText } from "./credits.js";
import { runCommand } from "./ipc.js";
import { aboutIconPath, pdfjsVersionPath } from "./paths.js";
import { clearRecentDocuments, onRecentDocumentsChange, recentDocuments } from "./recent.js";
import { isDocumentWindow, openDocument, showOpenPanel } from "./windows.js";

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

const REPOSITORY_URL = "https://github.com/c14ud3/PDFLion";

/** Ids of the items made by commandItem(), enabled only for documents. */
const documentItems = new Set();

export function installMenu() {
  setAboutPanel();
  setMenu();
  app.on("browser-window-focus", updateDocumentItems);
  app.on("browser-window-blur", updateDocumentItems);
  // Closing the focused window doesn't always emit a blur first.
  app.on("browser-window-created", (_event, win) => win.on("closed", updateDocumentItems));
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
    applicationVersion: isMac || isLinux ? version : `Version ${version}`,
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
  updateDocumentItems();
}

/** @returns {Electron.MenuItemConstructorOptions[]} */
function template() {
  return [
    ...onMac({ role: "appMenu" }),
    {
      label: "&File",
      submenu: [
        { label: "&Open…", accelerator: "CmdOrCtrl+O", click: () => showOpenPanel() },
        // The role is macOS only.
        isMac
          ? { role: "recentDocuments", submenu: [{ role: "clearRecentDocuments" }] }
          : recentDocumentsItem(),
        { type: "separator" },
        // Not the role's "Close Window" on macOS: Preview says Close.
        { role: "close", label: "&Close" },
        commandItem("&Save", "save", "CmdOrCtrl+S"),
        commandItem("Save &As…", "saveAs", "Shift+CmdOrCtrl+S"),
        { type: "separator" },
        commandItem("&Print…", "print", "CmdOrCtrl+P"),
        // Exit, which has no shortcut on Windows: Alt+F4 closes the window,
        // and closing the last one quits. Linux apps have Quit, with the
        // role's Ctrl+Q.
        ...onWindowsAndLinux(
          { type: "separator" },
          { role: "quit", label: isLinux ? "&Quit" : "E&xit" },
        ),
      ],
    },
    {
      // Electron's editMenu role for each platform, plus Find. Copy and Select
      // All act on the text layer, or on form fields and annotations while one
      // has focus.
      label: "&Edit",
      submenu: [
        { role: "undo", label: "&Undo" },
        { role: "redo", label: "&Redo" },
        { type: "separator" },
        { role: "cut", label: "Cu&t" },
        { role: "copy", label: "&Copy" },
        { role: "paste", label: "&Paste" },
        ...onMac({ role: "pasteAndMatchStyle" }),
        { role: "delete", label: "De&lete" },
        ...onWindowsAndLinux({ type: "separator" }),
        { role: "selectAll", label: "Select &All" },
        { type: "separator" },
        commandItem("&Find…", "find", "CmdOrCtrl+F"),
        ...onMac(
          { type: "separator" },
          {
            label: "Speech",
            submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
          },
        ),
      ],
    },
    {
      // Not the zoomIn and resetZoom roles: they scale the whole UI, not the page.
      label: "&View",
      submenu: [
        // Not Ctrl+Alt+S on Windows, which is AltGr+S, a character on many
        // keyboards. F4 is pdf.js's own shortcut for it, and Acrobat's.
        commandItem("Toggle &Sidebar", "toggleSidebar", isMac ? "Alt+Cmd+S" : "F4"),
        { type: "separator" },
        commandItem("&Actual Size", "actualSize", "CmdOrCtrl+0"),
        commandItem("Zoom &In", "zoomIn", "CmdOrCtrl+Plus"),
        // ⌘= as well, since + needs Shift on many keyboards.
        { ...commandItem("Zoom In", "zoomIn", "CmdOrCtrl+=", "zoomInEquals"), visible: false },
        commandItem("Zoom &Out", "zoomOut", "CmdOrCtrl+-"),
        { type: "separator" },
        commandItem("Rotate &Left", "rotateLeft", "CmdOrCtrl+L"),
        commandItem("Rotate &Right", "rotateRight", "CmdOrCtrl+R"),
        { type: "separator" },
        commandItem("&Presentation Mode", "presentation", "Shift+CmdOrCtrl+F"),
        // ⌃⌘F on macOS, F11 on Windows and Linux.
        { role: "togglefullscreen", label: "Toggle &Full Screen" },
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
    // closes.
    ...onMac({ role: "windowMenu" }),
    {
      role: "help",
      label: "&Help",
      submenu: [
        { label: "PDFLion on &GitHub", click: () => shell.openExternal(REPOSITORY_URL) },
        // On macOS, About is in the app menu.
        ...onWindowsAndLinux({ type: "separator" }, { role: "about", label: `&About ${app.name}` }),
      ],
    },
  ];
}

/**
 * File > Open Recent on Windows and Linux, from the list recent.js keeps. Like
 * Office, it numbers the files, and the numbers are their access keys.
 *
 * @returns {Electron.MenuItemConstructorOptions}
 */
function recentDocumentsItem() {
  const files = recentDocuments();
  const names = files.map((file) => path.basename(file));
  // The full path only where the name alone is ambiguous.
  const isUnique = (/** @type {string} */ name) => names.indexOf(name) === names.lastIndexOf(name);
  return {
    label: "Open &Recent",
    enabled: files.length > 0,
    submenu: [
      ...files.map((file, index) => ({
        label: `${numberAccessKey(index + 1)} ${escapeAccessKeys(isUnique(names[index]) ? names[index] : file)}`,
        click: () => openDocument(file),
      })),
      { type: "separator" },
      { label: "&Clear Recently Opened", click: () => clearRecentDocuments() },
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
 * An item that sends `command` to the focused window's bridge.js.
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
      if (win instanceof BrowserWindow && isDocumentWindow(win)) runCommand(win, command);
    },
  };
}

function updateDocumentItems() {
  const menu = Menu.getApplicationMenu();
  const enabled = isDocumentWindow(BrowserWindow.getFocusedWindow());
  for (const id of documentItems) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = enabled;
  }
}
