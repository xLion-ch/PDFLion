/**
 * File > Export Settings… and Import Settings…: the tool settings, the
 * favourites and whether updates are checked automatically, as a settings
 * file (src/shared/backup.js), the same on every platform and in the web app.
 *
 * A settings file to import comes from anywhere, so main reads at most
 * MAX_SETTINGS_BYTES of it, and nothing but such a file: no ZIP, such as a
 * backup from the iPad. readSettingsFile() rebuilds every part through
 * tools.js's checks. Importing replaces the settings the file has, and adds
 * the favourites that aren't there yet, after asking.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, Menu } from "electron";
import {
  MAX_SETTINGS_BYTES,
  readSettingsFile,
  SETTINGS_FILE_NAME,
  writeSettingsFile,
} from "../shared/backup.js";
import { addFavourites } from "../shared/tools.js";
import {
  CANCEL,
  IMPORT,
  importSettingsPrompt,
  nothingToImport,
  openError,
  settingsExportError,
  settingsFileError,
} from "../shared/wording.js";
import { writeFileAtomic } from "./documents.js";
import { currentToolSettings, updateToolSettings } from "./toolsettings.js";
import { automaticChecks, setAutomaticChecks } from "./updates.js";

const isLinux = process.platform === "linux";

const FILTERS = [{ name: "PDFLion Settings", extensions: ["json"] }];

/**
 * Asks where to save the settings, and writes them there.
 *
 * @returns {Promise<void>}
 */
export async function exportSettings() {
  const win = BrowserWindow.getFocusedWindow();
  const options = {
    defaultPath: path.join(app.getPath("documents"), SETTINGS_FILE_NAME),
    filters: FILTERS,
    properties: /** @type {const} */ (["createDirectory"]),
  };
  const { canceled, filePath } = await (win
    ? dialog.showSaveDialog(win, options)
    : dialog.showSaveDialog(options));
  if (canceled || !filePath) return;

  const text = writeSettingsFile(
    { toolSettings: currentToolSettings(), automaticUpdates: automaticChecks() },
    { app: app.getVersion(), platform: process.platform, at: new Date() },
  );
  try {
    await writeFileAtomic(filePath, new TextEncoder().encode(text));
  } catch (error) {
    const { message, detail } = settingsExportError(
      path.basename(filePath),
      /** @type {NodeJS.ErrnoException} */ (error),
    );
    await showMessage(win, { type: "warning", message, detail });
  }
}

/**
 * Asks for a settings file, reads it, and imports it once the user agrees.
 *
 * @returns {Promise<void>}
 */
export async function importSettings() {
  const win = BrowserWindow.getFocusedWindow();
  const options = { properties: /** @type {const} */ (["openFile"]), filters: FILTERS };
  const { canceled, filePaths } = await (win
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options));
  const [file] = filePaths;
  if (canceled || !file) return;
  const name = path.basename(file);

  let text;
  try {
    const stats = await fs.stat(file);
    if (stats.size > MAX_SETTINGS_BYTES) {
      await showMessage(win, { type: "warning", ...settingsFileError(name, "too-large") });
      return;
    }
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    await showMessage(win, {
      type: "warning",
      ...openError(name, /** @type {NodeJS.ErrnoException} */ (error)),
    });
    return;
  }

  const read = readSettingsFile(text);
  if ("error" in read) {
    await showMessage(win, { type: "warning", ...settingsFileError(name, read.error) });
    return;
  }
  const { eraser, penOnly, favourites, automaticUpdates } = read.settings;
  const current = currentToolSettings();
  const added = addFavourites(current.favourites, favourites);
  const replaced = Object.entries({ eraser, penOnly, automaticUpdates })
    .filter(([, value]) => value !== null)
    .map(([setting]) => setting);
  if (replaced.length === 0 && added.added === 0) {
    await showMessage(win, { type: "info", ...nothingToImport(name) });
    return;
  }

  // macOS and Windows show the first button as the main one. GNOME puts it
  // last, rightmost.
  const buttons = isLinux ? [CANCEL, IMPORT] : [IMPORT, CANCEL];
  const { response } = await showMessage(win, {
    type: "question",
    ...importSettingsPrompt(name, { replaced, added: added.added }),
    buttons,
    defaultId: buttons.indexOf(IMPORT),
    cancelId: buttons.indexOf(CANCEL),
    noLink: true,
  });
  if (buttons[response] !== IMPORT) return;

  updateToolSettings({
    ...(eraser ? { eraser } : {}),
    ...(penOnly !== null ? { penOnly } : {}),
    favourites: added.favourites,
  });
  if (automaticUpdates !== null) {
    setAutomaticChecks(automaticUpdates);
    // The menu's checkbox, where PDFLion updates itself.
    const item = Menu.getApplicationMenu()?.getMenuItemById("automaticUpdates");
    if (item) item.checked = automaticUpdates;
  }
}

/**
 * Attached to `win`, if there is one.
 *
 * @param {BrowserWindow | null} win
 * @param {Electron.MessageBoxOptions} options
 * @returns {Promise<Electron.MessageBoxReturnValue>}
 */
function showMessage(win, options) {
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}
