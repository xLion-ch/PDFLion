/**
 * The web app's keyboard shortcuts, which stand in for the desktop's native
 * menu: the same keys, with ⌘ on Apple's keyboards and Ctrl on others. ⌘P,
 * ⌘F and the zoom keys stay pdf.js's.
 *
 * A classic script, which defines `PDFLionKeys`, since the frames need it
 * before bridge.js runs, and before the viewer's own listeners: viewer-host.js
 * and home-host.js take a shortcut from the page and hand it to the shell,
 * which takes those pressed in the strip itself (shell.js).
 */
"use strict";

(() => {
  /**
   * @typedef {object} Shortcut
   * @property {string} action what the shell does, such as `closeTab`
   * @property {string} [key] `KeyboardEvent.key`, in lower case
   * @property {string} [code] `KeyboardEvent.code`, where the key the
   *   modifiers make, such as ⌥6's, isn't the key's own
   * @property {boolean} [shift]
   * @property {boolean} [alt]
   * @property {boolean} [ctrl] Control itself, as for ⌃Tab, rather than the
   *   command key
   */

  /**
   * As the desktop's menu has them (src/main/menu.js), with ⌘ or Ctrl.
   * @type {Record<"meta" | "ctrl", Shortcut[]>}
   */
  const SHORTCUTS = {
    meta: [
      { action: "open", key: "o" },
      { action: "newDocument", key: "n" },
      { action: "closeTab", key: "w" },
      { action: "save", key: "s" },
      { action: "share", key: "s", shift: true },
      { action: "insertBlankPage", key: "n", shift: true },
      { action: "pageOverview", code: "Digit6", alt: true },
      { action: "eraser", key: "e", shift: true },
      { action: "home", key: "h", shift: true },
      { action: "nextTab", key: "tab", ctrl: true },
      { action: "previousTab", key: "tab", ctrl: true, shift: true },
    ],
    // Ctrl+Alt+6 is AltGr+6 on many keyboards.
    ctrl: [
      { action: "open", key: "o" },
      { action: "newDocument", key: "n" },
      { action: "closeTab", key: "w" },
      { action: "save", key: "s" },
      { action: "share", key: "s", shift: true },
      { action: "insertBlankPage", key: "n", shift: true },
      { action: "pageOverview", key: "o", shift: true },
      { action: "eraser", key: "e", shift: true },
      { action: "home", key: "h", shift: true },
      { action: "nextTab", key: "tab", ctrl: true },
      { action: "previousTab", key: "tab", ctrl: true, shift: true },
    ],
  };

  /**
   * @param {Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">} event
   * @param {"meta" | "ctrl"} commandKey which modifier the shortcuts use
   * @returns {string | null} the shortcut's action, or null for any other key
   */
  function shortcutOf(event, commandKey) {
    const key = event.key.toLowerCase();
    const shortcut = SHORTCUTS[commandKey].find(
      (other) =>
        (other.code ? other.code === event.code : other.key === key) &&
        event.shiftKey === Boolean(other.shift) &&
        event.altKey === Boolean(other.alt) &&
        (other.ctrl
          ? event.ctrlKey && !event.metaKey
          : commandKey === "meta"
            ? event.metaKey && !event.ctrlKey
            : event.ctrlKey && !event.metaKey),
    );
    return shortcut?.action ?? null;
  }

  /**
   * @returns {"meta" | "ctrl"} ⌘ on Apple's devices, iPads included, which
   *   say they're Macs, and Ctrl elsewhere
   */
  function commandKeyHere() {
    return /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform) ? "meta" : "ctrl";
  }

  Object.defineProperty(globalThis, "PDFLionKeys", {
    value: Object.freeze({ shortcutOf, commandKeyHere }),
  });
})();
