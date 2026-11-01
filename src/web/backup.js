/**
 * Home's Export… and Import…: the web app's way out for its library, to a
 * new iPad, after the app was deleted, or to another address.
 *
 * Export… makes a settings file (src/shared/backup.js), or a backup: a ZIP
 * (src/shared/zip.js) of the settings, Library.json with every document's
 * record, each document under its own name, and the thumbnails. It saves
 * every open document first, and hands the file to the shell's Share, whose
 * Save to Files keeps it. A backup isn't the file in Files, so it changes no
 * document's "not in Files" mark.
 *
 * Import… takes either. A backup comes from anywhere, so it's read through
 * zip.js and backup.js, which check every part before it's used. It never
 * overwrites a document: one that's here as it is stays, and one that's
 * here with other changes comes in as a copy. Each document goes into the
 * library in a transaction of its own, once its CRC-32 is checked and it
 * starts as a PDF, so an import cut short keeps what it got, and importing
 * again adds the rest. Settings are imported as on the desktop: the eraser
 * and pen settings replaced, the favourites added.
 */
import {
  LIBRARY_FILE_NAME,
  MAX_LIBRARY_BYTES,
  MAX_SETTINGS_BYTES,
  SETTINGS_FILE_NAME,
  THUMBNAILS_FOLDER,
  backupFileName,
  documentFiles,
  readLibraryFile,
  readSettingsFile,
  writeLibraryFile,
  writeSettingsFile,
} from "../shared/backup.js";
import { THUMBNAIL_MAX_BYTES, isThumbnail } from "../shared/thumbnail.js";
import { addFavourites } from "../shared/tools.js";
import {
  CANCEL,
  IMPORT,
  SETTINGS_AND_DOCUMENTS,
  SETTINGS_ONLY,
  backupError,
  documentsNotImported,
  exportError,
  exportProgress,
  exportPrompt,
  importBackupPrompt,
  importProgress,
  importSettingsPrompt,
  importedNow,
  nothingInBackup,
  nothingToImport,
  notEnoughSpace,
  settingsFileError,
} from "../shared/wording.js";
import { ZipError, readEntry, readZip, writeZip } from "../shared/zip.js";
import * as dialogs from "./dialogs.js";
import { freeName, hasPdfHeader } from "./library.js";
import { VERSION } from "./version.js";

/** @typedef {import("../shared/tools.js").ToolSettings} ToolSettings */
/** @typedef {import("../shared/backup.js").BackupDocument} BackupDocument */
/** @typedef {import("../shared/zip.js").ZipEntry} ZipEntry */

/** What the files say exported them, as the desktop's say `darwin`. */
const PLATFORM = "web";

/** Where macOS's Archive Utility keeps resource forks in a ZIP. */
const MAC_RESOURCES = "__MACOSX/";

/**
 * @typedef {object} BackupHost what the shell gives
 * @property {import("./library.js").Library} library
 * @property {() => ToolSettings} toolSettings
 * @property {(changes: Partial<ToolSettings>) => Promise<void>} updateToolSettings
 * @property {() => Promise<unknown>} saveAll saves every open document
 * @property {(file: File) => Promise<boolean>} share
 * @property {(ids: string[]) => void} imported shows the documents that
 *   came in, with their thumbnails
 * @property {number} maxDocumentBytes
 */

/**
 * @typedef {object} SettingsChanges what importing settings changes
 * @property {("eraser" | "penOnly")[]} replaced
 * @property {number} added how many favourites
 * @property {Partial<ToolSettings>} changes for updateToolSettings()
 */

/** Whether an export or an import is under way. */
let busy = false;

/**
 * Export…: asks what to take, and shares a settings file or a backup.
 *
 * @param {BackupHost} host
 */
export async function exportBackup(host) {
  if (busy) return;
  busy = true;
  try {
    await exportFiles(host);
  } finally {
    busy = false;
  }
}

/**
 * Import…: imports a backup or a settings file, once the user agrees.
 *
 * @param {File} file
 * @param {BackupHost} host
 */
