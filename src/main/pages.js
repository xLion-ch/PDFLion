/**
 * The alerts and prompts about changing a document's pages, which bridge.js
 * asks for through `pdflion:page-dialog`. The page names a reason and, for a
 * save that rewrites the document, what it would drop, each from a fixed
 * list, so a PDF can't choose what a dialog says. Worded like saving.js.
 */
import { dialog } from "electron";
import * as tabs from "./tabs.js";

const isLinux = process.platform === "linux";

const CANCEL = "Cancel";

/**
 * What a save that rewrites the document drops, for `rewrite`, as its detail
 * names them.
 * @type {Record<string, string>}
 */
const DROPPED_ITEMS = {
  xmp: "its XMP metadata",
  layers: "its layers",
  scripts: "its document scripts",
  "viewer-settings": "how it asks to be shown when it opens",
  tagging: "the tags that make it accessible",
  info: "its title, author, subject and keywords",
  "page-labels": "its page labels",
};

/**
 * @typedef {object} PageDialog
 * @property {(name: string, items: string[]) => string} message
 * @property {(name: string, items: string[]) => string} detail
 * @property {string} [confirm] the button that goes ahead, for a prompt; an
 *   alert has only OK
 * @property {boolean} [cancelByDefault] whether Return cancels
 */

/** @type {Record<string, PageDialog>} */
const DIALOGS = {
  "locked-encrypted": {
    message: (name) => `The pages of the document “${name}” can’t be changed.`,
    detail: () => "The document is protected with a password.",
  },
  "locked-xfa": {
    message: (name) => `The pages of the document “${name}” can’t be changed.`,
    detail: () => "The document is an XFA form, which PDFLion can’t change pages of.",
  },
  failed: {
    message: (name) => `The pages of the document “${name}” couldn’t be changed.`,
    detail: () => "PDFLion can’t read the document well enough. It’s unchanged.",
  },
  signed: {
    message: (name) => `Changing pages invalidates the signatures in “${name}”.`,
    detail: () => "Checking them will show that the document changed after it was signed.",
    confirm: "Change Pages",
    cancelByDefault: true,
  },
  rewrite: {
    message: (name) => `Saving removes some information from “${name}”.`,
    detail: (_name, items) =>
      `Saving the changed pages removes ${new Intl.ListFormat("en").format(
        items.map((item) => DROPPED_ITEMS[item]),
      )}.`,
    confirm: "Save",
  },
};

/**
 * @param {unknown} reason
 * @param {unknown} items
 * @returns {boolean} whether bridge.js may ask for this dialog: a known
 *   reason, and known, distinct items for `rewrite` only
 */
export function isPageDialog(reason, items) {
  if (typeof reason !== "string" || !Object.hasOwn(DIALOGS, reason)) return false;
  if (reason !== "rewrite") return items === undefined;
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every((item) => typeof item === "string" && Object.hasOwn(DROPPED_ITEMS, item)) &&
    new Set(items).size === items.length
  );
}

/**
 * Shows a page dialog on a tab's window.
 *
 * @param {tabs.Tab} tab
 * @param {string} reason checked with isPageDialog()
 * @param {string[]} [items]
 * @returns {Promise<boolean>} for a prompt, whether the user went ahead; for
 *   an alert, false
 */
export async function showPageDialog(tab, reason, items = []) {
  const win = tabs.windowOf(tab);
  if (!win) return false;
  const { message, detail, confirm, cancelByDefault = false } = DIALOGS[reason];
  const name = tabs.documentName(tab);
  // macOS and Windows show the first button as the main one. GNOME puts it
  // last, rightmost.
  const buttons = !confirm ? ["OK"] : isLinux ? [CANCEL, confirm] : [confirm, CANCEL];
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message: message(name, items),
    detail: detail(name, items),
    buttons,
    defaultId: buttons.indexOf(cancelByDefault ? CANCEL : (confirm ?? "OK")),
    cancelId: confirm ? buttons.indexOf(CANCEL) : 0,
    noLink: true,
  });
  return confirm !== undefined && buttons[response] === confirm;
}
