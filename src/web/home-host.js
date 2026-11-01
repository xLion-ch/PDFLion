/**
 * The web app's `window.pdflionHome`, which the desktop's home.cjs gives
 * src/home/home.js there: it hands what Home asks for to the shell
 * (shell.js), which keeps the library, over a MessagePort, and turns the
 * thumbnails it sends into URLs Home can show. scripts/build-web.js injects
 * this classic script into Home's page, after keys.js and before home.js.
 *
 * Open… is a file picker in this page, since iPadOS opens one only in
 * response to a tap. PDFs dropped on Home go to the shell. It runs only in a
 * frame of the shell, like viewer-host.js.
 */
"use strict";

(() => {
  /** The app's folder, where the shell is: Home is at home/. */
  const BASE = new URL("../", location.href);

  if (!inShell()) {
    window.stop();
    location.replace("about:blank");
    throw new Error("PDFLion's Home runs only in PDFLion.");
  }

  const commandKey = PDFLionKeys.commandKeyHere();
  const { port1: port, port2 } = new MessageChannel();
  window.parent.postMessage({ pdflion: "connect", kind: "home" }, location.origin, [port2]);

  /** @type {((documents: object[]) => void) | null} */
  let stateListener = null;

  /**
   * The URLs of the thumbnails shown, by document id, with the version of
   * each that the shell sent, so that one is made only for a new thumbnail.
   * @type {Map<string, { version: number, url: string }>}
   */
  const thumbnails = new Map();

  /** Where the last context menu was asked for, for the menu the shell shows. */
  let menuAt = { x: 0, y: 0 };

  port.onmessage = ({ data }) => {
    if (data?.type === "state" && stateListener) stateListener(homeDocuments(data.documents));
  };

  /**
   * @param {string} type
   * @param {...unknown} args
   */
  function send(type, ...args) {
    port.postMessage({ type, args });
  }

  /**
   * @typedef {object} LibraryDocument as the shell sends it
   * @property {string} id
   * @property {string} name
   * @property {number} size in bytes
   * @property {number} openedAt in ms
   * @property {Blob | null} thumbnail
   * @property {number} thumbnailVersion
   * @property {boolean} open
   * @property {string | null} status such as "Not in Files"
   */

  /**
   * @param {LibraryDocument[]} documents
   * @returns {object[]} as home.js shows them, with URLs for the thumbnails
   */
  function homeDocuments(documents) {
    const ids = new Set(documents.map(({ id }) => id));
    for (const [id, { url }] of thumbnails) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(url);
        thumbnails.delete(id);
      }
    }
    return documents.map(({ id, name, size, openedAt, thumbnail, thumbnailVersion, open, status }) => ({
      id,
      name,
      size,
      openedAt,
      thumbnail: thumbnailUrl(id, thumbnail, thumbnailVersion),
      open,
      missing: false,
      status,
    }));
  }

  /**
   * @param {string} id
   * @param {Blob | null} blob
   * @param {number} version
   * @returns {string | null}
   */
  function thumbnailUrl(id, blob, version) {
    const shown = thumbnails.get(id);
    if (shown?.version === version) return shown.url;
    if (shown) URL.revokeObjectURL(shown.url);
    thumbnails.delete(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    thumbnails.set(id, { version, url });
    return url;
  }

  /** The file picker, which iPadOS opens only in response to a tap or a key. */
  let picker = /** @type {HTMLInputElement | null} */ (null);

  /** Opens the file picker, whose PDFs open in place of Home. */
  function showOpenPanel() {
    if (!picker) {
      picker = document.createElement("input");
      picker.type = "file";
      picker.accept = "application/pdf,.pdf";
      picker.multiple = true;
      picker.hidden = true;
      picker.addEventListener("change", () => {
        const files = [.../** @type {FileList} */ (/** @type {HTMLInputElement} */ (picker).files)];
        /** @type {HTMLInputElement} */ (picker).value = "";
        if (files.length > 0) send("openFiles", files, false);
      });
      document.body.append(picker);
    }
    picker.click();
  }

  window.pdflionHome = {
    /** @param {(documents: object[]) => void} callback */
    onState(callback) {
      stateListener = callback;
      send("ready");
    },
    /** @param {string} id */
    open: (id) => send("open", id),
    showOpenPanel,
    newDocument: () => send("newDocument"),
    /** @param {string} id deletes the document, once the user agrees */
    remove: (id) => send("remove", id),
    /** @param {string} id */
    contextMenu: (id) => send("contextMenu", id, menuAt.x, menuAt.y),
    /**
     * Shows the menu of About, the pen setting and the storage used, below
     * the button that asks for it.
     *
     * @param {DOMRect} rect the button's
     */
    showInfo: (rect) => send("infoMenu", rect.left, rect.bottom),
  };

  /**
   * @returns {boolean} whether Home is in a frame of the shell, at the app's
   *   folder on the same origin
   */
  function inShell() {
    try {
      if (window.parent === window) return false;
      const { origin, pathname } = window.parent.location;
      return (
        origin === location.origin &&
        (pathname === BASE.pathname || pathname === `${BASE.pathname}index.html`)
      );
    } catch {
      return false;
    }
  }

  // The shell's shortcuts. Open… opens the picker here, in the key's
  // handler, as iPadOS asks.
  window.addEventListener(
    "keydown",
    (event) => {
      const action = PDFLionKeys.shortcutOf(event, commandKey);
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action === "open") showOpenPanel();
      else send("key", action);
    },
    true,
  );

  window.addEventListener(
    "contextmenu",
    (event) => {
      menuAt = { x: event.clientX, y: event.clientY };
    },
    true,
  );

  /**
   * The test pdf.js uses for a PDF drag, as in home.cjs.
   *
   * @param {DragEvent} event
   */
  function isPdfDrag(event) {
    return [...(event.dataTransfer?.items ?? [])].some(
      (item) => item.kind === "file" && item.type === "application/pdf",
    );
  }

  // Dropped PDFs open in place of Home, through the shell, which keeps them.
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
      const files = [.../** @type {DataTransfer} */ (event.dataTransfer).files].filter(
        (file) => file.type === "application/pdf",
      );
      if (files.length > 0) send("openFiles", files, true);
    },
    true,
  );
})();