export async function importFile(file, host) {
  if (busy) return;
  busy = true;
  try {
    const start = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    // Every ZIP starts with "PK".
    if (start[0] === 0x50 && start[1] === 0x4b) await importBackup(file, host);
    else await importSettings(file, host);
  } finally {
    busy = false;
  }
}

/** @param {BackupHost} host */
async function exportFiles(host) {
  const records = await host.library.documents();
  let withDocuments = false;
  if (records.length > 0) {
    const bytes = records.reduce((sum, record) => sum + record.size, 0);
    const { button } = await dialogs.showDialog(exportPrompt(records.length, bytes), {
      buttons: [CANCEL, SETTINGS_ONLY, SETTINGS_AND_DOCUMENTS],
      defaultButton: SETTINGS_AND_DOCUMENTS,
      cancelButton: CANCEL,
    });
    if (button === CANCEL) return;
    withDocuments = button === SETTINGS_AND_DOCUMENTS;
  }
  const at = new Date();
  const exported = { app: VERSION, platform: PLATFORM, at };
  const settings = writeSettingsFile({ toolSettings: host.toolSettings(), automaticUpdates: null }, exported);
  if (!withDocuments) {
    await host.share(new File([settings], SETTINGS_FILE_NAME, { type: "application/json" }));
    return;
  }

  const controller = new AbortController();
  const bar = dialogs.progress(exportProgress(0), () => controller.abort());
  /** @type {Blob} */
  let zip;
  try {
    await host.saveAll();
    /** @type {{ record: import("./library.js").DocumentRecord, blob: Blob }[]} */
    const stored = [];
    for (const record of await host.library.documents()) {
      const read = await host.library.read(record.id);
      if (read) stored.push(read);
    }
    const thumbnails = await host.library.thumbnails();
    const files = documentFiles(stored.map(({ record }) => record));
    /** @param {string} id */
    const thumbnailPath = (id) => `${THUMBNAILS_FOLDER}${id}.png`;
    /** @type {BackupDocument[]} */
    const documents = stored.map(({ record, blob }) => ({
      ...record,
      size: blob.size,
      file: /** @type {string} */ (files.get(record.id)),
      thumbnail: thumbnails.has(record.id) ? thumbnailPath(record.id) : null,
    }));
    let shown = 0;
    zip = await writeZip(
      [
        { name: SETTINGS_FILE_NAME, blob: new Blob([settings]), modified: at },
        { name: LIBRARY_FILE_NAME, blob: new Blob([writeLibraryFile(documents, exported)]), modified: at },
        ...stored.map(({ record, blob }) => ({
          name: /** @type {string} */ (files.get(record.id)),
          blob,
          modified: new Date(record.modifiedAt),
        })),
        ...stored
          .filter(({ record }) => thumbnails.has(record.id))
          .map(({ record }) => ({
            name: thumbnailPath(record.id),
            blob: /** @type {Blob} */ (thumbnails.get(record.id)),
            modified: at,
          })),
      ],
      {
        signal: controller.signal,
        onProgress(done, total) {
          const percent = total > 0 ? Math.floor((done * 100) / total) : 100;
          if (percent === shown) return;
          shown = percent;
          bar.update(exportProgress(percent));
        },
      },
    );
  } catch (error) {
    bar.dismiss();
    if (controller.signal.aborted) return;
    console.error("Couldn't make the backup:", error);
    await dialogs.alert(exportError(/** @type {Error} */ (error)));
    return;
  }
  bar.dismiss();
  await host.share(new File([zip], backupFileName(at), { type: "application/zip" }));
}

/**
 * @param {File} file
 * @param {BackupHost} host
 */
async function importSettings(file, host) {
  const { name } = file;
  if (file.size > MAX_SETTINGS_BYTES) {
    await dialogs.alert(settingsFileError(name, "too-large"));
    return;
  }
  const read = readSettingsFile(await file.text());
  if ("error" in read) {
    await dialogs.alert(settingsFileError(name, read.error));
    return;
  }
  const settings = settingsChanges(read.settings, host.toolSettings());
  if (!settings) {
    await dialogs.alert(nothingToImport(name));
    return;
  }
  if (!(await dialogs.confirm(importSettingsPrompt(name, settings), IMPORT))) return;
  await host.updateToolSettings(settings.changes);
  dialogs.snackbar(importedNow(0, true));
}

