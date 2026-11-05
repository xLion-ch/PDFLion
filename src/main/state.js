/**
 * What PDFLion remembers between launches, in `userData/state.json`: where the
 * last document window was, the tool settings (toolsettings.js) and, on
 * Windows and Linux, the recently opened documents.
 * The file is read once. Changes are written a moment later, batched, and
 * before the app quits.
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/** Moving or resizing a window changes the state many times a second. */
const SAVE_DELAY_MS = 1000;

/** @type {Record<string, unknown> | null} */
let state = null;

/** @type {NodeJS.Timeout | undefined} */
let saveTimer;

/**
 * @param {string} key
 * @returns {unknown} the stored value, as an earlier version of PDFLion, or a
 *   hand edit, left it: check it before use
 */
export function getState(key) {
  return load()[key];
}

/**
 * @param {string} key
 * @param {unknown} value anything JSON can represent
 */
export function setState(key, value) {
  load()[key] = value;
  if (saveTimer) return;
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
  app.once("will-quit", save);
}

/** @returns {Record<string, unknown>} */
function load() {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    state = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    state = {}; // no file yet, or one that can't be read
  }
  return /** @type {Record<string, unknown>} */ (state);
}

/**
 * Writes the state synchronously, since `will-quit` doesn't wait. It's a few
 * hundred bytes, and some tens of kilobytes with hundreds of favourites. The
 * temporary file and rename keep a crash from leaving half a file. A save
 * that fails is tried again a moment later, so that the file doesn't miss a
 * change until the next one.
 */
function save() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  app.off("will-quit", save);

  const file = stateFile();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    replace(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    console.error(`Couldn't save ${file}:`, error);
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
    app.once("will-quit", save);
  }
}

/** Errors of a rename on Windows while another process has the file open. */
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;
const RENAME_PAUSE_MS = 20;

/**
 * Renames `from` over `to`. Windows refuses to replace a file another process
 * has open, such as an antivirus or the search indexer reading it for a
 * moment, so there it tries again for up to 200 ms. Synchronously, since
 * `will-quit` doesn't wait.
 *
 * @param {string} from
 * @param {string} to
 */
function replace(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (process.platform !== "win32" || !BUSY_CODES.has(code ?? "") || attempt >= RENAME_ATTEMPTS) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_PAUSE_MS);
    }
  }
}

function stateFile() {
  return path.join(app.getPath("userData"), "state.json");
}
