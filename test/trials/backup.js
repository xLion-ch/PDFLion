/**
 * Backup: whether a ZIP of several GB, made of IndexedDB's Blobs as the web
 * app's Export… makes it, can be shared or downloaded without running out of
 * memory, and whether a ZIP picked in the file input can be read in slices,
 * without being read whole.
 *
 * The ZIP holds copies of the file "Large files in IndexedDB" stored, made
 * with the web app's own zip.js, so a backup of 4 GB needs only 400 MiB of
 * storage. Every step that could end with iPadOS reloading the page is noted
 * in localStorage first, and a page that finds the note reports the step as
 * cut short.
 */
import { element, finish, mb, openDatabase, report } from "./trials.js";
import { crc32Of, readEntry, readZip, writeZip } from "./zip.js";

/** How many copies of the stored file to try. */
const COPIES = [1, 2, 5, 10, 20];

/** storage.js's record. */
const KEY = "trial";

/** A step under way, until it ends or a reload reports it. */
const RUNNING = "trials.backup.running";

/** @type {File | null} the backup made last */
let made = null;

/** @param {HTMLElement} main */
export async function run(main) {
  const params = new URLSearchParams(location.search);
  reportInterrupted();

  const copies = element(
    "select",
    {},
    COPIES.map((count) => element("option", { value: count, textContent: `${count}` })),
  );
  /** @type {HTMLSelectElement} */ (copies).value = params.get("copies") ?? "10";
  const count = () => Number(/** @type {HTMLSelectElement} */ (copies).value);
  const status = element("p", { className: "status" });

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
          report("backup", { action: label, error: String(error) });
        }
      },
    });

  const picker = /** @type {HTMLInputElement} */ (
    element("input", { type: "file", accept: ".zip,application/zip" })
  );
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file) return;
    status.textContent = `Reading ${file.name}…`;
    const result = await attempt(() => readBackup(file, (text) => (status.textContent = text)));
    report("backup-read", result);
    status.textContent = `Read ${file.name}: see the results`;
  });

  main.append(
    element("p", {}, ["Copies of the stored file ", copies]),
    element("p", {}, [
      button("Make", async () => {
        const result = await makeBackup(count(), (text) => (status.textContent = text));
        report("backup-make", result);
        return `Made ${result.zipMB} MB. Now Share or Download it.`;
      }),
      button("Share", async () => report("backup-share", await share())),
      button("Download", async () => {
        report("backup-download", download());
        return "Downloading: check Downloads in Files, then come back.";
      }),
    ]),
    element("p", {}, ["Read a backup ", picker]),
    status,
    element("p", {
      textContent:
        "Write a file first under Large files in IndexedDB, 400 MiB for the largest backups. Make " +
        "zips that many copies of it, as Export… does, and reports how long the CRC-32s took. " +
        "Share hands the ZIP to the share sheet: choose Save to Files, and the result says how " +
        "long it took. Download does what the web app does where it can't share files. Read a " +
        "backup picks a ZIP, such as the one saved, and reads and checks every entry a slice at " +
        "a time. If the page reloads during a step, it reports that step as cut short.",
    }),
  );

  if (params.has("auto")) {
    const results = {
      make: await attempt(() => makeBackup(count(), () => {})),
      read: await attempt(() => readBackup(/** @type {File} */ (made), () => {})),
    };
    report("backup", results);
    finish(results);
  }
}

/**
 * @param {() => Promise<unknown>} step
 * @returns {Promise<any>} what it found, or its error
 */
