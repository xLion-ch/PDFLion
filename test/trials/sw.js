/**
 * The trials' service worker, a classic script, since whether Safari 18 takes
 * a module service worker is one of the questions (features.js asks it with
 * sw-module.js). build.js puts answerRange() and BUILD before this.
 *
 * - Installing keeps every file of the build in a cache of its own, fetched
 *   past the HTTP cache, and reports how long that took.
 * - The trials' files come from that cache, with byte ranges for PDFs, so
 *   the trials and the viewer open offline.
 * - `trial-doc/<key>` comes from IndexedDB, with ranges, an ETag and 412 for
 *   a stale If-Match, the contract the web app's /doc/ will keep.
 * - It takes over at once, unlike the web app's will.
 */
/* global answerRange, BUILD */
"use strict";

const CACHE = `trials-${BUILD.id}`;
const SCOPE = new URL(self.registration.scope).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const started = performance.now();
      const cache = await caches.open(CACHE);
      await cache.addAll(BUILD.files.map((file) => new Request(file, { cache: "no-cache" })));
      const ms = Math.round(performance.now() - started);
      await report("install", { files: BUILD.files.length, megabytes: mb(BUILD.bytes), ms });
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("trials-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith(`${SCOPE}trial-doc/`)) {
    event.respondWith(fromDatabase(request, url.pathname.slice(`${SCOPE}trial-doc/`.length)));
  } else {
    event.respondWith(fromCache(request));
  }
});

/** A page asks which build is running, and whether its files are all kept. */
self.addEventListener("message", (event) => {
  if (event.data !== "build" || !event.ports[0]) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const kept = (await cache.keys()).length;
      event.ports[0].postMessage({ id: BUILD.id, files: BUILD.files.length, kept });
    })(),
  );
});

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function fromCache(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (!cached) return fetch(request);
  const range = request.headers.get("Range");
  if (range === null || cached.status !== 200) return cached;
  const etag = cached.headers.get("ETag") ?? '"cached"';
  return answer(request, await cached.blob(), etag, cached.headers);
}

/**
 * @param {Request} request
 * @param {string} key
 * @returns {Promise<Response>}
 */
async function fromDatabase(request, key) {
  const record = await readRecord(decodeURIComponent(key));
  if (!record) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "Content-Type": "application/pdf" });
  return answer(request, record.blob, `"${key}-${record.revision}"`, headers);
}

/**
 * The whole blob, or the range asked for, as src/main/protocol.js answers.
 *
 * @param {Request} request
 * @param {Blob} blob
 * @param {string} etag
 * @param {Headers} base headers to keep, such as Content-Type
 * @returns {Response}
 */
function answer(request, blob, etag, base) {
  const headers = new Headers({
    "Content-Type": base.get("Content-Type") ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
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
  headers.set("Content-Length", String(end - start + 1));
  if (range.status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${blob.size}`);
  const body = blob.slice(start, end + 1);
  const sliced = new URL(request.url).searchParams.has("sliced");
  return new Response(sliced ? slices(body) : body, { status: range.status, headers });
}

/** How much a sliced answer reads at a time. */
const SLICE = 1024 * 1024;

/**
 * A blob as a stream that reads it a slice at a time, for `?sliced`: a
 * response of a large Blob itself fails in WebKit, "Too much data buffered
 * while waiting for the previous multipart part to be handled".
 *
 * @param {Blob} blob
 * @returns {ReadableStream<Uint8Array>}
 */
function slices(blob) {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= blob.size) {
        controller.close();
        return;
      }
      const slice = blob.slice(offset, offset + SLICE);
      offset += slice.size;
      controller.enqueue(new Uint8Array(await slice.arrayBuffer()));
    },
  });
}

/**
 * @param {string} key
 * @returns {Promise<{ blob: Blob, revision: number } | undefined>} from the
 *   database storage.js writes, as trials.js opens it
 */
function readRecord(key) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("pdflion-trials", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("bytes");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const get = open.result.transaction("bytes").objectStore("bytes").get(key);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    };
  });
}

/**
 * Sends a result to the server, as trials.js does. A server without
 * --report answers 404, which is fine.
 *
 * @param {string} trial
 * @param {object} data
 */
async function report(trial, data) {
  const body = JSON.stringify({ trial, device: { userAgent: navigator.userAgent }, data });
  await fetch(`${SCOPE}report`, { method: "POST", body }).catch(() => {});
}

/** @param {number} bytes */
function mb(bytes) {
  return Math.round(bytes / 1e5) / 10;
}
