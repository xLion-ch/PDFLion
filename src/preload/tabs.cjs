/**
 * Preload for each window's own page, the tab strip. It runs sandboxed in an
 * isolated world, exposes the small `window.pdflionTabs` API that
 * src/tabs/tabs.js uses, and sends PDFs dropped on the strip to main.
 *
 * The channel names match src/main/tabs.js and strip.js. A sandboxed preload
 * can only require a few built-in modules, so it can't import them from there.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Only the strip gets window.pdflionTabs, whatever else the window's page
// might come to show. Main ignores messages from other pages as well.
// Electron runs a sandboxed preload as a function, so it can return early.
if (
  location.protocol !== "pdflion:" ||
  location.host !== "app" ||
  location.pathname !== "/tabs/tabs.html"
) {
  return;
}

contextBridge.exposeInMainWorld("pdflionTabs", {
  /**
   * @param {(tabs: { id: string, name: string, home: boolean, edited: boolean, active: boolean }[]) => void} callback
   *   called with the window's tabs, left to right, whenever they change
   */
  onState(callback) {
    ipcRenderer.on("pdflion-tabs:state", (_event, tabs) => callback(tabs));
  },
  /**
   * @param {string} id
   * @param {boolean} focus whether keys then go to the tab's document
   */
  select: (id, focus) => ipcRenderer.send("pdflion-tabs:select", id, focus),
  /** @param {string} id a tab to close, asking first if it has changes */
  close: (id) => ipcRenderer.send("pdflion-tabs:close", id),
  /** @param {string} id the tab to show the context menu for */
  contextMenu: (id) => ipcRenderer.send("pdflion-tabs:context-menu", id),
  /**
   * @param {string} id one of this strip's tabs
   * @param {number} index where it ends up among them
   */
  move: (id, index) => ipcRenderer.send("pdflion-tabs:move", id, index),
  /** @param {string} id the tab whose drag started */
  dragStarted: (id) => ipcRenderer.send("pdflion-tabs:drag-started", id),
  /**
   * @param {string} id a tab dragged from another window
   * @param {number} index where it goes among this strip's tabs
   */
  drop: (id, index) => ipcRenderer.send("pdflion-tabs:drop", id, index),
  /**
   * @param {string} id the tab whose drag ended
   * @param {string} dropEffect what `dragend` reported
   */
  dragEnded: (id, dropEffect) => ipcRenderer.send("pdflion-tabs:drag-ended", id, dropEffect),
});

/**
 * The test pdf.js uses for a PDF drag, as in preload.cjs.
 *
 * @param {DragEvent} event
 */
function isPdfDrag(event) {
  return [...(event.dataTransfer?.items ?? [])].some(
    (item) => item.kind === "file" && item.type === "application/pdf",
  );
}

// PDFs dropped on the strip open as tabs of its window, through main, which
// needs their paths for Save.
window.addEventListener(
  "dragover",
  (event) => {
    if (!isPdfDrag(event)) return;
    event.preventDefault();
    /** @type {DataTransfer} */ (event.dataTransfer).dropEffect = "copy";
  },
  true,
);

window.addEventListener(
  "drop",
  (event) => {
    if (!isPdfDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const paths = [.../** @type {DataTransfer} */ (event.dataTransfer).files]
      .filter((file) => file.type === "application/pdf")
      .map((file) => webUtils.getPathForFile(file))
      .filter(Boolean);
    if (paths.length > 0) ipcRenderer.send("pdflion-tabs:open-files", paths);
  },
  true,
);