async function attempt(step) {
  try {
    return await step();
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Zips `count` copies of the stored file, as Export… zips the library's
 * Blobs. The CRC-32 is worked out once, by zip.js reading the first copy, and
 * given for the others, which are then only referred to.
 *
 * @param {number} count
 * @param {(text: string) => void} show
 */
async function makeBackup(count, show) {
  const db = await openDatabase();
  /** @type {{ blob: Blob, revision: number } | undefined} */
  let record;
  try {
    record = await get(db);
  } finally {
    db.close();
  }
  if (!record) throw new Error("nothing is stored: Write under Large files in IndexedDB first");
  const { blob } = record;
  made = null;
  mark("make", { copies: count, fileMB: mb(blob.size) });

  const started = performance.now();
  const crcStarted = started;
  let crcRead = 0;
  const crc = await crc32Of(blob, {
    onRead(bytes) {
      crcRead += bytes;
      show(`CRC-32: ${Math.floor((crcRead * 100) / blob.size)} %`);
    },
  });
  const crcMs = performance.now() - crcStarted;
  const modified = new Date();
  const zip = await writeZip(
    Array.from({ length: count }, (_, index) => ({
      name: `Documents/Copy ${index + 1}.pdf`,
      blob,
      modified,
      crc32: crc,
    })),
  );
  const ms = performance.now() - started;
  made = new File([zip], `PDFLion Trial Backup ${count}.zip`, { type: "application/zip" });
  unmark();
  return {
    copies: count,
    revision: record.revision,
    fileMB: mb(blob.size),
    zipMB: mb(made.size),
    zip64: made.size > 0xffffffff,
    crcMs: Math.round(crcMs),
    crcMBPerSecond: Math.round(blob.size / 1e6 / (crcMs / 1000)),
    makeMs: Math.round(ms),
    canShare: navigator.canShare?.({ files: [made] }) ?? false,
  };
}

/**
 * Shares the backup, and times the share sheet until it's done, which for
 * Save to Files includes the copy.
 */
async function share() {
  if (!made) throw new Error("Make a backup first");
  const file = made;
  const result = { zipMB: mb(file.size), canShare: navigator.canShare?.({ files: [file] }) ?? false };
  if (!navigator.share) return { ...result, shared: false, error: "no navigator.share()" };
  mark("share", result);
  const started = performance.now();
  try {
    await navigator.share({ files: [file] });
    return { ...result, shared: true, ms: Math.round(performance.now() - started) };
  } catch (error) {
    const { name, message } = /** @type {Error} */ (error);
    return { ...result, shared: false, error: `${name}: ${message}`, ms: Math.round(performance.now() - started) };
  } finally {
    unmark();
  }
}

/** Downloads the backup through a link, as shell.js does where files can't be shared. */
function download() {
  if (!made) throw new Error("Make a backup first");
  const url = URL.createObjectURL(made);
  const link = element("a", { href: url, download: made.name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
  return {
    zipMB: mb(made.size),
    standalone: matchMedia("(display-mode: standalone)").matches,
    started: true,
  };
}

/**
 * Reads a ZIP's directory, then every entry, checking each one's CRC-32 as
 * readEntry() does on import: stored entries a slice at a time, deflated
 * ones inflated into memory.
 *
 * @param {File} file
 * @param {(text: string) => void} show
 */
async function readBackup(file, show) {
  if (!file) throw new Error("no backup to read");
  mark("read", { name: file.name, zipMB: mb(file.size) });
  try {
    const started = performance.now();
    const entries = await readZip(file);
    const directoryMs = performance.now() - started;
    const files = entries.filter((entry) => !entry.name.endsWith("/"));
    const total = files.reduce((sum, entry) => sum + entry.size, 0);
    let read = 0;
    const deflated = files.filter((entry) => entry.method !== 0).length;
    const readStarted = performance.now();
    for (const entry of files) {
      show(`Reading ${entry.name}: ${total ? Math.floor((read * 100) / total) : 100} %`);
      await readEntry(file, entry);
      read += entry.size;
    }
    const readMs = performance.now() - readStarted;
    return {
      zipMB: mb(file.size),
      entries: files.length,
      deflated,
      directoryMs: Math.round(directoryMs),
      readMs: Math.round(readMs),
      readMBPerSecond: readMs > 0 ? Math.round(total / 1e6 / (readMs / 1000)) : null,
      checked: true,
    };
  } finally {
    unmark();
  }
}

/**
 * @param {string} step
 * @param {Record<string, unknown>} details
 */
function mark(step, details) {
  localStorage.setItem(RUNNING, JSON.stringify({ step, ...details, startedAt: Date.now() }));
}

function unmark() {
  localStorage.removeItem(RUNNING);
}

/** Reports a step that a reload cut short, as iPadOS does when memory runs out. */
function reportInterrupted() {
  const running = JSON.parse(localStorage.getItem(RUNNING) ?? "null");
  if (!running) return;
  unmark();
  const { startedAt, ...details } = running;
  report("backup", {
    cutShort: true,
    ...details,
    seconds: Math.round((Date.now() - startedAt) / 1000),
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
