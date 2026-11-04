/**
 * Home, a home tab's page: the recent documents as a grid of cards, and Open
 * and New. It draws what the host sends through `window.pdflionHome`, and
 * asks the host for everything else, naming documents by their ids. The host
 * opens a document in a new tab, after Home. On the desktop the host is main,
 * through src/preload/home.cjs, and in the web app the shell, through
 * src/web/home-host.js, where the documents are the library's, with their
 * sizes rather than their folders, and Home has an ⓘ menu rather than Clear.
 *
 * The grid is a list for screen readers. The arrow keys move through it,
 * Return opens a document, and Delete or Backspace takes it off the list.
 * The context menu is the host's.
 */
"use strict";

(() => {
  /**
   * @typedef {object} HomeDocument as the host sends it (src/main/home.js,
   *   src/web/home-host.js)
   * @property {string} id
   * @property {string} name
   * @property {string} [folder] where its file is, on the desktop
   * @property {number} [size] in bytes, in the web app
   * @property {number | null} openedAt in ms
   * @property {string | null} thumbnail its URL
   * @property {boolean} open whether a tab shows it
   * @property {boolean} missing whether its file is gone
   * @property {string | null} [status] a mark such as "Not in Files"
   */

  const api = window.pdflionHome;
  const list = /** @type {HTMLUListElement} */ (document.getElementById("documents"));
  const recent = /** @type {HTMLElement} */ (document.getElementById("recent"));
  const empty = /** @type {HTMLElement} */ (document.getElementById("empty"));

  /**
   * A long press with a finger or a pen, which opens a card's menu, as iPadOS
   * sends no contextmenu for one: this long, in ms, moving at most this far,
   * in CSS pixels.
   */
  const LONG_PRESS_TIME = 500;
  const LONG_PRESS_SLOP = 10;

  /** PDFLion's texts (src/shared/texts.js), in the language pdf.js picks too. */
  const t = /** @type {any} */ (globalThis).PDFLionTexts.translator(navigator.languages);
  document.documentElement.lang = t.locale;
  document.title = t("home");
  // The page's own texts, which home.html names by their ids.
  for (const element of document.querySelectorAll("[data-text]")) {
    element.textContent = t(/** @type {HTMLElement} */ (element).dataset.text);
  }
  for (const element of document.querySelectorAll("[data-label]")) {
    const label = t(/** @type {HTMLElement} */ (element).dataset.label);
    element.setAttribute("title", label);
    element.setAttribute("aria-label", label);
  }

  const relativeTime = new Intl.RelativeTimeFormat(t.locale, { numeric: "auto" });

  /** The units sizes are given in, such as `1.2 MB`, each with its size in bytes. */
  const SIZE_UNITS = /** @type {[string, number][]} */ ([
    ["gigabyte", 1e9],
    ["megabyte", 1e6],
    ["kilobyte", 1e3],
  ]);

  /** The units relative times are counted in, each with its length in ms. */
  const UNITS = /** @type {[Intl.RelativeTimeFormatUnit, number][]} */ ([
    ["year", 365 * 24 * 3600 * 1000],
    ["month", 30 * 24 * 3600 * 1000],
    ["week", 7 * 24 * 3600 * 1000],
    ["day", 24 * 3600 * 1000],
    ["hour", 3600 * 1000],
    ["minute", 60 * 1000],
  ]);

  /** @type {HomeDocument[]} */
  let documents = [];

  /** The id of the card the keyboard is on, which Tab reaches. */
  let current = /** @type {string | null} */ (null);

  api.onState((state) => {
    documents = state;
    render();
  });

  for (const button of document.querySelectorAll(".open")) {
    button.addEventListener("click", () => api.showOpenPanel());
  }
  for (const button of document.querySelectorAll(".new")) {
    button.addEventListener("click", () => api.newDocument());
  }
  const clear = /** @type {HTMLButtonElement} */ (document.getElementById("clear"));
  if (typeof api.clear === "function") clear.addEventListener("click", () => api.clear());
  else clear.remove();

  // The web app's menu of About, the pen setting and the storage used.
  const info = /** @type {HTMLButtonElement} */ (document.getElementById("info"));
  if (typeof api.showInfo === "function") {
    info.hidden = false;
    info.addEventListener("click", () => api.showInfo(info.getBoundingClientRect()));
  }

  function render() {
    const hadFocus = list.contains(document.activeElement);
    document.body.classList.toggle("empty", documents.length === 0);
    recent.hidden = documents.length === 0;
    empty.hidden = documents.length > 0;
    // Home lives as long as its window, so the keyboard comes back to the
    // newest card, unless it's on the list now.
    if (!hadFocus || !documents.some(({ id }) => id === current)) current = documents[0]?.id ?? null;
    list.replaceChildren(...documents.map(card));
    if (hadFocus) cardOf(current)?.focus();
  }

  /**
   * @param {HomeDocument} doc
   * @returns {HTMLLIElement}
   */
  function card(doc) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "card";
    button.dataset.id = doc.id;
    button.tabIndex = doc.id === current ? 0 : -1;
    button.classList.toggle("missing", doc.missing);

    const preview = document.createElement("span");
    preview.className = "preview";
    if (doc.thumbnail) {
      const image = document.createElement("img");
      image.src = doc.thumbnail;
      image.alt = "";
      image.draggable = false;
      preview.append(image);
    } else {
      preview.classList.add("blank");
    }

    const name = element("span", "name", doc.name);
    const where = doc.folder ?? (doc.size === undefined ? "" : formatSize(doc.size));
    const folder = element("span", "folder", where);
    const opened = doc.openedAt === null ? "" : timeAgo(doc.openedAt);
    const time = element("span", "time", opened);
    const marks = element("span", "marks", "");
    if (doc.open) marks.append(element("span", "mark", t("markOpen")));
    if (doc.missing) marks.append(element("span", "mark missing", t("markMissing")));
    if (doc.status) marks.append(element("span", "mark status", doc.status));

    button.append(preview, name, folder, time, marks);
    button.title = `${doc.name}\n${where}`;
    button.setAttribute(
      "aria-label",
      [
        doc.name,
        doc.folder === undefined ? where : t("inFolder", { folder: doc.folder }),
        opened && t("openedAgo", { time: opened }),
        doc.open && t("openInTab"),
        doc.missing && t("missing"),
        doc.status,
      ]
        .filter(Boolean)
        .join(", "),
    );
    item.append(button);
    return item;
  }

  /**
   * @param {string} tag
   * @param {string} className
   * @param {string} text
   * @returns {HTMLElement}
   */
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  /**
   * @param {number} bytes
   * @returns {string} such as `1.2 MB`, in decimal units, as the Files app gives them
   */
  function formatSize(bytes) {
    const [unit, size] = SIZE_UNITS.find(([, size]) => bytes >= size) ?? SIZE_UNITS[2];
    const format = new Intl.NumberFormat(t.locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
      maximumFractionDigits: 1,
    });
    return format.format(bytes / size);
  }

  /**
   * @param {number} time in ms
   * @returns {string} such as `yesterday` or `3 weeks ago`
   */
  function timeAgo(time) {
    const elapsed = Date.now() - time;
    for (const [unit, length] of UNITS) {
      if (Math.abs(elapsed) >= length) {
        return relativeTime.format(-Math.floor(elapsed / length), unit);
      }
    }
    return t("justNow");
  }

  /**
   * @param {string | null} id
   * @returns {HTMLButtonElement | null}
   */
  function cardOf(id) {
    return id === null ? null : list.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  }

  /**
   * @param {EventTarget | null} target
   * @returns {HTMLButtonElement | null} the card `target` is in
   */
  function cardAt(target) {
    return target instanceof Element ? target.closest(".card") : null;
  }

  /**
   * Makes a card the one the keyboard is on, and focuses it.
   *
   * @param {HTMLButtonElement} target
   */
  function moveTo(target) {
    for (const other of list.querySelectorAll(".card")) {
      /** @type {HTMLElement} */ (other).tabIndex = other === target ? 0 : -1;
    }
    current = target.dataset.id ?? null;
    target.focus();
  }

  list.addEventListener("click", (event) => {
    const target = cardAt(event.target);
    if (target?.dataset.id) api.open(target.dataset.id);
  });

  list.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const target = cardAt(event.target);
    if (!target?.dataset.id) return;
    moveTo(target);
    api.contextMenu(target.dataset.id);
  });

  followLongPresses(list, ".card");

  list.addEventListener("focusin", (event) => {
    const target = cardAt(event.target);
    if (target) moveTo(target);
  });

  // The arrow keys move through the grid as it's laid out: left and right
  // along the list, up and down by a row. Delete or Backspace takes the card
  // off the list, and the keyboard goes to the next one.
  list.addEventListener("keydown", (event) => {
    const target = cardAt(event.target);
    if (!target || event.altKey || event.ctrlKey || event.metaKey) return;
    const cards = /** @type {HTMLButtonElement[]} */ ([...list.querySelectorAll(".card")]);
    const index = cards.indexOf(target);
    const columns = columnCount(cards);
    /** @type {number | undefined} */
    let next;
    switch (event.key) {
      case "ArrowLeft":
        next = index - 1;
        break;
      case "ArrowRight":
        next = index + 1;
        break;
      case "ArrowUp":
        next = index - columns;
        break;
      case "ArrowDown":
        next = index + columns;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = cards.length - 1;
        break;
      case "Delete":
      case "Backspace": {
        event.preventDefault();
        const neighbour = cards[index + 1] ?? cards[index - 1];
        current = neighbour?.dataset.id ?? null;
        if (target.dataset.id) api.remove(target.dataset.id);
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    const card = cards[next];
    if (card) moveTo(card);
  });

  /**
   * @param {HTMLElement[]} cards
   * @returns {number} how many cards the grid's rows hold
   */
  function columnCount(cards) {
    const top = cards[0]?.getBoundingClientRect().top;
    const inFirstRow = cards.findIndex((card) => card.getBoundingClientRect().top !== top);
    return inFirstRow === -1 ? Math.max(cards.length, 1) : inFirstRow;
  }

  /**
   * Opens the context menu of an element after a long press with a finger or
   * a pen, of LONG_PRESS_TIME without moving more than LONG_PRESS_SLOP, which
   * iPadOS doesn't: it sends a contextmenu event where the press is. The
   * browser's own, as Chromium sends after a touch's long press, and a click
   * after the press, are dropped. As addLongPress() in src/viewer/bridge.js
   * does for favourites.
   *
   * @param {HTMLElement} container
   * @param {string} selector the elements in it with menus
   */
  function followLongPresses(container, selector) {
    /** Whether the last press opened a menu, until the next. */
    let opened = false;
    container.addEventListener("pointerdown", (down) => {
      opened = false;
      const target = down.target instanceof Element ? down.target.closest(selector) : null;
      if (!target || down.pointerType === "mouse" || down.button !== 0) return;
      const pressing = new AbortController();
      const { signal } = pressing;
      const stop = () => pressing.abort();
      const timer = setTimeout(() => {
        stop();
        opened = true;
        const { clientX, clientY } = down;
        const menu = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        });
        target.dispatchEvent(menu);
      }, LONG_PRESS_TIME);
      signal.addEventListener("abort", () => clearTimeout(timer));
      /** @param {PointerEvent} event */
      const moved = ({ pointerId, clientX, clientY }) => {
        const far = Math.hypot(clientX - down.clientX, clientY - down.clientY) > LONG_PRESS_SLOP;
        if (pointerId === down.pointerId && far) stop();
      };
      /** @param {PointerEvent} event */
      const ended = ({ pointerId }) => {
        if (pointerId === down.pointerId) stop();
      };
      window.addEventListener("pointermove", moved, { signal });
      window.addEventListener("pointerup", ended, { signal });
      window.addEventListener("pointercancel", ended, { signal });
      container.addEventListener("dragstart", stop, { signal });
      container.addEventListener("contextmenu", (event) => event.isTrusted && stop(), { signal });
    });
    // Before the page's own listeners.
    container.addEventListener(
      "contextmenu",
      (event) => {
        if (!event.isTrusted || !opened) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    container.addEventListener(
      "click",
      (event) => {
        if (!opened) return;
        opened = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    container.addEventListener("keydown", () => {
      opened = false;
    });
  }

  // Shows where PDFs dragged from the file manager would go. The preload
  // takes the drop.
  let dragDepth = 0;
  document.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    dragDepth++;
    document.body.classList.add("dropping");
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove("dropping");
  });
  document.addEventListener("drop", () => {
    dragDepth = 0;
    document.body.classList.remove("dropping");
  });
})();
