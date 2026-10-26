/**
 * The native application menu: the menu bar on macOS, each window's menu bar
 * on Windows. Standard items use Electron roles. Items that act on the
 * document send a command to the focused window's bridge.js, and are disabled
 * while no document window is focused.
 *
 * On macOS, shortcuts follow Preview. Windows uses Ctrl where macOS uses ⌘,
 * except where noted. bridge.js keeps pdf.js from acting on the ones pdf.js
 * also binds, so keep its isMenuShortcut() in sync with them.
 */
import { app, BrowserWindow, Menu, shell } from "electron";
import { runCommand } from "./ipc.js";
import { isDocumentWindow, showOpenPanel } from "./windows.js";

const isMac = process.platform === "darwin";

const REPOSITORY_URL = "https://github.com/c14ud3/PDFLion";

/** Ids of the items made by commandItem(), enabled only for documents. */
const documentItems = new Set();

export function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
  updateDocumentItems();
  app.on("browser-window-focus", updateDocumentItems);
  app.on("browser-window-blur", updateDocumentItems);
  // Closing the focused window doesn't always emit a blur first.
  app.on("browser-window-created", (_event, win) => win.on("closed", updateDocumentItems));
}

/** @returns {Electron.MenuItemConstructorOptions[]} */
function template() {
  return [
    ...onMac({ role: "appMenu" }),
    {
      label: "File",
      submenu: [
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => showOpenPanel() },
        // The role is macOS only. Windows lists recent files in the taskbar's
        // jump list.
        ...onMac({ role: "recentDocuments", submenu: [{ role: "clearRecentDocuments" }] }),
        { type: "separator" },
        { role: "close" },
        commandItem("Save", "save", "CmdOrCtrl+S"),
        commandItem("Save As…", "saveAs", "Shift+CmdOrCtrl+S"),
        { type: "separator" },
        commandItem("Print…", "print", "CmdOrCtrl+P"),
        // Exit, which has no shortcut on Windows: Alt+F4 closes the window,
        // and closing the last one quits.
        ...onWindows({ type: "separator" }, { role: "quit" }),
      ],
    },
    {
      // Electron's editMenu role for each platform, plus Find. Copy and Select
      // All act on the text layer, or on form fields and annotations while one
      // has focus.
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...onMac({ role: "pasteAndMatchStyle" }),
        { role: "delete" },
        ...onWindows({ type: "separator" }),
        { role: "selectAll" },
        { type: "separator" },
        commandItem("Find…", "find", "CmdOrCtrl+F"),
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
      label: "View",
      submenu: [
        // Not Ctrl+Alt+S on Windows, which is AltGr+S, a character on many
        // keyboards. F4 is pdf.js's own shortcut for it, and Acrobat's.
        commandItem("Toggle Sidebar", "toggleSidebar", isMac ? "Alt+Cmd+S" : "F4"),
        { type: "separator" },
        commandItem("Actual Size", "actualSize", "CmdOrCtrl+0"),
        commandItem("Zoom In", "zoomIn", "CmdOrCtrl+Plus"),
        // ⌘= as well, since + needs Shift on many keyboards.
        { ...commandItem("Zoom In", "zoomIn", "CmdOrCtrl+=", "zoomInEquals"), visible: false },
        commandItem("Zoom Out", "zoomOut", "CmdOrCtrl+-"),
        { type: "separator" },
        commandItem("Rotate Left", "rotateLeft", "CmdOrCtrl+L"),
        commandItem("Rotate Right", "rotateRight", "CmdOrCtrl+R"),
        { type: "separator" },
        commandItem("Presentation Mode", "presentation", "Shift+CmdOrCtrl+F"),
        // ⌃⌘F on macOS, F11 on Windows.
        { role: "togglefullscreen" },
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
    // Windows apps have no Window menu: the title bar minimizes and closes.
    ...onMac({ role: "windowMenu" }),
    {
      role: "help",
      submenu: [
        { label: "PDFLion on GitHub", click: () => shell.openExternal(REPOSITORY_URL) },
        // On macOS, About is in the app menu.
        ...onWindows({ type: "separator" }, { role: "about" }),
      ],
    },
  ];
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
 * @returns {Electron.MenuItemConstructorOptions[]} `items` on Windows, else none
 */
function onWindows(...items) {
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
