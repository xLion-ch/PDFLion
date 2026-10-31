/**
 * Stands in for window.pdflion, which preload.cjs gives today's bridge.js on
 * the desktop, so that the trials show the viewer as PDFLion has it. Nothing
 * is saved. The tool settings live in localStorage, which every frame
 * shares, as main shares them between tabs. build.js injects this classic
 * script before bridge.js.
 */
"use strict";

(() => {
  const KEY = "trials.toolSettings";
  const DEFAULTS = { eraser: { mode: "object", size: 10 }, penOnly: false, favourites: [] };
  /** @type {((settings: object) => void)[]} */
  const listeners = [];

  function read() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /** @param {object} changes */
  function write(changes) {
    const settings = { ...read(), ...changes };
    localStorage.setItem(KEY, JSON.stringify(settings));
    for (const listener of listeners) listener(settings);
  }

  // Changes from other frames.
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    const settings = read();
    for (const listener of listeners) listener(settings);
  });

  window.pdflion = {
    // iPad keyboards use ⌘, as Macs do.
    commandKey: "meta",
    onCommand() {},
    save: async () => null,
    saveAs: async () => null,
    setEdited() {},
    async pageDialog(reason) {
      if (reason === "signed" || reason === "rewrite") {
        return confirm(`Page change: ${reason}. Go ahead?`);
      }
      alert(`Page change: ${reason}`);
      return false;
    },
    getToolSettings: async () => read(),
    setToolSettings: write,
    onToolSettingsChange(callback) {
      listeners.push(callback);
    },
    showFavouriteMenu(favourite) {
      if (!confirm("Remove Favourite?")) return;
      const key = JSON.stringify(favourite);
      write({ favourites: read().favourites.filter((other) => JSON.stringify(other) !== key) });
    },
  };
})();
