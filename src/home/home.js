/**
 * Home, a home tab's page: the recent documents as a grid of cards, and Open
 * and New. It draws what main sends through `window.pdflionHome`
 * (src/preload/home.cjs), and asks main for everything else, naming documents
 * by their ids. Main opens a document in the home tab's place.
 *
 * The grid is a list for screen readers. The arrow keys move through it,
 * Return opens a document, and Delete or Backspace takes it off the list.
 * The context menu is main's.
 */
"use strict";

(() => {
  /**
   * @typedef {object} HomeDocument as main sends it (src/main/home.js)
   * @property {string} id
   * @property {string} name
   * @property {string} folder
   * @property {number | null} openedAt in ms
   * @property {string | null} thumbnail its URL
   * @property {boolean} open whether a tab shows it
   * @property {boolean} missing whether its file is gone
   */

  const api = window.pdflionHome;
  const list = /** @type {HTMLUListElement} */ (document.getElementById("documents"));
  const recent = /** @type {HTMLElement} */ (document.getElementById("recent"));
  const empty = /** @type {HTMLElement} */ (document.getElementById("empty"));

  /** English, like PDFLion's other own labels. */
  const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

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
  /** @type {HTMLElement} */ (document.getElementById("clear")).addEventListener("click", () =>
    api.clear(),
  );

  function render() {
    const hadFocus = list.contains(document.activeElement);
    document.body.classList.toggle("empty", documents.length === 0);
    recent.hidden = documents.length === 0;
    empty.hidden = documents.length > 0;
    if (!documents.some(({ id }) => id === current)) current = documents[0]?.id ?? null;
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
    const folder = element("span", "folder", doc.folder);
    const opened = doc.openedAt === null ? "" : timeAgo(doc.openedAt);
    const time = element("span", "time", opened);
    const marks = element("span", "marks", "");
    if (doc.open) marks.append(element("span", "mark", "Open"));
    if (doc.missing) marks.append(element("span", "mark missing", "Missing"));

    button.append(preview, name, folder, time, marks);
    button.title = `${doc.name}\n${doc.folder}`;
    button.setAttribute(
      "aria-label",
      [
        doc.name,
        `in ${doc.folder}`,
        opened && `opened ${opened}`,
        doc.open && "open in a tab",
        doc.missing && "missing",
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
    return "just now";
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
