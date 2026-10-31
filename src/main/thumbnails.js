/**
 * Home's thumbnails: the first page of each recent document, as a PNG in
 * `userData/thumbnails/<id>.png`, named after the document's recent id.
 * bridge.js renders them, main checks them with isThumbnail() and stores them
 * without decoding them, and protocol.js serves them at `/thumb/<id>.png`,
 * where only Home's sandboxed page decodes them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { writeFileAtomic } from "./documents.js";
import { isRecentId } from "./recentlist.js";

/** @returns {string} where the thumbnails are */
function directory() {
  return path.join(app.getPath("userData"), "thumbnails");
}

/**
 * @param {unknown} id
 * @returns {string | null} the file of the thumbnail of the recent document
 *   `id`, which may not exist, or null if `id` isn't an id
 */
export function thumbnailFile(id) {
  return isRecentId(id) ? path.join(directory(), `${id}.png`) : null;
}

/**
 * @param {string} id a recent document's
 * @returns {Promise<number | null>} when its thumbnail was written, in ms,
 *   for Home to load it afresh when it changes, or null if there's none
 */
export async function thumbnailVersion(id) {
  const file = thumbnailFile(id);
  if (!file) return null;
  const stats = await fs.stat(file).catch(() => null);
  return stats?.isFile() ? Math.trunc(stats.mtimeMs) : null;
}

/**
 * @param {string} id a recent document's
 * @param {Uint8Array} bytes checked with isThumbnail()
 */
export async function saveThumbnail(id, bytes) {
  const file = thumbnailFile(id);
  if (!file) return;
  await fs.mkdir(directory(), { recursive: true });
  await writeFileAtomic(file, bytes);
}

/** @param {string} id a recent document's */
export async function deleteThumbnail(id) {
  const file = thumbnailFile(id);
  if (file) await fs.rm(file, { force: true }).catch(() => {});
}
