/**
 * Large files in IndexedDB: what a save of a whole file costs, how quickly
 * the service worker serves byte ranges of it, as pdf.js asks for them, and
 * whether a save started as the app is left gets stored.
 *
 * The bytes are a pattern, made fresh for each revision, that doesn't
 * compress, and every range read is checked against it.
 */
import { element, finish, mb, openDatabase, report } from "./trials.js";

/** The sizes to try, in MiB. */
const SIZES = [10, 50, 100, 200, 400];

/** The record's key, which sw.js serves at trial-doc/<key>. */
const KEY = "trial";

/** pdf.js's `rangeChunkSize`: the ranges it asks for. */
const RANGE = 64 * 1024;

const MIB = 1024 * 1024;

/** The last revision written, so that each write's pattern differs. */
const REVISION = "trials.storage.revision";

/** A save started as the page was hidden, until a later look reports it. */
const LEAVING_SAVE = "trials.storage.leavingSave";

/** @param {HTMLElement} main */
export async function run(main) {
  const params = new URLSearchParams(location.search);
  const size = element(
    "select",
    {},
    SIZES.map((mib) => element("option", { value: mib, textContent: `${mib} MiB` })),
  );
  /** @type {HTMLSelectElement} */ (size).value = params.get("size") ?? "200";
  const status = element("p", { className: "status" });
  const megabytes = () => Number(/** @type {HTMLSelectElement} */ (size).value);

  /**
   * @param {string} label
   * @param {() => Promise<string | void>} action what it resolves to replaces "done"
   */
  const button = (label, action) =>
    element("button", {
      textContent: label,
      onclick: async () => {
        status.textContent = `${label}…`;
        try {
          status.textContent = (await action()) ?? `${label}: done`;
        } catch (error) {
          status.textContent = `${label}: ${error}`;
          report("storage", { action: label, error: String(error) });
        }
      },
    });

  main.append(
    element("p", {}, ["Size ", size]),
    element("p", {}, [
      button("Write", async () => report("storage-write", await write(megabytes()))),
      button("Read ranges", async () => report("storage-read", await readRanges())),
      button("Save on leaving", async () => {
        await arm(megabytes());
        return (
          "Armed. Now leave: go to the Home Screen or another app for 10 s, or lock the iPad, " +
          "or end the app in the app switcher, then come back."
        );
      }),
    ]),
    status,
    element("p", {
      textContent:
        "Write stores one file of that size as one save. Read ranges reads 64 KiB and 1 MiB " +
        "ranges of it through the service worker, and the same in the page, for comparison. " +
        "Save on leaving makes a new revision, and saves it once the page is hidden. The next " +
        "look reports whether it was stored.",
    }),
  );

  await reportLeavingSave("reopened");
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveOnLeaving();
    else reportLeavingSave("came back");
  });
  window.addEventListener("pagehide", saveOnLeaving);

  // For the Simulator, where `simctl` can open a URL but not tap a button.
  if (params.has("arm")) {
    await arm(megabytes());
    status.textContent = "Armed.";
  }
  if (params.has("read")) report("storage-read", await attempt(readRanges));

  if (params.has("auto")) {
    const results = {
      write: await attempt(() => write(megabytes())),
      read: await attempt(readRanges),
    };
    report("storage", results);
    finish(results);
  }
}

/**
 * @param {() => Promise<unknown>} step
 * @returns {Promise<unknown>} what it found, or its error
 */
