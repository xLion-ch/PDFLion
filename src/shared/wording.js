/**
 * What PDFLion's own alerts and prompts say: about changing pages, saving,
 * opening, updating, Home, and exporting and importing settings, and in the
 * web app about the copies PDFLion keeps. Main shows them as native message
 * boxes, and the web app's shell (src/web/) in the page, so that both say the
 * same. Each platform orders the buttons as its
 * own apps do, so this module only names them, and the caller puts them in
 * order.
 * The words themselves are in texts.js, in each of PDFLion's languages, and
 * come in the one i18n.js has set. The buttons' names change with it, as
 * live bindings.
 * Free of Electron and Node, in src/shared/, so that the web app can use it
 * too, and unit tests under plain Node.
 */
import { list, locale, onLanguageChange, t } from "./i18n.js";

/**
 * @typedef {object} Text what an alert or a prompt says
 * @property {string} message
 * @property {string} [detail]
 */

export let OK = t("ok");
export let CANCEL = t("cancel");
export let SAVE = t("save");
export let DONT_SAVE = t("dontSave");
export let RESTART_NOW = t("restartNow");
export let LATER = t("later");
export let RELEASE_NOTES = t("releaseNotes");
export let REMOVE = t("remove");
export let IMPORT = t("import");
export let SHARE = t("share");
export let DELETE = t("delete");
export let RENAME = t("rename");
/** The button that closes a tab whose changes couldn't be saved. */
export let CLOSE = t("close");
/** Export…'s buttons. */
export let SETTINGS_ONLY = t("settingsOnly");
export let SETTINGS_AND_DOCUMENTS = t("settingsAndDocuments");

onLanguageChange(() => {
  OK = t("ok");
  CANCEL = t("cancel");
  SAVE = t("save");
  DONT_SAVE = t("dontSave");
  RESTART_NOW = t("restartNow");
  LATER = t("later");
  RELEASE_NOTES = t("releaseNotes");
  REMOVE = t("remove");
  IMPORT = t("import");
  SHARE = t("share");
  DELETE = t("delete");
  RENAME = t("rename");
  CLOSE = t("close");
  SETTINGS_ONLY = t("settingsOnly");
  SETTINGS_AND_DOCUMENTS = t("settingsAndDocuments");
});

/**
 * What a save that rewrites the document drops, for `rewrite`, as its detail
 * names them, by their texts' ids. bridge.js's DROPPABLE lists the same items.
 * @type {Record<string, string>}
 */
const DROPPED_ITEMS = {
  xmp: "droppedXmp",
  layers: "droppedLayers",
  scripts: "droppedScripts",
  "viewer-settings": "droppedViewerSettings",
  tagging: "droppedTagging",
  language: "droppedLanguage",
  info: "droppedInfo",
  "page-labels": "droppedPageLabels",
};

/**
 * @typedef {object} PageDialogWords
 * @property {(name: string, items: string[]) => string} message
 * @property {(name: string, items: string[]) => string} detail
 * @property {() => string} [confirm] the button that goes ahead, for a
 *   prompt; an alert has only OK
 * @property {boolean} [cancelByDefault] whether Return cancels
 */

/**
 * The alerts and prompts about changing a document's pages, which bridge.js
 * asks for by their reason.
 * @type {Record<string, PageDialogWords>}
 */
