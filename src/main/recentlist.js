/**
 * The list of recently opened documents that PDFLion keeps itself, on every
 * platform, for Home and for File > Open Recent on Windows and Linux. Each
 * entry has a random id, which is all Home and the thumbnails know it by, so
 * the home page never sends a path. state.json holds the list, which an
 * earlier version or a hand edit may have left, so this module checks it.
 * Kept free of Electron imports so the unit tests can run it under plain Node.
 */
import path from "node:path";

/** How many documents Home shows. */
export const MAX_RECENT = 30;

/** How many File > Open Recent lists, as many as Windows apps usually do. */
export const MAX_RECENT_IN_MENU = 10;

/** The form of the ids, randomUUID()'s. */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @typedef {object} RecentEntry
 * @property {string} id random, a UUID
 * @property {string} path the file's real path
 * @property {number | null} openedAt when it was last opened, in ms since
 *   1970, or null if an earlier version's list didn't say
 */

/**
 * @param {unknown} id
 * @returns {id is string} whether `id` has the form of an entry's id
 */
export function isRecentId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/**
 * Reads the list as state.json holds it. Earlier versions kept plain paths,
 * on Windows and Linux only, which get ids and no time. Whatever's wrong is
 * left out, and so are repeats of a path or an id.
 *
 * @param {unknown} value
 * @param {() => string} newId makes an id, such as randomUUID
 * @returns {RecentEntry[]} most recent first, at most MAX_RECENT
 */
export function readRecentList(value, newId) {
  if (!Array.isArray(value)) return [];
  /** @type {RecentEntry[]} */
  const entries = [];
  const paths = new Set();
  const ids = new Set();
  for (const item of value) {
    const entry =
      typeof item === "string" ? { id: newId(), path: item, openedAt: null } : parseEntry(item);
    if (!entry || !isAbsolutePath(entry.path) || paths.has(entry.path) || ids.has(entry.id)) {
      continue;
    }
    paths.add(entry.path);
    ids.add(entry.id);
    entries.push(entry);
    if (entries.length === MAX_RECENT) break;
  }
  return entries;
}

/**
 * @param {RecentEntry[]} entries
 * @param {string} file real path, just opened
 * @param {number} now ms since 1970
 * @param {() => string} newId
 * @returns {{ entries: RecentEntry[], dropped: RecentEntry[] }} the list with
 *   `file` first, keeping its id if it was there, and the entries that fell
 *   off its end
 */
export function addRecent(entries, file, now, newId) {
  const existing = entries.find((entry) => entry.path === file);
  const added = { id: existing?.id ?? newId(), path: file, openedAt: now };
  const all = [added, ...entries.filter((entry) => entry !== existing)];
  return { entries: all.slice(0, MAX_RECENT), dropped: all.slice(MAX_RECENT) };
}

/**
 * @param {RecentEntry[]} entries
 * @param {string} id
 * @returns {RecentEntry[]} the list without the entry `id`
 */
export function removeRecent(entries, id) {
  return entries.filter((entry) => entry.id !== id);
}

/**
 * @param {unknown} item
 * @returns {RecentEntry | null}
 */
function parseEntry(item) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const { id, path: file, openedAt } = /** @type {Record<string, unknown>} */ (item);
  if (!isRecentId(id) || typeof file !== "string") return null;
  const time =
    typeof openedAt === "number" && Number.isFinite(openedAt) && openedAt >= 0 ? openedAt : null;
  return { id, path: file, openedAt: time };
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isAbsolutePath(file) {
  return file.length > 0 && !file.includes("\0") && path.isAbsolute(file);
}
