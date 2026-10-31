/**
 * The tabs of each window, in order, and each window's active tab. Tabs and
 * windows are plain ids here: tabs.js keeps what they stand for.
 * Free of Electron and Node, in src/shared/, so that the web app can use it
 * too, and unit tests under plain Node.
 */

/**
 * @typedef {object} WindowTabs
 * @property {string[]} tabs tab ids, left to right
 * @property {string | null} active
 */

export class TabList {
  /** @type {Map<number, WindowTabs>} window id -> its tabs */
  #windows = new Map();

  /** @type {Map<string, number>} tab id -> window id */
  #windowOf = new Map();

  /**
   * Adds a new tab to a window. It becomes the active tab only if the window
   * had none.
   *
   * @param {number} windowId
   * @param {string} tabId not yet in any window
   * @param {number} [index] where it goes, from 0 to the number of tabs;
   *   defaults to the end
   */
  add(windowId, tabId, index) {
    if (this.#windowOf.has(tabId)) throw new Error(`Tab ${tabId} is already in a window`);
    const entry = this.#windows.get(windowId) ?? { tabs: [], active: null };
    const at = index ?? entry.tabs.length;
    checkIndex(at, entry.tabs.length);
    entry.tabs.splice(at, 0, tabId);
    entry.active ??= tabId;
    this.#windows.set(windowId, entry);
    this.#windowOf.set(tabId, windowId);
  }

  /**
   * Takes a tab out of its window. If it was the active tab, its right
   * neighbour becomes active, or its left one if it was last, as in browsers.
   *
   * @param {string} tabId
   * @returns {string | null} the window's active tab now, or null if the
   *   window has no tabs left or the tab was unknown
   */
  remove(tabId) {
    const windowId = this.#windowOf.get(tabId);
    if (windowId === undefined) return null;
    const entry = /** @type {WindowTabs} */ (this.#windows.get(windowId));
    const index = entry.tabs.indexOf(tabId);
    entry.tabs.splice(index, 1);
    this.#windowOf.delete(tabId);
    if (entry.tabs.length === 0) {
      this.#windows.delete(windowId);
      return null;
    }
    if (entry.active === tabId) entry.active = entry.tabs[Math.min(index, entry.tabs.length - 1)];
    return entry.active;
  }

  /**
   * Moves a tab to `index` in a window, its own or another one. Leaving a
   * window works like remove() there. In the window it joins, it becomes the
   * active tab only if that window had none.
   *
   * @param {string} tabId
   * @param {number} windowId
   * @param {number} index where it ends up, from 0 to the number of tabs the
   *   window has without it
   * @returns {boolean} false if the tab was unknown
   */
  move(tabId, windowId, index) {
    const from = this.#windowOf.get(tabId);
    if (from === undefined) return false;
    const target = this.#windows.get(windowId);
    const length = (target?.tabs.length ?? 0) - (from === windowId ? 1 : 0);
    checkIndex(index, length);

    if (from === windowId && target) {
      target.tabs.splice(target.tabs.indexOf(tabId), 1);
      target.tabs.splice(index, 0, tabId);
    } else {
      this.remove(tabId);
      this.add(windowId, tabId, index);
    }
    return true;
  }

  /**
   * @param {string} tabId
   * @returns {boolean} false if the tab was unknown
   */
  activate(tabId) {
    const windowId = this.#windowOf.get(tabId);
    if (windowId === undefined) return false;
    /** @type {WindowTabs} */ (this.#windows.get(windowId)).active = tabId;
    return true;
  }

  /**
   * @param {number} windowId
   * @returns {string | null} the tab right of the active one, wrapping around
   *   to the first, or null for a window without tabs
   */
  next(windowId) {
    return this.#neighbour(windowId, 1);
  }

  /**
   * @param {number} windowId
   * @returns {string | null} the tab left of the active one, wrapping around
   *   to the last, or null for a window without tabs
   */
  previous(windowId) {
    return this.#neighbour(windowId, -1);
  }

  /**
   * @param {number} windowId
   * @returns {string[]} the window's tabs, left to right
   */
  tabsOf(windowId) {
    return [...(this.#windows.get(windowId)?.tabs ?? [])];
  }

  /**
   * @param {string} tabId
   * @returns {number | undefined}
   */
  windowOf(tabId) {
    return this.#windowOf.get(tabId);
  }

  /**
   * @param {number} windowId
   * @returns {string | null}
   */
  activeTab(windowId) {
    return this.#windows.get(windowId)?.active ?? null;
  }

  /**
   * @param {number} windowId
   * @param {1 | -1} step
   * @returns {string | null}
   */
  #neighbour(windowId, step) {
    const entry = this.#windows.get(windowId);
    if (!entry?.active) return null;
    const { tabs } = entry;
    return tabs[(tabs.indexOf(entry.active) + step + tabs.length) % tabs.length];
  }
}

/**
 * @param {number} index
 * @param {number} max
 */
function checkIndex(index, max) {
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new RangeError(`Tab index ${index} is outside 0…${max}`);
  }
}
