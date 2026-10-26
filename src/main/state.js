/**
 * What PDFLion remembers between launches, in `userData/state.json`: where the
 * last document window was and, on Windows, the recently opened documents.
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
 * hundred bytes. The temporary file and rename keep a crash from leaving half
 * a file.
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
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    console.error(`Couldn't save ${file}:`, error);
  }
}

function stateFile() {
  return path.join(app.getPath("userData"), "state.json");
}
