/**
 * The web app's service worker, a module, at the root of the app, whose
 * folder is its scope. scripts/build-web.js writes into it the version, and
 * every file of the build with its SHA-256 and size, so that each release's
 * differs, which is how browsers find an update.
 *
 * Installing keeps every file of the app in a cache of this build's
 * (precache.js): what an older version's cache has with the same contents is
 * copied from there, and the rest is downloaded past the HTTP cache, and
 * checked against its SHA-256. Any failure fails the install, which the
 * next check tries again, so a version is cached whole or not at all.
 *
 * Once it's active, the app's files come only from its cache, so a running
 * app never mixes versions, and the app works offline. It serves the
 * library's documents at `doc/<id>/<name>`, as src/main/protocol.js serves
 * `/doc/` on the desktop: whole or as byte ranges, with an ETag of
 * `"<id>-<revision>"`, and 412 for a stale If-Match, so that bridge.js's
 * range transport works as it does there. Anything else goes to the
 * network.
 *
 * A new version waits until the shell asks it to take over, for Restart
 * Now, or until nothing runs the old one. Activating, it deletes the other
 * versions' caches, and takes over the pages.
 *
 * Its imports name the files as they are in the built app, whose root it's
 * at, rather than in src/web/.
 */
import { answerRange } from "./shared/ranges.js";
import { Library, isDocumentId } from "./web/library.js";
import {
  CACHE_PREFIX,
  FILE_LIST_PATH,
  cacheName,
  fileAt,
  parseFileList,
  planInstall,
  toHex,
} from "./web/precache.js";

/** Written by scripts/build-web.js. */
const VERSION = "dev";

/** Written by scripts/build-web.js: an id of the build's files. */
const BUILD = "dev";

/**
 * Written by scripts/build-web.js: every file of the build but this one.
 * @type {import("./web/precache.js").FileList}
 */
const FILES = {};

/** This build's cache. */
const CACHE = cacheName(VERSION, BUILD);

/** The app's folder. */
const SCOPE = new URL(self.registration.scope);

/** Where the library's documents are: `doc/<id>/<name>`. */
const DOCUMENTS_PATH = new URL("doc/", SCOPE).pathname;

/**
 * How much of a document a response reads at a time. A response whose body
 * is a large Blob fails in WebKit, and Safari sends it only once it has read
 * all of it.
 */
const CHUNK_SIZE = 1024 * 1024;

/** How many files installing downloads at once. */
const DOWNLOADS_AT_ONCE = 8;

/** @type {Promise<Library> | null} */
let library = null;

self.addEventListener("install", (/** @type {any} */ event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (/** @type {any} */ event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
      }
      await /** @type {any} */ (self).clients.claim();
    })(),
  );
});

self.addEventListener("message", (/** @type {any} */ event) => {
  switch (event.data) {
    // The shell isn't controlled although this worker is active, as after
    // a reload that bypassed it.
    case "claim":
      event.waitUntil(/** @type {any} */ (self).clients.claim());
      break;
    // The shell's Restart Now, once its documents are saved.
    case "skipWaiting":
      event.waitUntil(/** @type {any} */ (self).skipWaiting());
      break;
    // The shell asks which version is waiting, for its prompt.
    case "version":
      event.ports[0]?.postMessage(VERSION);
      break;
  }
});

self.addEventListener("fetch", (/** @type {any} */ event) => {
  /** @type {Request} */
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith(DOCUMENTS_PATH)) {
    event.respondWith(serveDocument(request, url));
    return;
  }
  const path = request.method === "GET" ? fileAt(url, SCOPE, FILES) : null;
  if (path) event.respondWith(serveFile(request, path));
});

/**
 * Fills this build's cache, unless an earlier install did.
 */
async function precache() {
  if (await filesOf(CACHE)) return;
  // What an install that failed left.
  await caches.delete(CACHE);
  /** @type {import("./web/precache.js").CachedFiles[]} */
  const previous = [];
  for (const name of await caches.keys()) {
    if (!name.startsWith(CACHE_PREFIX) || name === CACHE) continue;
    const files = await filesOf(name);
    if (files) previous.push({ cache: name, files });
  }
  const { copy, download } = planInstall(FILES, previous);
  const cache = await caches.open(CACHE);
  for (const { path, from } of copy) {
    const response = await (await caches.open(from)).match(urlOf(path));
    if (response) await cache.put(urlOf(path), response);
    else download.push(path);
  }
  const queue = [...download];
  const downloader = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      await cache.put(urlOf(path), await downloadFile(path));
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, downloader));
  // Last, so that only a complete cache has it.
  await cache.put(
    urlOf(FILE_LIST_PATH),
    new Response(JSON.stringify(FILES), { headers: { "Content-Type": "application/json" } }),
  );
  console.info(
    `PDFLion ${VERSION} is installed: ${download.length} files downloaded, ${copy.length} kept.`,
  );
}