const PAGE_DIALOGS = {
  "locked-encrypted": {
    message: (name) => t("pagesLocked", { name }),
    detail: () => t("pagesLockedEncrypted"),
  },
  "locked-xfa": {
    message: (name) => t("pagesLocked", { name }),
    detail: () => t("pagesLockedXfa"),
  },
  failed: {
    message: (name) => t("pagesFailed", { name }),
    detail: () => t("pagesFailedDetail"),
  },
  signed: {
    message: (name) => t("pagesSigned", { name }),
    detail: () => t("pagesSignedDetail"),
    confirm: () => t("changePages"),
    cancelByDefault: true,
  },
  rewrite: {
    message: (name) => t("pagesRewrite", { name }),
    detail: (_name, items) =>
      t("pagesRewriteDetail", { items: list(items.map((item) => t(DROPPED_ITEMS[item]))) }),
    confirm: () => t("save"),
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
  return {
    message: message(name, items),
    detail: detail(name, items),
    confirm: confirm?.(),
    cancelByDefault,
  };
}

/**
 * The prompt before unsaved changes are lost, with Save, Don't Save and
 * Cancel.
 *
 * @param {string} name the document's
 * @returns {Text}
 */
export function savePrompt(name) {
  return { message: t("savePrompt", { name }), detail: t("savePromptDetail") };
}

/**
 * Why a save failed, by Node's error code. Phrased like macOS's "could not be
 * saved" alerts.
 * @type {Record<string, string>}
 */
const SAVE_ERRORS = {
  EACCES: "saveErrorPermission",
  EPERM: "saveErrorPermission",
  EROFS: "saveErrorReadOnly",
  ENOSPC: "saveErrorDiskFull",
  // Windows: another app has the file open.
  EBUSY: "saveErrorBusy",
  // The web app: the browser's storage for PDFLion is full.
  QuotaExceededError: "saveErrorQuota",
};

/**
 * @param {string} name the file's
 * @param {{ code?: string, message: string }} error
 * @returns {Text}
 */
export function saveError(name, error) {
  return { message: t("saveError", { name }), detail: whyNotSaved(error) };
}

/**
 * @param {{ code?: string, message: string }} error
 * @returns {string} why a file wasn't written, or the error's own message
 */
function whyNotSaved({ code, message }) {
  return code && Object.hasOwn(SAVE_ERRORS, code) ? t(SAVE_ERRORS[code]) : message;
}

/**
 * @param {string} name the file's
 * @returns {Text} that a file isn't a PDF, which the web app won't keep
 */
export function notAPdf(name) {
  return { message: t("openError", { name }), detail: t("notAPdfDetail") };
}

/**
 * Why a file couldn't be opened, by Node's error code: the alert's message.
 * Phrased like Preview's "couldn't be opened because …" alerts.
 * @type {Record<string, string>}
 */
const OPEN_ERRORS = {
  ENOENT: "openErrorNoFile",
  EACCES: "openErrorPermission",
  EPERM: "openErrorPermission",
  EISDIR: "openErrorNotFile",
};

/**
 * @param {string} name the file's
 * @param {{ code?: string, message: string }} error
 * @returns {Text} the reason, if it's a known one, or else the error's own
 *   message as the detail
 */
export function openError(name, { code, message }) {
  if (code && Object.hasOwn(OPEN_ERRORS, code)) {
    return { message: t(OPEN_ERRORS[code], { name }) };
  }
  return { message: t("openError", { name }), detail: message };
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
    detail: t("missingRecentDetail"),
  };
}

/**
 * The settings an import replaces, as its prompt names them.
 * @type {Record<string, string>}
 */
const SETTINGS = { eraser: "settingEraser", penOnly: "settingPen", automaticUpdates: "settingUpdates" };

/**
 * The prompt before settings are imported, with Import and Cancel.
 *
 * @param {string} name the file's
 * @param {object} changes
 * @param {string[]} changes.replaced the settings the file has, of `eraser`,
 *   `penOnly` and `automaticUpdates`
 * @param {number} changes.added how many of its favourites are new
 * @returns {Text}
 */
export function importSettingsPrompt(name, { replaced, added }) {
  return { message: t("importSettingsPrompt", { name }), detail: settingsChanges({ replaced, added }) };
}

/**
 * @param {{ replaced: string[], added: number }} changes as for importSettingsPrompt()
 * @returns {string} what importing settings changes
 */
function settingsChanges({ replaced, added }) {
  const settings = list(replaced.map((setting) => t(SETTINGS[setting])));
  const favourites =
    added === 0
      ? t("favouritesNone")
      : added === 1
        ? t("favouritesOne")
        : t("favouritesSome", { count: added });
  return replaced.length === 0
    ? `${favourites[0].toLocaleUpperCase(locale())}${favourites.slice(1)}.`
    : t("settingsReplaced", { settings, favourites });
}

