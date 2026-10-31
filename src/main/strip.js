/**
 * Messages from each window's tab strip, its context menu, and dragging tabs
 * within and between windows. The strip shows no PDF, but its messages are
 * checked like the viewer's: they must come from the top frame of a window's
 * own page showing the strip, every tab id must be a tab of that window, and
 * every index must be in range.
 *
 * A drag between windows is the operating system's: the strip puts the tab's
 * id on it, and the strip or the document it lands on reports the drop. Main
 * accepts a drop only for the tab whose drag a strip reported starting.
 *
 * The channel names are repeated in src/preload/tabs.cjs, preload.cjs and
 * home.cjs, which can't import this module.
 */
import { BrowserWindow, ipcMain, Menu, screen } from "electron";
import { homeTab } from "./home.js";
import { fromViewer, isPathList } from "./ipc.js";
import { isTabsUrl } from "./routes.js";
import * as tabs from "./tabs.js";
import { closeOtherTabs, closeTab } from "./unsaved.js";
import { documentWindows, moveTabToNewWindow, openDocuments } from "./windows.js";

/**
 * Wayland doesn't tell apps where the pointer is outside their windows, so a
 * tab dropped where no window takes it can't tell a drop on the desktop from
 * a cancelled drag.
 */
const isWayland = process.platform === "linux" && Boolean(process.env.WAYLAND_DISPLAY);

/**
 * How long a drop may arrive after its drag ended. The drop comes from
 * another page than the drag, so their messages can reach main in either
 * order.
 */
const DROP_GRACE_MS = 1000;

/** Where a torn-off tab's window goes, relative to the pointer: its title bar under it. */
const TEAR_OFF_OFFSET = { x: 80, y: 12 };

/**
 * The tab being dragged, and the window it's dragged from, as its strip
 * reported them.
 * @type {{ tab: tabs.Tab, from: BrowserWindow } | null}
 */
let drag = null;

/** @type {NodeJS.Timeout | undefined} */
let dragTimer;

/** Must run once the app is ready, before any window loads. */
export function handleStrip() {
  ipcMain.on("pdflion-tabs:select", (event, id, focus) => {
    const tab = stripTab(event, id);
    if (tab && typeof focus === "boolean") tabs.selectTab(tab, { focus });
  });

  ipcMain.on("pdflion-tabs:close", (event, id) => {
    const tab = stripTab(event, id);
    if (tab) closeTab(tab);
  });

  ipcMain.on("pdflion-tabs:context-menu", (event, id) => {
    const tab = stripTab(event, id);
    if (tab) showContextMenu(tab);
  });

  // Reordering within one strip.
  ipcMain.on("pdflion-tabs:move", (event, id, index) => {
    const tab = stripTab(event, id);
    const win = tab && tabs.windowOf(tab);
    if (win && isIndex(index, tabs.tabsOf(win).length - 1)) tabs.moveTab(tab, win, index);
  });

  ipcMain.on("pdflion-tabs:open-files", (event, paths) => {
    const win = stripWindow(event);
    if (win && isPathList(paths)) openDocuments(paths, win);
  });

  ipcMain.on("pdflion-tabs:drag-started", (event, id) => {
    const tab = stripTab(event, id);
    const from = tab && tabs.windowOf(tab);
    if (!tab || !from) return;
    clearTimeout(dragTimer);
    drag = { tab, from };
  });

  // A tab dropped on another window's strip, at `index`.
  ipcMain.on("pdflion-tabs:drop", (event, id, index) => {
    const win = stripWindow(event);
    const tab = draggedTab(id);
    if (win && tab && isIndex(index, otherTabs(win, tab))) drop(tab, win, index);
  });

  // A tab dropped on a document or Home, which adds it as the last tab of
  // that window. Windows with one tab show no strip to drop on.
  ipcMain.on("pdflion:drop-tab", (event, id) => {
    const target = tabs.fromWebContents(event.sender);
    const win = target && fromViewer(event) ? tabs.windowOf(target) : null;
    const tab = draggedTab(id);
    if (win && tab) drop(tab, win, otherTabs(win, tab));
  });

  ipcMain.on("pdflion-home:drop-tab", (event, id) => {
    const target = homeTab(event);
    const win = target ? tabs.windowOf(target) : null;
    const tab = draggedTab(id);
    if (win && tab) drop(tab, win, otherTabs(win, tab));
  });

  ipcMain.on("pdflion-tabs:drag-ended", (event, id, dropEffect) => {
    const win = stripWindow(event);
    if (!win || drag?.tab.id !== id || drag.from !== win || typeof dropEffect !== "string") return;
    dragEnded(drag.tab, win, dropEffect);
  });
}