/**
 * @param {import("../shared/backup.js").ImportedSettings} settings a file's
 * @param {ToolSettings} current
 * @returns {SettingsChanges | null} what importing them changes, or null
 *   for nothing. The web app has no automatic updates to set.
 */
function settingsChanges({ eraser, penOnly, favourites }, current) {
  /** @type {SettingsChanges["replaced"]} */
  const replaced = [];
  /** @type {Partial<ToolSettings>} */
  const changes = {};
  if (eraser && JSON.stringify(eraser) !== JSON.stringify(current.eraser)) {
    replaced.push("eraser");
    changes.eraser = eraser;
  }
  if (penOnly !== null && penOnly !== current.penOnly) {
    replaced.push("penOnly");
    changes.penOnly = penOnly;
  }
  const added = addFavourites(current.favourites, favourites);
  if (added.added > 0) changes.favourites = added.favourites;
  return replaced.length > 0 || added.added > 0 ? { replaced, added: added.added, changes } : null;
}

/**
 * @param {File} file a ZIP
 * @param {BackupHost} host
 */
async function importBackup(file, host) {
  const { name } = file;
  /** @type {ZipEntry[]} */
  let entries;
  try {
    entries = (await readZip(file)).filter(
      (entry) => !entry.name.endsWith("/") && !entry.name.startsWith(MAC_RESOURCES),
    );
  } catch (error) {
    console.error(`Couldn't read ${name}:`, error);
    const reason = error instanceof ZipError ? error.reason : "damaged";
    await dialogs.alert(
      backupError(name, reason === "not-zip" ? "not-backup" : reason === "too-large" ? "too-large" : "damaged"),
    );
    return;
  }

  // A backup zipped again, as by Finder's Compress, has its files in a
  // folder.
  const listing = shallowest(entries, LIBRARY_FILE_NAME);
  const settingsEntry = shallowest(entries, SETTINGS_FILE_NAME);
  const found = listing ?? settingsEntry;
  if (!found) {
    await dialogs.alert(backupError(name, "not-backup"));
    return;
  }
  const folder = found.name.slice(0, found.name.lastIndexOf("/") + 1);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  /** @type {BackupDocument[]} */
  let documents = [];
  if (listing && listing.name === `${folder}${LIBRARY_FILE_NAME}`) {
    let read;
    try {
      read = readLibraryFile(await text(file, listing, MAX_LIBRARY_BYTES));
    } catch (error) {
      console.error(`Couldn't read ${listing.name}:`, error);
      const tooLarge = error instanceof ZipError && error.reason === "too-large";
      await dialogs.alert(backupError(name, tooLarge ? "too-large" : "damaged"));
      return;
    }
    if ("error" in read) {
      await dialogs.alert(backupError(name, read.error === "not-library" ? "not-backup" : read.error));
      return;
    }
    documents = read.documents;
  }
  /** @type {SettingsChanges | null} */
  let settings = null;
  const settingsInFolder = byName.get(`${folder}${SETTINGS_FILE_NAME}`);
  if (settingsInFolder) {
    try {
      const read = readSettingsFile(await text(file, settingsInFolder, MAX_SETTINGS_BYTES));
      if (!("error" in read)) settings = settingsChanges(read.settings, host.toolSettings());
    } catch (error) {
      console.error(`Couldn't read ${settingsInFolder.name}:`, error);
    }
  }

  /** @type {string[]} */
  const failed = [];
  /** @type {{ document: BackupDocument, entry: ZipEntry, copy: boolean }[]} */
  const toImport = [];
  let here = 0;
  for (const document of documents) {
    const entry = byName.get(`${folder}${document.file}`);
    if (!entry || entry.size !== document.size || entry.size > host.maxDocumentBytes) {
      failed.push(document.name);
      continue;
    }
    const existing = await host.library.document(document.id);
    if (existing && existing.revision === document.revision && existing.size === document.size) {
      here++;
      continue;
    }
    toImport.push({ document, entry, copy: !!existing });
  }
  if (toImport.length === 0 && !settings) {
    await dialogs.alert(failed.length > 0 ? documentsNotImported(failed) : nothingInBackup(name));
    return;
  }

  const bytes = toImport.reduce((sum, { entry }) => sum + entry.size, 0);
  const prompt = importBackupPrompt(name, {
    documents: toImport.length,
    bytes,
    here,
    copies: toImport.filter(({ copy }) => copy).length,
    settings,
  });
  if (!(await dialogs.confirm(prompt, IMPORT))) return;

  // Rather than fail halfway.
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (estimate?.quota !== undefined && estimate.usage !== undefined) {
    const free = estimate.quota - estimate.usage;
    if (bytes > free) {
      await dialogs.alert(notEnoughSpace(name, bytes - free));
      return;
    }
  }

  const controller = new AbortController();
  const bar =
    toImport.length > 0 ? dialogs.progress(importProgress(1, toImport.length), () => controller.abort()) : null;
  /** @type {string[]} */
  const imported = [];
  let full = false;
  for (const [index, { document, entry, copy }] of toImport.entries()) {
    if (controller.signal.aborted) break;
    bar?.update(importProgress(index + 1, toImport.length));
    try {
      const contents = await readEntry(file, entry, { signal: controller.signal });
      if (!(await hasPdfHeader(contents))) throw new Error(`${entry.name} isn't a PDF`);
      const thumbnail = document.thumbnail ? await readThumbnail(file, byName.get(`${folder}${document.thumbnail}`)) : null;
      const record = copy
        ? { ...document, id: crypto.randomUUID(), name: freeName(await host.library.documents(), document.name) }
        : document;
      const blob = new Blob([/** @type {Blob} */ (contents)], { type: "application/pdf" });
      await host.library.importDocument({ ...record, size: blob.size }, blob, thumbnail);
      imported.push(record.id);
    } catch (error) {
      if (controller.signal.aborted) break;
      if (/** @type {Error} */ (error)?.name === "QuotaExceededError") {
        full = true;
        break;
      }
      console.error(`Couldn't import ${document.name}:`, error);
      failed.push(document.name);
    }
  }
  bar?.dismiss();
  const cancelled = controller.signal.aborted;
  if (settings && !cancelled && !full) await host.updateToolSettings(settings.changes);
  host.imported(imported);
  if (full) await dialogs.alert(notEnoughSpace(name, null));
  else if (failed.length > 0) await dialogs.alert(documentsNotImported(failed));
  else if (!cancelled) dialogs.snackbar(importedNow(imported.length, settings !== null));
}

