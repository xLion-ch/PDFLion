/**
 * What PDFLion's own alerts and prompts say: about changing pages, saving,
 * opening and updating. Main shows them as native message boxes, and a web
 * app's shell would show them in the page, so that both say the same. Each
 * platform orders the buttons as its own apps do, so this module only names
 * them, and the caller puts them in order.
 * PDFLion's own words are in English, like its native menus.
 * Free of Electron and Node, in src/shared/, so that the web app can use it
 * too, and unit tests under plain Node.
 */

/**
 * @typedef {object} Text what an alert or a prompt says
 * @property {string} message
 * @property {string} [detail]
 */

export const OK = "OK";
export const CANCEL = "Cancel";
export const SAVE = "Save";
export const DONT_SAVE = "Don’t Save";
export const RESTART_NOW = "Restart Now";
export const LATER = "Later";
export const RELEASE_NOTES = "Release Notes";
export const REMOVE = "Remove";

/**
 * What a save that rewrites the document drops, for `rewrite`, as its detail
 * names them. bridge.js's DROPPABLE lists the same items.
 * @type {Record<string, string>}
 */
const DROPPED_ITEMS = {
  xmp: "its XMP metadata",
  layers: "its layers",
  scripts: "its document scripts",
  "viewer-settings": "how it asks to be shown when it opens",
  tagging: "the tags that make it accessible",
  language: "the language setting screen readers use",
  info: "its title, author, subject and keywords",
  "page-labels": "its page labels",
};

/**
 * @typedef {object} PageDialogWords
 * @property {(name: string, items: string[]) => string} message
 * @property {(name: string, items: string[]) => string} detail
 * @property {string} [confirm] the button that goes ahead, for a prompt; an
 *   alert has only OK
 * @property {boolean} [cancelByDefault] whether Return cancels
 */

/**
 * The alerts and prompts about changing a document's pages, which bridge.js
 * asks for by their reason.
 * @type {Record<string, PageDialogWords>}
 */
const PAGE_DIALOGS = {
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
 * @returns {boolean} whether bridge.js may ask for this page dialog: a known
 *   reason, and known, distinct items for `rewrite` only. So a PDF can't
 *   choose what a dialog says.
 */
export function isPageDialog(reason, items) {
  if (typeof reason !== "string" || !Object.hasOwn(PAGE_DIALOGS, reason)) return false;
  if (reason !== "rewrite") return items === undefined;
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every((item) => typeof item === "string" && Object.hasOwn(DROPPED_ITEMS, item)) &&
    new Set(items).size === items.length
  );
}

/**
 * @param {string} reason checked with isPageDialog()
 * @param {string} name the document's
 * @param {string[]} [items] for `rewrite`
 * @returns {Text & { detail: string, confirm?: string, cancelByDefault: boolean }}
 *   a prompt, with `confirm`, which goes ahead, and Cancel, or an alert,
 *   with OK alone
 */
export function pageDialog(reason, name, items = []) {
  const { message, detail, confirm, cancelByDefault = false } = PAGE_DIALOGS[reason];
  return { message: message(name, items), detail: detail(name, items), confirm, cancelByDefault };
}

/**
 * The prompt before unsaved changes are lost, with Save, Don't Save and
 * Cancel.
 *
 * @param {string} name the document's
 * @returns {Text}
 */
export function savePrompt(name) {
  return {
    message: `Do you want to save the changes made to the document “${name}”?`,
    detail: "Your changes will be lost if you don’t save them.",
  };
}

/**
 * Why a save failed, by Node's error code. Phrased like macOS's "could not be
 * saved" alerts.
 * @type {Record<string, string>}
 */
const SAVE_ERRORS = {
  EACCES: "You don’t have permission to save the file.",
  EPERM: "You don’t have permission to save the file.",
  EROFS: "The volume is read-only.",
  ENOSPC: "There isn’t enough space on the disk.",
  // Windows: another app has the file open.
  EBUSY: "The file is in use by another app.",
};

/**
 * @param {string} name the file's
 * @param {{ code?: string, message: string }} error
 * @returns {Text}
 */