/**
 * @param {string} name the file's
 * @returns {Text} that a settings file would change nothing
 */
export function nothingToImport(name) {
  return { message: t("nothingToImport", { name }), detail: t("nothingToImportDetail") };
}

/** @type {Record<import("./backup.js").SettingsFileError, string>} */
const SETTINGS_FILE_ERRORS = {
  "too-large": "settingsFileTooLarge",
  "not-settings": "settingsFileNotSettings",
  newer: "settingsFileNewer",
};

/**
 * @param {string} name the file's
 * @param {import("./backup.js").SettingsFileError} error what readSettingsFile() found
 * @returns {Text}
 */
export function settingsFileError(name, error) {
  return { message: t("settingsFileError", { name }), detail: t(SETTINGS_FILE_ERRORS[error]) };
}

/**
 * @param {string} name the file's
 * @param {{ code?: string, message: string }} error
 * @returns {Text}
 */
export function settingsExportError(name, error) {
  return { message: t("settingsExportError", { name }), detail: whyNotSaved(error) };
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
  return { message: t("updateCheckFailed"), detail: t("updateCheckFailedDetail") };
}

/**
 * @param {string} version the running one
 * @returns {Text}
 */
export function upToDate(version) {
  return { message: t("upToDate"), detail: t("upToDateDetail", { version }) };
}

/**
 * @param {string} version the update's
 * @returns {Text}
 */
export function updateDownloadFailed(version) {
  return { message: t("updateDownloadFailed", { version }), detail: t("tryAgainLater") };
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
    message: t("updateReadOnly", { version }),
    detail: t("updateReadOnlyDetail", { checkForUpdates }),
  };
}

/**
 * @param {string} version the update's
 * @returns {Text}
 */
export function updateNotInstallable(version) {
  return { message: t("updateNotInstallable", { version }), detail: t("updateNotInstallableDetail") };
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
    message: t("updateReady", { version }),
    detail: needsPassword ? t("updateReadyPassword", { checkForUpdates }) : t("updateReadyOnQuit"),
  };
}

/**
 * @param {string} version the update's
 * @param {UpdateHost} host
 * @returns {Text}
 */
export function updateNotInstalled(version, { checkForUpdates, needsPassword }) {
  return {
    message: t("updateNotInstalled", { version }),
    detail: needsPassword
      ? t("updateNotInstalledPassword", { checkForUpdates })
      : t("updateNotInstalledAgain", { checkForUpdates }),
  };
}

/**
 * The web app's prompt for a new version that has installed, with Restart
 * Now, Later and Release Notes. It starts by itself once nothing runs the
 * old one, as when iPadOS has ended the app.
 *
 * @param {string | null} version the new one's, if it's known
 * @returns {Text}
 */
export function webUpdateReady(version) {
  return {
    message: version ? t("webUpdateReady", { version }) : t("webUpdateReadyUnknown"),
    detail: t("webUpdateReadyDetail"),
  };
}

/**
 * The prompt before the web app restarts for an update while a document's
 * changes couldn't be saved, with Restart Now and Cancel.
 *
 * @param {string} name the document's
 * @returns {Text}
 */
export function restartUnsavedPrompt(name) {
  return { message: t("changesNotSaved", { name }), detail: t("restartUnsavedDetail") };
}

/**
 * The web app keeps its own copy of each document and saves into it, which
 * leaves the file in the Files app as it was. These say so: a document whose
 * copy holds changes the file doesn't is "not in Files", and one made in
 * PDFLion was never there.
 */

/**
 * @param {boolean} made whether PDFLion made the document, with New
 * @returns {string} the label of the toolbar's status and of Home's mark
 */
export function notInFilesLabel(made) {
  return made ? t("onlyInPdflion") : t("notInFiles");
}

/**
 * The snackbar after a document's first save in a session, with Share….
 *
 * @param {boolean} made whether PDFLion made the document
 * @returns {string}
 */
export function savedNotInFiles(made) {
  return made ? t("savedMade") : t("savedNotMade");
}

