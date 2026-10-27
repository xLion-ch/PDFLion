/**
 * Preload for the viewer in each tab. It runs sandboxed in an isolated world,
 * exposes the small `window.pdflion` API that bridge.js uses, and sends
 * dropped PDFs and tabs to main.
 *
 * The channel names match src/main/ipc.js and strip.js. A sandboxed preload
 * can only require a few built-in modules, so it can't import them from there.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The preload runs in every page a tab shows, not only in the viewer. The
// page can navigate to about:blank or about:srcdoc without will-navigate, and
// those must not get window.pdflion. Main ignores their messages as well.
// Electron runs a sandboxed preload as a function, so it can return early.
if (
  location.protocol !== "pdflion:" ||
  location.host !== "app" ||
  location.pathname !== "/viewer/web/viewer.html"
) {
  return;
}

contextBridge.exposeInMainWorld("pdflion", {
  /** `darwin`, `win32` or `linux`, for the shortcuts that differ between them. */
  platform: process.platform,
  /**
   * @param {(command: string) => unknown} callback called for each command
   *   from main. What it returns or resolves to goes back to main.
   */
  onCommand(callback) {
    ipcRenderer.on("pdflion:command", async (_event, id, command) => {
      let result = null;
      try {
        result = (await callback(command)) ?? null;
      } catch (error) {
        console.error(`Command ${command} failed:`, error);
      }
      ipcRenderer.send("pdflion:command-done", id, result);
    });
  },
  /**
   * @param {Uint8Array} bytes the whole document, to write over its file
   * @returns {Promise<string | null>} the document's `/doc/` path, or null if
   *   it wasn't saved
   */
  save: (bytes) => ipcRenderer.invoke("pdflion:save", bytes),
  /**
   * @param {Uint8Array} bytes the whole document, to write where the user picks
   * @returns {Promise<string | null>} the document's new `/doc/` path, or null
   *   if it wasn't saved
   */
  saveAs: (bytes) => ipcRenderer.invoke("pdflion:save-as", bytes),
  /** @param {boolean} edited whether the document has unsaved changes */
  setEdited: (edited) => ipcRenderer.send("pdflion:set-edited", edited),
});

/** The drag data type of a tab dragged from a strip, as src/tabs/tabs.js sets it. */
const TAB_TYPE = "application/x-pdflion-tab";

/**
 * The test pdf.js itself uses for a PDF drag (web/app.js). Other drags, such as
 * images for a stamp annotation, are left to pdf.js.
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

// Dropped PDFs open as tabs through main, which needs their paths for Save.
// Left alone, pdf.js would open them in this tab as pathless blobs. A tab
// dragged from another window's strip joins this window, which shows no strip
// to drop it on while it has one tab. Capturing on window runs before pdf.js's
// own listeners, so pdf.js never sees either drag.
window.addEventListener(
  "dragover",
  (event) => {
    const pdf = isPdfDrag(event);
    if (!pdf && !isTabDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
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
      event.stopPropagation();
      ipcRenderer.send("pdflion:drop-tab", dataTransfer.getData(TAB_TYPE));
      return;
    }
    if (!isPdfDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const paths = [...dataTransfer.files]
      .filter((file) => file.type === "application/pdf")
      .map((file) => webUtils.getPathForFile(file))
      .filter(Boolean);
    if (paths.length > 0) ipcRenderer.send("pdflion:open-files", paths);
  },
  true,
);
