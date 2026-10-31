/**
 * Preload for home tabs. It runs sandboxed in an isolated world, exposes the
 * small `window.pdflionHome` API that src/home/home.js uses, and sends PDFs
 * dropped on Home to main, and tabs dropped on it from another window.
 *
 * The channel names match src/main/home.js and strip.js. A sandboxed preload
 * can only require a few built-in modules, so it can't import them from there.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Only Home gets window.pdflionHome. Main ignores messages from other pages,
// such as about:blank, as well. Electron runs a sandboxed preload as a
// function, so it can return early.
if (
  location.protocol !== "pdflion:" ||
  location.host !== "app" ||
  location.pathname !== "/home/home.html"
) {
  return;
}

contextBridge.exposeInMainWorld("pdflionHome", {
  /**
   * @param {(documents: object[]) => void} callback called with the recent
   *   documents, most recent first, now and whenever they change: `{ id,
   *   name, folder, openedAt, thumbnail, open, missing }` each
   */
  onState(callback) {
    ipcRenderer.on("pdflion-home:state", (_event, documents) => callback(documents));
    ipcRenderer.send("pdflion-home:ready");
  },
  /** @param {string} id opens that recent document, in place of Home */
  open: (id) => ipcRenderer.send("pdflion-home:open", id),
  /** Shows the Open panel, whose documents open in place of Home. */
  showOpenPanel: () => ipcRenderer.send("pdflion-home:show-open-panel"),
  /** Makes an untitled document, in place of Home. */
  newDocument: () => ipcRenderer.send("pdflion-home:new-document"),
  /** @param {string} id takes that document off the list */
  remove: (id) => ipcRenderer.send("pdflion-home:remove", id),
  /** Empties the list. */
  clear: () => ipcRenderer.send("pdflion-home:clear"),
  /** @param {string} id shows that document's file in Finder, Explorer or Files */
  showInFolder: (id) => ipcRenderer.send("pdflion-home:show-in-folder", id),
  /** @param {string} id shows main's context menu for that document */
  contextMenu: (id) => ipcRenderer.send("pdflion-home:context-menu", id),
});

/** The drag data type of a tab dragged from a strip, as src/tabs/tabs.js sets it. */
const TAB_TYPE = "application/x-pdflion-tab";

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

/** @param {DragEvent} event */
function isTabDrag(event) {
  return event.dataTransfer?.types.includes(TAB_TYPE) ?? false;
}

// Dropped PDFs open through main, which needs their paths for Save. A tab
// dragged from another window's strip joins this window, which shows no strip
// to drop it on while Home is its only tab.
window.addEventListener(
  "dragover",
  (event) => {
    const pdf = isPdfDrag(event);
    if (!pdf && !isTabDrag(event)) return;
    event.preventDefault();
    /** @type {DataTransfer} */ (event.dataTransfer).dropEffect = pdf ? "copy" : "move";
  },
  true,
);

window.addEventListener(
  "drop",
  (event) => {
    const dataTransfer = /** @type {DataTransfer} */ (event.dataTransfer);
    if (isTabDrag(event)) {
      event.preventDefault();
      ipcRenderer.send("pdflion-home:drop-tab", dataTransfer.getData(TAB_TYPE));
      return;
    }
    if (!isPdfDrag(event)) return;
    event.preventDefault();
    const paths = [...dataTransfer.files]
      .filter((file) => file.type === "application/pdf")
      .map((file) => webUtils.getPathForFile(file))
      .filter(Boolean);
    if (paths.length > 0) ipcRenderer.send("pdflion-home:open-files", paths);
  },
  true,
);
