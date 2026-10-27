/**
 * The tab strip, each window's own page. It draws the window's tabs as main
 * reports them through `window.pdflionTabs` (src/preload/tabs.cjs), and
 * reports clicks, keys and drags back. Main decides what happens to the tabs.
 *
 * Dragging uses HTML drag and drop, the operating system's, so a tab can be
 * dropped on another window, whose strip or document reports the drop to
 * main, or outside every window, which tears it off.
 */
"use strict";

(() => {
  /** The drag data type of a tab. The viewer's preload accepts it too. */
  const TAB_TYPE = "application/x-pdflion-tab";

  const api = window.pdflionTabs;
  const strip = /** @type {HTMLElement} */ (document.getElementById("tabs"));

  /** @typedef {{ id: string, name: string, edited: boolean, active: boolean }} TabState */

  /** @type {TabState[]} */
  let tabs = [];

  /**
   * Elements are kept from one state to the next, so a press on a tab that
   * main then selects can still become a drag.
   * @type {Map<string, HTMLElement>}
   */
  const elements = new Map();

  api.onState((state) => {
    tabs = state;
    render();
  });

  function render() {
    const ids = new Set(tabs.map(({ id }) => id));
    for (const [id, element] of elements) {
      if (!ids.has(id)) {
        element.remove();
        elements.delete(id);
      }
    }
    tabs.forEach((tab, index) => {
      let element = elements.get(tab.id);
      if (!element) {
        element = tabElement(tab.id);
        elements.set(tab.id, element);
      }
      update(element, tab);
      const current = strip.children[index] ?? null;
      if (current !== element) strip.insertBefore(element, current);
    });
  }

  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  function tabElement(id) {
    const element = document.createElement("div");
    element.className = "tab";
    element.dataset.id = id;
    element.setAttribute("role", "tab");
    element.draggable = true;

    const name = document.createElement("span");
    name.className = "name";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    const close = document.createElement("button");
    close.className = "close";
    close.tabIndex = -1;
    close.title = "Close Tab";
    element.append(name, dot, close);
    return element;
  }

  /**
   * @param {HTMLElement} element
   * @param {TabState} tab
   */
  function update(element, { name, edited, active }) {
    element.classList.toggle("active", active);
    element.classList.toggle("edited", edited);
    element.setAttribute("aria-selected", String(active));
    element.setAttribute("aria-label", edited ? `${name}, edited` : name);
    element.tabIndex = active ? 0 : -1;
    element.title = name;
    /** @type {HTMLElement} */ (element.querySelector(".name")).textContent = name;
    /** @type {HTMLElement} */ (element.querySelector(".close")).setAttribute(
      "aria-label",
      `Close ${name}`,
    );
  }

  /**
   * @param {EventTarget | null} target
   * @returns {HTMLElement | null} the tab element `target` is in
   */
  function tabAt(target) {
    return target instanceof Element ? target.closest(".tab") : null;
  }

  /** @param {EventTarget | null} target */
  function isCloseButton(target) {
    return target instanceof Element && target.closest(".close") !== null;
  }

  // Pressing a tab selects it, as in browsers, and keys then go to its
  // document. The middle button closes it instead.
  strip.addEventListener("mousedown", (event) => {
    const tab = tabAt(event.target);
    if (!tab) return;
    if (event.button === 1) {
      event.preventDefault(); // no autoscroll
    } else if (event.button === 0 && !isCloseButton(event.target)) {
      api.select(/** @type {string} */ (tab.dataset.id), true);
    }
  });

  strip.addEventListener("auxclick", (event) => {
    const tab = tabAt(event.target);
    if (tab && event.button === 1) api.close(/** @type {string} */ (tab.dataset.id));
  });

  strip.addEventListener("click", (event) => {
    const tab = tabAt(event.target);
    if (tab && isCloseButton(event.target)) api.close(/** @type {string} */ (tab.dataset.id));
  });

  strip.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const tab = tabAt(event.target);
    if (tab) api.contextMenu(/** @type {string} */ (tab.dataset.id));
  });

  // Arrow keys, Home and End move between tabs and select them, keeping the
  // keys in the strip. Enter and Space send them to the tab's document.
  strip.addEventListener("keydown", (event) => {
    const tab = tabAt(event.target);
    if (!tab || event.altKey || event.ctrlKey || event.metaKey) return;
    const all = /** @type {HTMLElement[]} */ ([...strip.children]);
    const index = all.indexOf(tab);
    /** @type {HTMLElement | undefined} */
    let next;
    switch (event.key) {
      case "ArrowLeft":
        next = all[(index - 1 + all.length) % all.length];
        break;
      case "ArrowRight":
        next = all[(index + 1) % all.length];
        break;
      case "Home":
        next = all[0];
        break;
      case "End":
        next = all.at(-1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        api.select(/** @type {string} */ (tab.dataset.id), true);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (!next) return;
    next.focus();
    api.select(/** @type {string} */ (next.dataset.id), false);
  });

  strip.addEventListener("dragstart", (event) => {
    const tab = tabAt(event.target);
    const dataTransfer = event.dataTransfer;
    if (!tab || !dataTransfer) return;
    const id = /** @type {string} */ (tab.dataset.id);
    dataTransfer.setData(TAB_TYPE, id);
    dataTransfer.effectAllowed = "move";
    tab.classList.add("dragging");
    api.dragStarted(id);
  });

  strip.addEventListener("dragend", (event) => {
    const tab = tabAt(event.target);
    if (!tab) return;
    tab.classList.remove("dragging");
    clearDropMarker();
    api.dragEnded(/** @type {string} */ (tab.dataset.id), event.dataTransfer?.dropEffect ?? "none");
  });

  strip.addEventListener("dragover", (event) => {
    if (!isTabDrag(event)) return;
    event.preventDefault();
    /** @type {DataTransfer} */ (event.dataTransfer).dropEffect = "move";
    showDropMarker(dropIndex(event.clientX));
  });

  strip.addEventListener("dragleave", (event) => {
    if (!(event.relatedTarget instanceof Node && strip.contains(event.relatedTarget))) {
      clearDropMarker();
    }
  });

  strip.addEventListener("drop", (event) => {
    if (!isTabDrag(event)) return;
    event.preventDefault();
    clearDropMarker();
    const id = /** @type {DataTransfer} */ (event.dataTransfer).getData(TAB_TYPE);
    const before = dropIndex(event.clientX);
    const from = tabs.findIndex((tab) => tab.id === id);
    if (from === -1) {
      api.drop(id, before);
      return;
    }
    // Where the tab ends up once it's out of its old place.
    const index = before > from ? before - 1 : before;
    if (index !== from) api.move(id, index);
  });

  /** @param {DragEvent} event */
  function isTabDrag(event) {
    return event.dataTransfer?.types.includes(TAB_TYPE) ?? false;
  }

  /**
   * @param {number} x
   * @returns {number} the index of the tab a drop at `x` goes before, or the
   *   number of tabs to go after the last
   */
  function dropIndex(x) {
    const children = [...strip.children];
    const index = children.findIndex((child) => {
      const { left, width } = child.getBoundingClientRect();
      return x < left + width / 2;
    });
    return index === -1 ? children.length : index;
  }

  /** @param {number} index from dropIndex() */
  function showDropMarker(index) {
    clearDropMarker();
    const { children } = strip;
    if (index < children.length) children[index].classList.add("drop-before");
    else children[children.length - 1]?.classList.add("drop-after");
  }

  function clearDropMarker() {
    for (const child of strip.children) child.classList.remove("drop-before", "drop-after");
  }
})();
