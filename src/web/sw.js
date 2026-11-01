/**
 * The web app's service worker, a module, at the root of the app, whose
 * folder is its scope. scripts/build-web.js writes the version into it, so
 * that each release's differs, which is how browsers find an update.
 *
 * It serves the library's documents at `doc/<id>/<name>`, as src/main/
 * protocol.js serves `/doc/` on the desktop: whole or as byte ranges, with
 * an ETag of `"<id>-<revision>"`, and 412 for a stale If-Match, so that
 * bridge.js's range transport works as it does there. Everything else goes
 * to the network.
 *
 * It takes over the pages once it's active, and a new version waits until
 * nothing runs the old one.
 *
 * Its imports name the files as they are in the built app, whose root it's
 * at, rather than in src/web/.
 */
import { answerRange } from "./shared/ranges.js";
import { Library, isDocumentId } from "./web/library.js";

/** Written by scripts/build-web.js. */
const VERSION = "dev";

/** Where the library's documents are: `doc/<id>/<name>`. */
const DOCUMENTS_PATH = new URL("doc/", self.registration.scope).pathname;

/**
 * How much of a document a response reads at a time. A response whose body
 * is a large Blob fails in WebKit, and Safari sends it only once it has read
 * all of it.
 */
const CHUNK_SIZE = 1024 * 1024;

/** @type {Promise<Library> | null} */
let library = null;

self.addEventListener("install", () => {
  console.info(`PDFLion ${VERSION}'s service worker is installed.`);
});

self.addEventListener("activate", (/** @type {any} */ event) => {
  event.waitUntil(/** @type {any} */ (self).clients.claim());
});

// The shell asks when it isn't controlled although the worker is active, as
// after a reload that bypassed it.
self.addEventListener("message", (/** @type {any} */ event) => {
  if (event.data === "claim") event.waitUntil(/** @type {any} */ (self).clients.claim());
});

self.addEventListener("fetch", (/** @type {any} */ event) => {
  /** @type {Request} */
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(DOCUMENTS_PATH)) return;
  event.respondWith(serveDocument(request, url));
});

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