/**
 * The native context menu of a tab in the strip.
 *
 * @param {tabs.Tab} tab
 */
function showContextMenu(tab) {
  const win = tabs.windowOf(tab);
  if (!win) return;
  const several = tabs.tabsOf(win).length > 1;
  Menu.buildFromTemplate([
    { label: "Close Tab", click: () => closeTab(tab) },
    { label: "Close Other Tabs", enabled: several, click: () => closeOtherTabs(tab) },
    { type: "separator" },
    {
      label: "Move Tab to New Window",
      enabled: several,
      click: () => moveTabToNewWindow(tab),
    },
  ]).popup({ window: win });
}

/**
 * @param {tabs.Tab} tab
 * @param {BrowserWindow} win
 * @param {number} index
 */
function drop(tab, win, index) {
  endDrag();
  if (tabs.isOpen(tab)) tabs.moveTab(tab, win, index);
  win.focus();
}

/**
 * The source strip's drag ended. If no window took the tab and the pointer is
 * outside every window, the tab tears off into a window of its own under the
 * pointer. Otherwise a drop may still be on its way. On Wayland, a tab no
 * window took tears off once no drop has come.
 *
 * @param {tabs.Tab} tab
 * @param {BrowserWindow} from the window the tab was dragged from
 * @param {string} dropEffect what the drag's `dragend` reported
 */
function dragEnded(tab, from, dropEffect) {
  if (!tabs.isOpen(tab) || tabs.windowOf(tab) !== from) return endDrag();
  const point = screen.getCursorScreenPoint();
  if (dropEffect === "none" && !isWayland && !overWindow(point)) {
    endDrag();
    tearOff(tab, from, point);
    return;
  }
  dragTimer = setTimeout(() => {
    const dropped = !tabs.isOpen(tab) || tabs.windowOf(tab) !== from;
    if (isWayland && dropEffect === "none" && !dropped) tearOff(tab, from, null);
    endDrag();
  }, DROP_GRACE_MS);
}

/**
 * @param {tabs.Tab} tab
 * @param {BrowserWindow} from
 * @param {Electron.Point | null} point where the pointer is, if known
 */
function tearOff(tab, from, point) {
  if (tabs.tabsOf(from).length < 2) return;
  const { width, height } = from.getNormalBounds();
  moveTabToNewWindow(
    tab,
    point
      ? { x: point.x - TEAR_OFF_OFFSET.x, y: point.y - TEAR_OFF_OFFSET.y, width, height }
      : undefined,
  );
}

function endDrag() {
  clearTimeout(dragTimer);
  drag = null;
}

/**
 * @param {unknown} id
 * @returns {tabs.Tab | undefined} the tab being dragged, if that's `id`
 */
function draggedTab(id) {
  return drag && drag.tab.id === id && tabs.isOpen(drag.tab) ? drag.tab : undefined;
}

/**
 * @param {Electron.Point} point
 * @returns {boolean} whether one of PDFLion's windows is under `point`
 */
function overWindow({ x, y }) {
  return documentWindows().some((win) => {
    if (!win.isVisible() || win.isMinimized()) return false;
    const bounds = win.getBounds();
    return (
      x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height
    );
  });
}

/**
 * @param {BrowserWindow} win
 * @param {tabs.Tab} tab
 * @returns {number} how many tabs `win` has besides `tab`
 */
function otherTabs(win, tab) {
  return tabs.tabsOf(win).filter((other) => other !== tab).length;
}

/**
 * The window whose strip sent a message: the top frame of the window's own
 * page, showing the strip.
 *
 * @param {Electron.IpcMainEvent} event
 * @returns {BrowserWindow | null}
 */
function stripWindow(event) {
  const frame = event.senderFrame;
  if (frame === null || frame.parent !== null || !isTabsUrl(frame.url)) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && win.webContents === event.sender ? win : null;
}

/**
 * @param {Electron.IpcMainEvent} event
 * @param {unknown} id
 * @returns {tabs.Tab | undefined} the tab `id` names, if it's in the window
 *   whose strip sent the message
 */
function stripTab(event, id) {
  const win = stripWindow(event);
  return win ? tabs.tabInWindow(win, id) : undefined;
}

/**
 * @param {unknown} index
 * @param {number} max
 * @returns {index is number}
 */
function isIndex(index, max) {
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index <= max;
}