async function attempt(step) {
  try {
    return await step();
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Stores a new revision of the given size in one transaction, as the web
 * app's autosave would.
 *
 * @param {number} mib
 */
async function write(mib) {
  const before = await navigator.storage?.estimate?.();
  const revision = nextRevision();
  const started = performance.now();
  const blob = pattern(mib, revision);
  const made = performance.now();
  const db = await openDatabase();
  try {
    await put(db, { blob, revision });
  } finally {
    db.close();
  }
  const stored = performance.now();
  const after = await navigator.storage?.estimate?.();
  return {
    mib,
    revision,
    makeMs: Math.round(made - started),
    storeMs: Math.round(stored - made),
    storeMBPerSecond: Math.round((mib * MIB) / 1e6 / ((stored - made) / 1000)),
    usageMB: after ? mb(after.usage ?? 0) : null,
    usageChangeMB: before && after ? mb((after.usage ?? 0) - (before.usage ?? 0)) : null,
    quotaMB: after ? mb(after.quota ?? 0) : null,
  };
}

/** Reads ranges through the service worker, then in the page. */
async function readRanges() {
  if (!navigator.serviceWorker?.controller) {
    throw new Error("no service worker controls the page: reload it");
  }
  const first = await fetch(`trial-doc/${KEY}`, { headers: { Range: "bytes=0-3" } });
  if (first.status !== 206) throw new Error(`expected 206, got ${first.status}: write first`);
  const size = Number(/\/(\d+)$/.exec(first.headers.get("Content-Range") ?? "")?.[1]);
  const etag = first.headers.get("ETag") ?? "";
  const revision = Number(/-(\d+)"$/.exec(etag)?.[1]);
  await first.arrayBuffer();

  /** @param {number} length */
  const randomStart = (length) => 4 * Math.floor(Math.random() * ((size - length) / 4));

  /**
   * @param {number} start
   * @param {number} length
   */
  const fetchRange = async (start, length) => {
    const response = await fetch(`trial-doc/${KEY}`, {
      headers: { Range: `bytes=${start}-${start + length - 1}`, "If-Match": etag },
    });
    const bytes = await response.arrayBuffer();
    if (response.status !== 206 || bytes.byteLength !== length) {
      throw new Error(`range ${start}: ${response.status}, ${bytes.byteLength} bytes`);
    }
    check(bytes, start, revision);
  };

  const db = await openDatabase();
  const record = await get(db);
  db.close();
  /**
   * @param {number} start
   * @param {number} length
   */
  const sliceInPage = async (start, length) => {
    check(await record.blob.slice(start, start + length).arrayBuffer(), start, revision);
  };

  const stale = await fetch(`trial-doc/${KEY}`, {
    headers: { Range: "bytes=0-3", "If-Match": '"stale"' },
  });

  return {
    mib: Math.round(size / MIB),
    revision,
    staleIfMatch: stale.status,
    worker64KiB: await attempt(() => timeEach(40, () => fetchRange(randomStart(RANGE), RANGE))),
    worker1MiB: await attempt(() => timeEach(10, () => fetchRange(randomStart(MIB), MIB))),
    worker64KiBEightAtOnce: await attempt(() =>
      timeParallel(8, 5, () => fetchRange(randomStart(RANGE), RANGE)),
    ),
    page64KiB: await attempt(() => timeEach(40, () => sliceInPage(randomStart(RANGE), RANGE))),
    page1MiB: await attempt(() => timeEach(10, () => sliceInPage(randomStart(MIB), MIB))),
    whole: await attempt(() => timeWhole(etag, size, "")),
    wholeSliced: await attempt(() => timeWhole(etag, size, "?sliced")),
  };
}

/**
 * Reads the whole file through the service worker, which answers with the
 * Blob, or with `?sliced` a stream that reads it a slice at a time.
 *
 * @param {string} etag
 * @param {number} size
 * @param {string} query
 */
async function timeWhole(etag, size, query) {
  const started = performance.now();
  const response = await fetch(`trial-doc/${KEY}${query}`, { headers: { "If-Match": etag } });
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  let firstChunkMs = null;
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    firstChunkMs ??= Math.round(performance.now() - started);
    read += value.length;
  }
  const ms = performance.now() - started;
  if (read !== size) throw new Error(`read ${read} of ${size} bytes`);
  return { firstChunkMs, ms: Math.round(ms), MBPerSecond: Math.round(size / 1e6 / (ms / 1000)) };
}

/**
 * @param {number} count
 * @param {() => Promise<void>} task
 * @returns {Promise<{ medianMs: number, p90Ms: number, maxMs: number }>}
 */
async function timeEach(count, task) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    await task();
    times.push(performance.now() - started);
  }
  return summary(times);
}

/**
 * @param {number} atOnce
 * @param {number} rounds
 * @param {() => Promise<void>} task
 */
async function timeParallel(atOnce, rounds, task) {
  const times = [];
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    await Promise.all(Array.from({ length: atOnce }, task));
    times.push(performance.now() - started);
  }
  return summary(times);
}