/**
 * The first time ever a document is saved, what that means, with OK and
 * Share….
 *
 * @param {string} name the document's
 * @param {boolean} made whether PDFLion made the document
 * @returns {Text}
 */
export function notInFilesExplanation(name, made) {
  return made
    ? { message: t("explainMade", { name }), detail: t("explainMadeDetail") }
    : { message: t("explainNotMade", { name }), detail: t("explainNotMadeDetail") };
}

/**
 * The snackbar after a tab closes whose document is not in Files, with
 * Share….
 *
 * @param {string} name the document's
 * @param {boolean} made whether PDFLion made the document
 * @returns {string}
 */
export function closedNotInFiles(name, made) {
  return made ? t("closedMade", { name }) : t("closedNotMade", { name });
}

/**
 * @param {string} name the document's
 * @returns {string} the snackbar after Save
 */
export function savedNow(name) {
  return t("savedNow", { name });
}

/**
 * The prompt before a document is deleted, with Delete and Cancel.
 *
 * @param {string} name the document's
 * @param {object} state
 * @param {boolean} state.notInFiles whether its copy has changes the file in
 *   Files doesn't, or it was never there
 * @param {boolean} state.made whether PDFLion made it
 * @returns {Text}
 */
export function deletePrompt(name, { notInFiles, made }) {
  let detail = t("deleteKeepsFile");
  if (made) detail = t("deleteMade");
  else if (notInFiles) detail = t("deleteChanges");
  return { message: t("deletePrompt", { name }), detail };
}

/**
 * The prompt for a document's new name, with Rename and Cancel.
 *
 * @param {string} name the document's
 * @returns {Text}
 */
export function renamePrompt(name) {
  return { message: t("renamePrompt", { name }) };
}

/**
 * When the browser wouldn't share without another tap, with Share… and
 * Cancel.
 *
 * @param {string} name the document's
 * @returns {Text}
 */
export function shareReady(name) {
  return { message: t("shareReady", { name }) };
}


/**
 * The prompt before a tab closes whose changes couldn't be saved, with Close
 * and Cancel.
 *
 * @param {string} name the document's
 * @returns {Text}
 */
export function closeUnsavedPrompt(name) {
  return { message: t("changesNotSaved", { name }), detail: t("closeUnsavedDetail") };
}

/**
 * @param {string} name the document's
 * @param {{ message: string }} error
 * @returns {Text}
 */
export function shareError(name, { message }) {
  return { message: t("shareError", { name }), detail: message };
}

/**
 * @param {number} bytes
 * @returns {string} such as `1.2 MB`, in decimal units, as Files gives them
 */
export function formatSize(bytes) {
  /** @type {[string, number][]} */
  const units = [
    ["gigabyte", 1e9],
    ["megabyte", 1e6],
    ["kilobyte", 1e3],
  ];
  const [unit, size] = units.find(([, other]) => bytes >= other) ?? units[2];
  const format = new Intl.NumberFormat(locale(), {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 1,
  });
  return format.format(bytes / size);
}

/**
 * The web app's backups: Export… makes a ZIP of the settings and every
 * document PDFLion keeps, or a settings file, and Import… takes either.
 */


/**
 * Export…'s question, with Cancel, Settings Only and Settings and
 * Documents.
 *
 * @param {number} documents how many the library has
 * @param {number} bytes what they take
 * @returns {Text}
 */
export function exportPrompt(documents, bytes) {
  const size = formatSize(bytes);
  return {
    message: t("exportPrompt"),
    detail:
      documents === 1
        ? t("exportDetailOne", { size })
        : t("exportDetailMany", { count: documents, size }),
  };
}

/**
 * @param {number} percent of the documents read
 * @returns {string} the snackbar while a backup is made, with Cancel
 */
export function exportProgress(percent) {
  return t("exportProgress", { percent });
}

/**
 * @param {{ message: string }} error
 * @returns {Text}
 */
export function exportError({ message }) {
  return { message: t("exportError"), detail: message };
}

