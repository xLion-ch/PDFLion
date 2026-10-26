/**
 * The native application menu. Standard items use Electron roles. Items that
 * act on the document send a command to the focused window's bridge.js, and
 * are disabled while no document window is focused.
 *
 * Shortcuts follow Preview. bridge.js keeps pdf.js from acting on the ones
 * pdf.js also binds, so keep its isMenuShortcut() in sync with them.
 */
import { app, BrowserWindow, Menu, shell } from "electron";
import { runCommand } from "./ipc.js";
import { isDocumentWindow, showOpenPanel } from "./windows.js";

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
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "Open…", accelerator: "Cmd+O", click: () => showOpenPanel() },
        { role: "recentDocuments", submenu: [{ role: "clearRecentDocuments" }] },
        { type: "separator" },
        { role: "close" },
        commandItem("Save", "save", "Cmd+S"),
        commandItem("Save As…", "saveAs", "Shift+Cmd+S"),
        { type: "separator" },
        commandItem("Print…", "print", "Cmd+P"),
      ],
    },
    {
      // Electron's editMenu role, plus Find. Copy and Select All act on the
      // text layer, or on form fields and annotations while one has focus.
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        commandItem("Find…", "find", "Cmd+F"),
        { type: "separator" },
        {
          label: "Speech",
          submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
        },
      ],
    },
    {
      // Not the zoomIn and resetZoom roles: they scale the whole UI, not the page.
      label: "View",
      submenu: [
        commandItem("Toggle Sidebar", "toggleSidebar", "Alt+Cmd+S"),
        { type: "separator" },
        commandItem("Actual Size", "actualSize", "Cmd+0"),
        commandItem("Zoom In", "zoomIn", "Cmd+Plus"),
        // ⌘= as well, since + needs Shift on many keyboards.
        { ...commandItem("Zoom In", "zoomIn", "Cmd+=", "zoomInEquals"), visible: false },
        commandItem("Zoom Out", "zoomOut", "Cmd+-"),
        { type: "separator" },
        commandItem("Rotate Left", "rotateLeft", "Cmd+L"),
        commandItem("Rotate Right", "rotateRight", "Cmd+R"),
        { type: "separator" },
        commandItem("Presentation Mode", "presentation", "Shift+Cmd+F"),
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
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "PDFLion on GitHub", click: () => shell.openExternal(REPOSITORY_URL) },
      ],
    },
  ];
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