/** @param {number[]} times */
function summary(times) {
  const sorted = times.toSorted((a, b) => a - b);
  const at = (/** @type {number} */ share) => {
    const index = Math.min(sorted.length - 1, Math.floor(share * sorted.length));
    return Math.round(sorted[index] * 10) / 10;
  };
  return { medianMs: at(0.5), p90Ms: at(0.9), maxMs: at(1) };
}

/** @type {{ db: IDBDatabase, blob: Blob, revision: number, mib: number } | null} */
let armed = null;

/**
 * Makes the next revision, and opens the database, so that saving it once
 * the page is hidden only has to start the transaction.
 *
 * @param {number} mib
 */
async function arm(mib) {
  armed?.db.close();
  const revision = nextRevision();
  armed = { db: await openDatabase(), blob: pattern(mib, revision), revision, mib };
}

function saveOnLeaving() {
  if (!armed) return;
  const { db, blob, revision, mib } = armed;
  armed = null;
  const save = { revision, mib, startedAt: Date.now(), completedAt: null };
  localStorage.setItem(LEAVING_SAVE, JSON.stringify(save));
  const transaction = db.transaction("bytes", "readwrite");
  transaction.objectStore("bytes").put({ blob, revision }, KEY);
  transaction.oncomplete = () => {
    localStorage.setItem(LEAVING_SAVE, JSON.stringify({ ...save, completedAt: Date.now() }));
    db.close();
  };
}

/**
 * Reports a save started as the page was hidden: whether the database has
 * its revision, and how long it took, if the page saw it end.
 *
 * @param {string} how `reopened`, after a reload or a new launch, or `came back`
 */
async function reportLeavingSave(how) {
  const save = JSON.parse(localStorage.getItem(LEAVING_SAVE) ?? "null");
  if (!save) return;
  // A read waits for a write still under way, which then notes its end.
  const db = await openDatabase();
  const record = await get(db);
  db.close();
  const latest = JSON.parse(localStorage.getItem(LEAVING_SAVE) ?? "null") ?? save;
  localStorage.removeItem(LEAVING_SAVE);
  report("storage-leaving", {
    how,
    mib: save.mib,
    stored: record?.revision === save.revision,
    storedRevision: record?.revision ?? null,
    savedMs: latest.completedAt ? latest.completedAt - latest.startedAt : null,
    awaySeconds: Math.round((Date.now() - save.startedAt) / 1000),
  });
}

/** @returns {number} */
function nextRevision() {
  const revision = Number(localStorage.getItem(REVISION) ?? "0") + 1;
  localStorage.setItem(REVISION, String(revision));
  return revision;
}

/**
 * @param {number} mib
 * @param {number} revision
 * @returns {Blob} `mib` MiB of words that depend on their position and the revision
 */
function pattern(mib, revision) {
  const words = MIB / 4;
  const chunks = [];
  for (let chunk = 0; chunk < mib; chunk++) {
    const array = new Uint32Array(words);
    const base = chunk * words;
    for (let i = 0; i < words; i++) array[i] = word(base + i, revision);
    chunks.push(array);
  }
  return new Blob(chunks, { type: "application/pdf" });
}

/**
 * Checks the first and last word of bytes read from `start`.
 *
 * @param {ArrayBuffer} bytes
 * @param {number} start a multiple of 4
 * @param {number} revision
 */
function check(bytes, start, revision) {
  const view = new DataView(bytes);
  for (const offset of [0, bytes.byteLength - 4]) {
    if (view.getUint32(offset, true) !== word((start + offset) / 4, revision)) {
      throw new Error(`the bytes at ${start + offset} aren't revision ${revision}'s`);
    }
  }
}

/**
 * @param {number} index
 * @param {number} revision
 */
function word(index, revision) {
  let x = (index ^ Math.imul(revision, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * @param {IDBDatabase} db
 * @param {{ blob: Blob, revision: number }} record
 * @returns {Promise<void>} once the transaction has committed
 */
function put(db, record) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("bytes", "readwrite");
    transaction.objectStore("bytes").put(record, KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
  });
}

/**
 * @param {IDBDatabase} db
 * @returns {Promise<{ blob: Blob, revision: number } | undefined>}
 */
function get(db) {
  return new Promise((resolve, reject) => {
    const request = db.transaction("bytes").objectStore("bytes").get(KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