/**
 * @param {string} path one of FILES
 * @returns {Promise<Response>} the file, past the HTTP cache, checked
 *   against its size and SHA-256
 */
async function downloadFile(path) {
  const response = await fetch(urlOf(path), { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  const [sha256, size] = FILES[path];
  if (body.byteLength !== size || toHex(await crypto.subtle.digest("SHA-256", body)) !== sha256) {
    throw new Error(`${path} isn't the file this version of PDFLion lists`);
  }
  // Only its type: the body is decoded, whatever encoding and length GitHub
  // Pages sent it with.
  const type = response.headers.get("Content-Type") ?? "application/octet-stream";
  return new Response(body, { status: 200, headers: { "Content-Type": type } });
}

/**
 * @param {string} name a cache's
 * @returns {Promise<import("./web/precache.js").FileList | null>} its files,
 *   if it's complete
 */
async function filesOf(name) {
  if (!(await caches.has(name))) return null;
  const response = await (await caches.open(name)).match(urlOf(FILE_LIST_PATH));
  try {
    return response ? parseFileList(await response.json()) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} path below the app's folder
 * @returns {string} its URL
 */
function urlOf(path) {
  return new URL(path, SCOPE).href;
}

/**
 * @param {Request} request for one of the app's files
 * @param {string} path the file's
 * @returns {Promise<Response>} the file as this version has it. Only if the
 *   browser has dropped the cache, the network's.
 */
async function serveFile(request, path) {
  const cached = await (await caches.open(CACHE)).match(urlOf(path));
  if (cached) return cached;
  console.warn(`PDFLion ${VERSION}'s cache has no ${path}.`);
  return fetch(request);
}

/**
 * @param {Request} request
 * @param {URL} url `doc/<id>/<name>`
 * @returns {Promise<Response>}
 */
async function serveDocument(request, url) {
  const [id, name, ...rest] = url.pathname.slice(DOCUMENTS_PATH.length).split("/");
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (!isDocumentId(id) || !name || rest.length > 0) return notFound();
  let found;
  try {
    found = await read(id);
  } catch (error) {
    console.error(`Couldn't read document ${id}:`, error);
    return new Response("The library couldn't be read", { status: 500 });
  }
  if (!found) return notFound();
  const { record, blob } = found;

  const etag = `"${id}-${record.revision}"`;
  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    ETag: etag,
  });
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch !== null && ifMatch !== etag) return new Response(null, { status: 412, headers });

  const range = answerRange(request.headers.get("Range"), blob.size);
  if (range.status === 416) {
    headers.set("Content-Range", `bytes */${blob.size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range.status === 206 ? range : { start: 0, end: blob.size - 1 };
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (range.status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${blob.size}`);
  const body = request.method === "HEAD" ? null : chunks(blob.slice(start, end + 1));
  return new Response(body, { status: range.status, headers });
}

/**
 * @param {string} id
 * @returns {Promise<{ record: import("./web/library.js").DocumentRecord, blob: Blob } | null>}
 */
async function read(id) {
  library ??= Library.open().catch((error) => {
    library = null;
    throw error;
  });
  try {
    return await (await library).read(id);
  } catch (error) {
    // The connection closed for a newer version of the database: once more.
    library = null;
    if (/** @type {DOMException} */ (error).name !== "InvalidStateError") throw error;
    library = Library.open();
    return (await library).read(id);
  }
}

/**
 * @param {Blob} blob
 * @returns {ReadableStream<Uint8Array>} the blob, read CHUNK_SIZE at a time
 */
function chunks(blob) {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= blob.size) {
        controller.close();
        return;
      }
      const slice = blob.slice(offset, offset + CHUNK_SIZE);
      offset += slice.size;
      controller.enqueue(new Uint8Array(await slice.arrayBuffer()));
    },
  });
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}
