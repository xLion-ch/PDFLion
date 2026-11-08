/**
 * The web app's `window.pdflion`, which the desktop's preload.cjs gives
 * bridge.js there: it hands what bridge.js asks for to the shell (shell.js),
 * which keeps the documents, over a MessagePort. scripts/build-web.js
 * injects this classic script into the viewer's page, after keys.js and
 * before bridge.js.
 *
 * It also does what the desktop's preload and main do for the page: it
 * takes the shell's shortcuts, sends PDFs dropped on the page to the shell,
 * and opens only http, https and mailto links. It runs only in a frame of
 * the shell, since a `<meta>` CSP can't set frame-ancestors.
 *
 * The frame shares the shell's origin, so the messages give the code its
 * shape, not a security boundary.
 */
"use strict";

(() => {
  /** The app's folder, where the shell is: the viewer is at viewer/web/. */
  const BASE = new URL("../../", location.href);

  /** The links that open, as on the desktop. */
  const LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

  /** The drag data type of a tab dragged from the strip, as src/tabs/tabs.js sets it. */
  const TAB_TYPE = "application/x-pdflion-tab";

  if (!inShell()) {
    window.stop();
    location.replace("about:blank");
    throw new Error("PDFLion's viewer runs only in PDFLion.");
  }

  const commandKey = PDFLionKeys.commandKeyHere();
  const { port1: port, port2 } = new MessageChannel();
  window.parent.postMessage({ pdflion: "connect", kind: "viewer" }, location.origin, [port2]);

  /** @type {Map<number, (result: unknown) => void>} replies the page waits for */
  const replies = new Map();
  let lastRequest = 0;

  /** @type {((command: string) => unknown) | null} */
  let commandHandler = null;
  /** @type {{ id: number, command: string }[]} commands that came before bridge.js listened */
  const queuedCommands = [];

  /** @type {((settings: object) => void)[]} */
  const toolSettingsListeners = [];
  /** @type {((favourite: object) => void)[]} */
  const editFavouriteListeners = [];

  /** @type {((status: string | null) => void) | null} */
  let saveStatusListener = null;
  /** @type {string | null} the status the shell last sent */
  let saveStatus = null;

  /** Where the last context menu was asked for, for the menus the shell shows. */
  let menuAt = { x: 0, y: 0 };

  port.onmessage = ({ data }) => {
    switch (data?.type) {
      case "reply":
        replies.get(data.id)?.(data.result);
        replies.delete(data.id);
        break;
      case "command":
        if (commandHandler) runCommand(data.id, data.command);
        else queuedCommands.push(data);
        break;
      case "editFavourite":
        for (const listener of editFavouriteListeners) listener(data.favourite);
        break;
      case "toolSettings":
        for (const listener of toolSettingsListeners) listener(data.settings);
        break;
      case "saveStatus":
        saveStatus = data.status;
        saveStatusListener?.(saveStatus);
        break;
    }
  };

  /**
   * @param {string} type
   * @param {...unknown} args
   */
  function send(type, ...args) {
    port.postMessage({ type, args });
  }

  /**
   * @param {string} type
   * @param {...unknown} args
   * @returns {Promise<any>} the shell's reply
   */
  function request(type, ...args) {
    const id = ++lastRequest;
    port.postMessage({ type, id, args });
    return new Promise((resolve) => replies.set(id, resolve));
  }

  /**
   * @param {number} id
   * @param {string} command
   */
  async function runCommand(id, command) {
    let result = null;
    try {
      result = (await /** @type {Function} */ (commandHandler)(command)) ?? null;
    } catch (error) {
      console.error(`Command ${command} failed:`, error);
    }
    send("commandDone", id, result);
  }

  /** The file picker, which iPadOS opens only in response to a tap or a key. */
  let picker = /** @type {HTMLInputElement | null} */ (null);

  /** Opens the file picker, whose PDFs open as tabs. */
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

  window.pdflion = {
    commandKey,
    /** The web app saves by itself, has no native menu, and shares documents. */
    autosave: true,
    nativeMenu: false,
    /** @param {(command: string) => unknown} callback */
    onCommand(callback) {
      commandHandler = callback;
      for (const { id, command } of queuedCommands.splice(0)) runCommand(id, command);
    },
    /** @param {Uint8Array} bytes */
    save: (bytes) => request("save", bytes),
    /** The library has no other place to save to: Share sends it elsewhere. */
    saveAs: (/** @type {Uint8Array} */ bytes) => request("save", bytes),
    /** @param {boolean} edited */
    setEdited: (edited) => send("setEdited", edited),
    /**
     * @param {string} reason
     * @param {string[]} [items]
     */
    pageDialog: (reason, items) => request("pageDialog", reason, items),
    getToolSettings: () => request("getToolSettings"),
    /** @param {object} changes */
    setToolSettings: (changes) => send("setToolSettings", changes),
    /** @param {(settings: object) => void} callback */
    onToolSettingsChange(callback) {
      toolSettingsListeners.push(callback);
    },
    /** @param {object} favourite */
    showFavouriteMenu: (favourite) => send("favouriteMenu", favourite, menuAt.x, menuAt.y),
    /** @param {(favourite: object) => void} callback */
    onEditFavourite(callback) {
      editFavouriteListeners.push(callback);
    },
    /** Closes the shell's menu, once a long press that opened it drags its favourite. */
    closeMenu: () => send("closeMenu"),
    /** @param {object} view where the document is shown, which the shell keeps */
    setView: (view) => send("view", view),
    /** @param {Uint8Array} png */
    setThumbnail: (png) => send("thumbnail", png),
    /**
     * @param {Uint8Array | null} bytes the document as it is, or null for
     *   the shell's stored copy, which has every change
     * @returns {Promise<boolean>} whether it was shared
     */
    share: (bytes) => request("share", bytes),
    /** @param {(status: string | null) => void} callback */
    onSaveStatus(callback) {
      saveStatusListener = callback;
      callback(saveStatus);
    },
    showOpenPanel,
    newDocument: () => send("newDocument"),
    showAbout: () => send("showAbout"),
  };

  /**
   * @returns {boolean} whether the viewer is in a frame of the shell, at the
   *   app's folder on the same origin
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

  // The shell's shortcuts, before bridge.js and pdf.js see them. Open… opens
  // the picker here, in the key's handler, as iPadOS asks.
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

  // A pinch outside the pages zooms nothing, as in an app: Safari ignores
  // the viewport's maximum-scale. On the pages, pdf.js zooms the document.
  document.addEventListener("gesturestart", (event) => {
    const target = /** @type {Element | null} */ (event.target);
    if (!target?.closest?.("#viewerContainer")) event.preventDefault();
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

  /**
   * Whether pdf.js's thumbnails take the drag, to add the dropped files'
   * pages, as in preload.cjs.
   *
   * @param {DragEvent} event
   */
  function isThumbnailsDrag(event) {
    const { target } = event;
    return target instanceof Element && target.closest("#thumbnailsView.isDraggingFile") !== null;
  }

  // PDFs dropped on the page open as tabs, through the shell, which keeps
  // them, except those dropped on the thumbnails, whose pages pdf.js adds.
  // A tab dragged from the strip has nowhere else to go.
  window.addEventListener(
    "dragover",
    (event) => {
      const pdf = isPdfDrag(event);
      const tab = event.dataTransfer?.types.includes(TAB_TYPE) ?? false;
      if (!pdf && !tab) return;
      if (pdf && isThumbnailsDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      /** @type {DataTransfer} */ (event.dataTransfer).dropEffect = pdf ? "copy" : "none";
    },
    true,
  );

  window.addEventListener(
    "drop",
    (event) => {
      if (!isPdfDrag(event) || isThumbnailsDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = [.../** @type {DataTransfer} */ (event.dataTransfer).files].filter(
        (file) => file.type === "application/pdf",
      );
      if (files.length > 0) send("openFiles", files, true);
    },
    true,
  );

  /**
   * @param {string} href
   * @returns {boolean} whether a link to `href` may open: http, https and
   *   mailto, and places in the viewer itself
   */
  function mayOpen(href) {
    const url = URL.parse(href, location.href);
    if (!url) return false;
    if (url.origin === location.origin && url.pathname === location.pathname) return true;
    return LINK_PROTOCOLS.includes(url.protocol);
  }

  // Links in documents, which pdf.js opens in a new window.
  for (const type of ["click", "auxclick"]) {
    document.addEventListener(
      type,
      (event) => {
        const link = /** @type {Element | null} */ (event.target)?.closest?.("a[href]");
        if (link && !mayOpen(/** @type {HTMLAnchorElement} */ (link).href)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  const open = window.open.bind(window);
  /**
   * @param {string | URL} [url]
   * @param {...any} rest
   */
  window.open = (url, ...rest) => (url !== undefined && mayOpen(String(url)) ? open(url, ...rest) : null);
})();
