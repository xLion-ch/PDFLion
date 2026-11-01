/**
 * What the service worker (sw.js) keeps of the app for offline use, and
 * which of it an update must download. scripts/build-web.js lists every
 * file of the build in sw.js with its SHA-256 and size, and the worker
 * keeps them in a cache of its own, `pdflion-<version>-<build>`, along with
 * that list, which it writes last, so that only a complete cache has one.
 *
 * Free of the service worker's globals, so that unit tests run it under
 * plain Node.
 */

/** What the names of the app's caches start with. */
export const CACHE_PREFIX = "pdflion-";

/**
 * Where a cache keeps the list of its files, below the app's folder. It's
 * no file of the app, so the worker never serves it.
 */
export const FILE_LIST_PATH = ".pdflion-files.json";

/**
 * @typedef {Record<string, [sha256: string, size: number]>} FileList the
 *   app's files, by their paths below its folder, with `/`, such as
 *   `viewer/web/viewer.html`: each one's SHA-256 in hex, and its size
 */

/**
 * @typedef {object} CachedFiles an older version's cache, and its files
 * @property {string} cache its name
 * @property {FileList} files
 */

/**
 * @param {string} version
 * @param {string} build an id of the build's files
 * @returns {string} the name of the cache of that build
 */
export function cacheName(version, build) {
  return `${CACHE_PREFIX}${version}-${build}`;
}

/**
 * Works out how to fill a version's cache: a file that an older version's
 * complete cache has, with the same contents, is copied from there, and
 * every other file is downloaded. So an update downloads only what changed.
 *
 * @param {FileList} files the new version's
 * @param {CachedFiles[]} previous the older versions' complete caches
 * @returns {{ copy: { path: string, from: string }[], download: string[] }}
 */
export function planInstall(files, previous) {
  /** @type {{ path: string, from: string }[]} */
  const copy = [];
  /** @type {string[]} */
  const download = [];
  for (const [path, [sha256, size]] of Object.entries(files)) {
    const from = previous.find(({ files: other }) => {
      const entry = Object.hasOwn(other, path) ? other[path] : undefined;
      return entry?.[0] === sha256 && entry[1] === size;
    });
    if (from) copy.push({ path, from: from.cache });
    else download.push(path);
  }
  return { copy, download };
}

/**
 * @param {unknown} value a cache's list of its files, as stored
 * @returns {FileList | null} the list, or null if it isn't one
 */
export function parseFileList(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  for (const entry of Object.values(value)) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry[0]) ||
      !Number.isSafeInteger(entry[1]) ||
      entry[1] < 0
    ) {
      return null;
    }
  }
  return /** @type {FileList} */ (value);
}

/**
 * @param {URL} url a request's
 * @param {URL} scope the app's folder
 * @param {FileList} files
 * @returns {string | null} the app's file that `url` names, by its path in
 *   `files`, whatever its query and fragment: the folder itself is
 *   index.html. Null for anything else.
 */
export function fileAt(url, scope, files) {
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  let path;
  try {
    path = decodeURIComponent(url.pathname.slice(scope.pathname.length));
  } catch {
    return null;
  }
  if (path === "") path = "index.html";
  return Object.hasOwn(files, path) ? path : null;
}

/**
 * @param {ArrayBuffer} digest
 * @returns {string} in hex
 */
export function toHex(digest) {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
