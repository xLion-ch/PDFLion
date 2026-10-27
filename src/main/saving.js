/**
 * Save and Save As. bridge.js has pdf.js produce the document's bytes, with
 * form data and annotations, and main writes them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { dialog } from "electron";
import * as documents from "./documents.js";
import { docPath } from "./routes.js";
import * as tabs from "./tabs.js";

/**
 * Phrased like macOS's "could not be saved" alerts.
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
 * Writes a tab's document over its file.
 *
 * @param {tabs.Tab} tab
 * @param {Uint8Array} bytes
 * @returns {Promise<string | null>} the document's `/doc/` path, or null if it
 *   wasn't saved
 */
export async function saveDocument(tab, bytes) {
  const win = tabs.windowOf(tab);
  const token = tabs.documentToken(tab);
  const file = documents.resolve(token);
  if (!win || !file) return null;

  try {
    await documents.writeFileAtomic(file, bytes);
  } catch (error) {
    await showSaveError(win, file, /** @type {NodeJS.ErrnoException} */ (error));
    return null;
  }
  return docPath(token, path.basename(file));
}

/**
 * Asks where to save a tab's document, writes it there, and makes the tab
 * show the new file. The dialogs attach to the tab's window.
 *
 * @param {tabs.Tab} tab
 * @param {Uint8Array} bytes
 * @returns {Promise<string | null>} the document's new `/doc/` path, or null
 *   if it wasn't saved
 */
export async function saveDocumentAs(tab, bytes) {
  const win = tabs.windowOf(tab);
  const token = tabs.documentToken(tab);
  const current = documents.resolve(token);
  if (!win || !current) return null;

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: current,
    filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    properties: ["createDirectory"],
  });
  if (canceled || !filePath) return null;

  let file;
  try {
    file = await realTarget(filePath);
    await documents.writeFileAtomic(file, bytes);
  } catch (error) {
    await showSaveError(win, filePath, /** @type {NodeJS.ErrnoException} */ (error));
    return null;
  }

  documents.update(token, file);
  tabs.setRepresentedFile(tab, file);
  return docPath(token, path.basename(file));
}

/**
 * Resolves symlinks and letter case, like opening does, so that a symlink is
 * written through rather than replaced.
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
async function realTarget(file) {
  try {
    return await fs.realpath(file);
  } catch {
    // A new file: only its directory exists yet.
    return path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  }
}

/**
 * @param {Electron.BrowserWindow} win
 * @param {string} file
 * @param {NodeJS.ErrnoException} error
 */
async function showSaveError(win, file, error) {
  await dialog.showMessageBox(win, {
    type: "warning",
    message: `The document “${path.basename(file)}” could not be saved.`,
    detail: (error.code && SAVE_ERRORS[error.code]) || error.message,
  });
}