/**
 * @param {number} done
 * @param {number} total
 * @returns {string} the snackbar while documents are imported, with Cancel
 */
export function importProgress(done, total) {
  return total === 1 ? t("importProgressOne") : t("importProgressMany", { done, total });
}

/**
 * The prompt before a backup is imported, with Import and Cancel.
 *
 * @param {string} name the backup's
 * @param {object} changes
 * @param {number} changes.documents how many come in, copies too
 * @param {number} changes.bytes what they take
 * @param {number} changes.here how many are here already, as they are
 * @param {number} changes.copies how many have other changes here, and come
 *   in as copies
 * @param {{ replaced: string[], added: number } | null} changes.settings
 *   what its settings change, as for importSettingsPrompt(), or null
 * @returns {Text}
 */
export function importBackupPrompt(name, { documents, bytes, here, copies, settings }) {
  const values = { name, count: documents, size: formatSize(bytes) };
  const id = `importBackup${documents === 1 ? "One" : "Many"}${settings ? "AndSettings" : ""}`;
  const message = documents === 0 ? t("importSettingsPrompt", { name }) : t(id, values);
  const details = [];
  if (copies === 1) details.push(t("copiesOne"));
  else if (copies > 1) details.push(t("copiesMany", { count: copies }));
  if (here === 1) details.push(t("hereOne"));
  else if (here > 1) details.push(t("hereMany", { count: here }));
  if (settings) details.push(settingsChanges(settings));
  return { message, detail: details.join(" ") };
}

/**
 * @param {string} name the backup's
 * @returns {Text} that a backup would change nothing
 */
export function nothingInBackup(name) {
  return { message: t("nothingToImport", { name }), detail: t("nothingInBackupDetail") };
}

/**
 * @param {string} name the backup's
 * @param {number | null} missing how many more bytes it needs, if that's known
 * @returns {Text}
 */
export function notEnoughSpace(name, missing) {
  const needs = missing === null ? t("needsSpaceUnknown") : t("needsSpace", { size: formatSize(missing) });
  return { message: t("notEnoughSpace", { name }), detail: t("notEnoughSpaceDetail", { needs }) };
}

/** @typedef {"not-backup" | "damaged" | "newer" | "too-large"} BackupError */

/** @type {Record<BackupError, string>} */
const BACKUP_ERRORS = {
  "not-backup": "backupNotBackup",
  damaged: "backupDamaged",
  newer: "backupNewer",
  "too-large": "backupTooLarge",
};

/**
 * @param {string} name the file's
 * @param {BackupError} error
 * @returns {Text}
 */
export function backupError(name, error) {
  return { message: t("backupError", { name }), detail: t(BACKUP_ERRORS[error]) };
}

/**
 * @param {string[]} names the documents' that a backup lists, but that are
 *   missing or damaged in it, or aren't PDFs
 * @returns {Text}
 */
export function documentsNotImported(names) {
  if (names.length === 1) {
    return { message: t("backupError", { name: names[0] }), detail: t("documentNotImportedDetail") };
  }
  const quoted = names.map((name) => t("quoted", { name }));
  return {
    message: t("documentsNotImported", { count: names.length }),
    detail: t("documentsNotImportedDetail", { list: list(quoted) }),
  };
}

/**
 * @param {number} documents how many came in
 * @param {boolean} settings whether the settings did
 * @returns {string} the snackbar after an import
 */
export function importedNow(documents, settings) {
  if (documents === 0) return t("importedSettings");
  const id = `imported${documents === 1 ? "One" : "Many"}${settings ? "AndSettings" : ""}`;
  return t(id, { count: documents });
}

/** @returns {Text} that the web app's first download failed */
export function webAppNotDownloaded() {
  return { message: t("webAppNotDownloaded"), detail: t("webAppNotDownloadedDetail") };
}

/**
 * @param {string} reason what failed, such as the browser's error
 * @returns {Text} that the web app can't run in this browser
 */
export function webAppUnavailable(reason) {
  return { message: t("webAppUnavailable"), detail: t("webAppUnavailableDetail", { reason }) };
}
