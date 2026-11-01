/**
 * The web app's alerts, prompts, menus and snackbars, which it shows in the
 * page where the desktop shows native ones. What they say comes from
 * src/shared/wording.js. Buttons go as on Apple's platforms, the default one
 * rightmost, and web.css styles them all in Material Design 3.
 */
import { CANCEL, OK } from "../shared/wording.js";

/** @typedef {import("../shared/wording.js").Text} Text */

/**
 * @typedef {object} DialogOptions
 * @property {string[]} buttons their labels, left to right
 * @property {string} defaultButton the one Return chooses, filled
 * @property {string | null} [cancelButton] the one Esc chooses, or null to
 *   settle with null
 * @property {boolean} [destructive] whether the default button destroys
 *   something, which its colour shows
 * @property {string} [input] a text field's value, for a prompt
 */

/** How long a snackbar shows, in ms: longer with an action to take. */
const SNACKBAR_TIME = 6000;
const SNACKBAR_ACTION_TIME = 10_000;

let lastId = 0;

/**
 * Shows a modal dialog.
 *
 * @param {Text} text
 * @param {DialogOptions} options
 * @returns {Promise<{ button: string | null, value: string }>} the button
 *   chosen, or null if Esc dismissed it without a cancel button, and the
 *   text field's value
 */
export function showDialog(text, { buttons, defaultButton, cancelButton = null, destructive = false, input }) {
  const id = ++lastId;
  const dialog = document.createElement("dialog");
  dialog.className = "dialog";
  const form = document.createElement("form");
  const message = element("h2", "message", text.message);
  message.id = `dialogMessage${id}`;
  dialog.setAttribute("aria-labelledby", message.id);
  form.append(message);
  if (text.detail) {
    const detail = element("p", "detail", text.detail);
    detail.id = `dialogDetail${id}`;
    dialog.setAttribute("aria-describedby", detail.id);
    form.append(detail);
  }
  /** @type {HTMLInputElement | null} */
  let field = null;
  if (input !== undefined) {
    field = document.createElement("input");
    field.type = "text";
    field.className = "field";
    field.value = input;
    field.setAttribute("aria-labelledby", message.id);
    form.append(field);
  }
  const row = element("div", "buttons", "");
  for (const label of buttons) {
    const button = element("button", "button", label);
    button.type = "submit";
    button.value = label;
    if (label === defaultButton) {
      button.classList.add("filled");
      if (destructive) button.classList.add("destructive");
      button.autofocus = field === null;
    }
    row.append(button);
  }
  form.append(row);
  dialog.append(form);

  return new Promise((resolve) => {
    // Return in the text field chooses the default button, not the first.
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const submitter = /** @type {HTMLButtonElement | null} */ (event.submitter);
      dialog.close(submitter?.value ?? defaultButton);
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      const button = dialog.returnValue === "" ? cancelButton : dialog.returnValue;
      resolve({ button, value: field?.value ?? "" });
    });
    document.body.append(dialog);
    dialog.showModal();
    if (field) {
      field.focus();
      // The name without its extension, as Files selects it.
      const dot = field.value.lastIndexOf(".");
      field.setSelectionRange(0, dot > 0 ? dot : field.value.length);
    }
  });
}

/**
 * @param {Text} text
 * @returns {Promise<void>} once it's dismissed
 */
export async function alert(text) {
  await showDialog(text, { buttons: [OK], defaultButton: OK, cancelButton: OK });
}

/**
 * Asks whether to go ahead, with Cancel and a button that does.
 *
 * @param {Text} text
 * @param {string} confirm the button that goes ahead
 * @param {{ cancelByDefault?: boolean, destructive?: boolean }} [options]
 *   cancelByDefault: whether Return cancels
 * @returns {Promise<boolean>} whether the user went ahead
 */
export async function confirm(text, confirm, { cancelByDefault = false, destructive = false } = {}) {
  const { button } = await showDialog(text, {
    buttons: [CANCEL, confirm],
    defaultButton: cancelByDefault ? CANCEL : confirm,
    cancelButton: CANCEL,
    destructive,
  });
  return button === confirm;
}

/**
 * Asks for a text, such as a name.
 *
 * @param {Text} text
 * @param {string} value the text to start from
 * @param {string} confirm the button that takes it
 * @returns {Promise<string | null>} the text, or null if cancelled
 */
export async function prompt(text, value, confirm) {
  const { button, value: entered } = await showDialog(text, {
    buttons: [CANCEL, confirm],
    defaultButton: confirm,
    cancelButton: CANCEL,
    input: value,
  });
  return button === confirm ? entered : null;
}

/** @type {{ dismiss: () => void } | null} */
let shownSnackbar = null;

/**
 * Shows a short message at the bottom for a while, in place of any other.
 *
 * @param {string} message
 * @param {{ action?: string, onAction?: () => void }} [options] a button,
 *   and what it does
 */
