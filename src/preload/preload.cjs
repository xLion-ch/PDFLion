/**
 * Preload for viewer windows. It runs sandboxed in an isolated world, exposes
 * the small `window.pdflion` API that bridge.js uses, and sends dropped PDFs to
 * main.
 *
 * The channel names match src/main/ipc.js. A sandboxed preload can only
 * require a few built-in modules, so it can't import them from there.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("pdflion", {
  /** `darwin` or `win32`, for the shortcuts that differ between them. */
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

// Dropped PDFs open in their own window through main, which needs their paths
// for Save. Left alone, pdf.js would open them in this window as pathless
// blobs. Capturing on window runs before pdf.js's own listeners.
window.addEventListener(
  "dragover",
  (event) => {
    if (!isPdfDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
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
    if (paths.length > 0) ipcRenderer.send("pdflion:open-files", paths);
  },
  true,
);