/**
 * @param {ZipEntry[]} entries
 * @param {string} fileName
 * @returns {ZipEntry | undefined} the entry of that name at the top, or in
 *   the fewest folders
 */
function shallowest(entries, fileName) {
  return entries
    .filter((entry) => entry.name === fileName || entry.name.endsWith(`/${fileName}`))
    .sort((a, b) => a.name.split("/").length - b.name.split("/").length)[0];
}

/**
 * @param {File} zip
 * @param {ZipEntry} entry
 * @param {number} maxSize
 * @returns {Promise<string>} the entry, as UTF-8
 */
async function text(zip, entry, maxSize) {
  const contents = await readEntry(zip, entry, { maxSize });
  return new TextDecoder().decode(await contents.arrayBuffer());
}

/**
 * @param {File} zip
 * @param {ZipEntry | undefined} entry a document's thumbnail
 * @returns {Promise<Blob | null>} the thumbnail, if it's one Home shows
 */
async function readThumbnail(zip, entry) {
  if (!entry || entry.size > THUMBNAIL_MAX_BYTES) return null;
  try {
    const bytes = new Uint8Array(await (await readEntry(zip, entry)).arrayBuffer());
    return isThumbnail(bytes) ? new Blob([bytes], { type: "image/png" }) : null;
  } catch {
    return null;
  }
}