export function snackbar(message, { action, onAction } = {}) {
  shownSnackbar?.dismiss();
  const bar = element("div", "snackbar", "");
  bar.setAttribute("role", "status");
  bar.append(element("span", "text", message));
  const dismiss = () => {
    clearTimeout(timer);
    bar.remove();
    if (shownSnackbar === shown) shownSnackbar = null;
  };
  if (action && onAction) {
    const button = element("button", "action", action);
    button.type = "button";
    button.addEventListener("click", () => {
      dismiss();
      onAction();
    });
    bar.append(button);
  }
  const timer = setTimeout(dismiss, action ? SNACKBAR_ACTION_TIME : SNACKBAR_TIME);
  const shown = { dismiss };
  shownSnackbar = shown;
  document.body.append(bar);
}

/**
 * @typedef {object} MenuItem
 * @property {string} label
 * @property {() => void} [action]
 * @property {boolean} [checked] for an item that's on or off
 * @property {boolean} [disabled]
 * @property {boolean} [info] for a line that only tells, such as the storage used
 * @property {boolean} [separator] for a line between groups, without a label
 */

/**
 * Shows a menu at a place in the page, as a popover, which a press outside
 * it or Esc closes, and so does the page losing the focus, as to a frame.
 *
 * @param {MenuItem[]} items
 * @param {{ x: number, y: number }} at
 */
export function showMenu(items, { x, y }) {
  const menu = element("div", "menu", "");
  menu.setAttribute("role", "menu");
  menu.popover = "auto";
  for (const item of items) {
    if (item.separator) {
      menu.append(element("div", "separator", ""));
      continue;
    }
    if (item.info) {
      menu.append(element("div", "info", item.label));
      continue;
    }
    const button = element("button", "item", item.label);
    button.type = "button";
    button.tabIndex = -1;
    button.disabled = item.disabled ?? false;
    if (item.checked === undefined) {
      button.setAttribute("role", "menuitem");
    } else {
      button.setAttribute("role", "menuitemcheckbox");
      button.setAttribute("aria-checked", String(item.checked));
    }
    button.addEventListener("click", () => {
      menu.hidePopover();
      item.action?.();
    });
    menu.append(button);
  }

  const buttons = () =>
    /** @type {HTMLButtonElement[]} */ ([...menu.querySelectorAll("button:not(:disabled)")]);
  menu.addEventListener("keydown", (event) => {
    const all = buttons();
    const index = all.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    /** @type {HTMLButtonElement | undefined} */
    let next;
    if (event.key === "ArrowDown") next = all[(index + 1) % all.length];
    else if (event.key === "ArrowUp") next = all[(index - 1 + all.length) % all.length];
    else if (event.key === "Home") next = all[0];
    else if (event.key === "End") next = all.at(-1);
    else return;
    event.preventDefault();
    next?.focus();
  });
  const close = () => menu.hidePopover();
  menu.addEventListener("toggle", (event) => {
    if (/** @type {ToggleEvent} */ (event).newState !== "closed") return;
    window.removeEventListener("blur", close);
    menu.remove();
  });

  document.body.append(menu);
  menu.showPopover();
  // Within the page, below and right of the place, or wherever it fits.
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, innerWidth - width - 4));
  const top = y + height <= innerHeight - 4 ? y : Math.max(4, y - height);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  buttons()[0]?.focus();
  window.addEventListener("blur", close);
}

/**
 * Closes the menus showMenu() shows, as when what one is for is dragged
 * away after the long press that opened it.
 */
export function closeMenus() {
  for (const menu of document.querySelectorAll(".menu:popover-open")) {
    /** @type {HTMLElement} */ (menu).hidePopover();
  }
}

/**
 * @typedef {object} AboutText
 * @property {string} version PDFLion's
 * @property {string | null} pdfjsVersion
 * @property {{ heading: string, components: { name: string, by?: string, license?: string, url: string }[] }[]} credits
 */

/**
 * Shows PDFLion's version and credits, as the desktop's About panel does.
 *
 * @param {AboutText} about
 * @returns {Promise<void>}
 */
export function showAbout({ version, pdfjsVersion, credits }) {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog about";
  const form = document.createElement("form");
  const title = element("h2", "message", "PDFLion");
  title.id = `dialogMessage${++lastId}`;
  dialog.setAttribute("aria-labelledby", title.id);
  const versions = [`Version ${version}`, pdfjsVersion && `pdf.js ${pdfjsVersion}`];
  form.append(title, element("p", "detail", versions.filter(Boolean).join(" · ")));
  const list = element("div", "credits", "");
  for (const { heading, components } of credits) {
    list.append(element("h3", "", heading));
    const items = document.createElement("ul");
    for (const { name, by, license, url } of components) {
      const link = /** @type {HTMLAnchorElement} */ (element("a", "", name));
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const item = document.createElement("li");
      item.append(link, [by && ` by ${by}`, license && ` (${license})`].filter(Boolean).join(""));
      items.append(item);
    }
    list.append(items);
  }
  const row = element("div", "buttons", "");
  const ok = element("button", "button filled", OK);
  ok.type = "submit";
  ok.autofocus = true;
  row.append(ok);
  form.append(list, row);
  dialog.append(form);
  return new Promise((resolve) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} text
 * @returns {HTMLElement}
 */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