export function saveError(name, { code, message }) {
  return {
    message: `The document “${name}” could not be saved.`,
    detail: (code && Object.hasOwn(SAVE_ERRORS, code) && SAVE_ERRORS[code]) || message,
  };
}

/**
 * Why a file couldn't be opened, by Node's error code, as the end of the
 * alert's message. Phrased like Preview's "couldn't be opened because …"
 * alerts.
 * @type {Record<string, string>}
 */
const OPEN_ERRORS = {
  ENOENT: "there is no such file",
  EACCES: "you don’t have permission to view it",
  EPERM: "you don’t have permission to view it",
  EISDIR: "it isn’t a file",
};

/**
 * @param {string} name the file's
 * @param {{ code?: string, message: string }} error
 * @returns {Text} the reason, if it's a known one, or else the error's own
 *   message as the detail
 */
export function openError(name, { code, message }) {
  if (code && Object.hasOwn(OPEN_ERRORS, code)) {
    return { message: `The file “${name}” couldn’t be opened because ${OPEN_ERRORS[code]}.` };
  }
  return { message: `The file “${name}” couldn’t be opened.`, detail: message };
}

/**
 * The prompt for a recent document whose file is gone, which offers to take
 * it off the list, with Remove and Cancel.
 *
 * @param {string} name the file's
 * @returns {Text}
 */
export function missingRecent(name) {
  return {
    message: openError(name, { code: "ENOENT", message: "" }).message,
    detail: "It may have been moved, renamed or deleted. Do you want to remove it from the recent documents?",
  };
}

/**
 * @typedef {object} UpdateHost how this copy of PDFLion updates, which the
 *   texts about updates tell
 * @property {string} checkForUpdates where Check for Updates… is, such as
 *   `Help > Check for Updates…`
 * @property {boolean} needsPassword whether installing asks for an
 *   administrator's password, as on Linux, so that only Restart Now installs
 */

/** @returns {Text} */
export function updateCheckFailed() {
  return {
    message: "PDFLion couldn’t check for updates.",
    detail: "Check your internet connection, and try again later.",
  };
}

/**
 * @param {string} version the running one
 * @returns {Text}
 */
export function upToDate(version) {
  return { message: "PDFLion is up to date.", detail: `PDFLion ${version} is the latest version.` };
}

/**
 * @param {string} version the update's
 * @returns {Text}
 */
export function updateDownloadFailed(version) {
  return { message: `PDFLion ${version} couldn’t be downloaded.`, detail: "Try again later." };
}

/**
 * macOS: the app runs from a read-only copy, which can't be replaced.
 *
 * @param {string} version the update's
 * @param {UpdateHost} host
 * @returns {Text}
 */
export function updateOnReadOnlyVolume(version, { checkForUpdates }) {
  return {
    message: `PDFLion ${version} can’t be installed here.`,
    detail: `PDFLion can’t update itself while it runs from a disk image or from Downloads. Move it to the Applications folder, open it from there, and choose ${checkForUpdates} again.`,
  };
}

/**
 * @param {string} version the update's
 * @returns {Text}
 */
export function updateNotInstallable(version) {
  return {
    message: `PDFLion ${version} can’t be installed.`,
    detail: "Download it from PDFLion’s releases on GitHub instead.",
  };
}

/**
 * The prompt for a downloaded update, with Restart Now, Later and Release
 * Notes.
 *
 * @param {string} version the update's
 * @param {UpdateHost} host
 * @returns {Text}
 */
export function updateReady(version, { checkForUpdates, needsPassword }) {
  return {
    message: `PDFLion ${version} is ready to install.`,
    detail: needsPassword
      ? `Installing it asks for an administrator’s password. ${checkForUpdates} offers it again later.`
      : "It installs when PDFLion quits.",
  };
}

/**
 * @param {string} version the update's
 * @param {UpdateHost} host
 * @returns {Text}
 */
export function updateNotInstalled(version, { checkForUpdates, needsPassword }) {
  return {
    message: `PDFLion ${version} wasn’t installed.`,
    detail: needsPassword
      ? `Installing it needs an administrator’s password. ${checkForUpdates} offers it again.`
      : `${checkForUpdates} offers it again.`,
  };
}
