/**
 * What the trial pages share: the list of trials, the device, sending
 * results to the Mac that serves them, the service worker, and the trials'
 * IndexedDB database.
 */

/**
 * The trials, each with the questions about the web app it answers.
 * Each has a module of its name, whose run() builds its page.
 */
export const TRIALS = [
  {
    name: "features",
    title: "Features",
    answers:
      "Safari 18's service worker; Playwright's WebKit; Home Screen apps; Apple Pencil events",
    about:
      "Asks the browser what the web app would use: service workers (also as a module), " +
      "IndexedDB, the origin private file system, sharing, Pointer Events, gestures, full " +
      "screen. Runs by itself.",
  },
  {
    name: "storage",
    title: "Large files in IndexedDB",
    answers: "Reading large files; autosave on large files; storage limits",
    about:
      "Writes a large file into IndexedDB as one save, reads byte ranges of it through the " +
      "service worker as pdf.js would, and checks whether a save started as the app is left " +
      "gets stored.",
  },
  {
    name: "memory",
    title: "Viewer frames in memory",
    answers: "Memory",
    about:
      "Opens today's viewer in one frame after another, each like a tab, and counts how many are " +
      "loaded when iPadOS reloads the page. The count survives the reload.",
  },
  {
    name: "pencil",
    title: "Apple Pencil and touch",
    answers: "Apple Pencil events",
    about:
      "Draws what the Pencil and fingers send, and sums up each stroke: pressure, tilt, how " +
      "often events come, coalesced events, hovering, and the touches of a resting palm.",
  },
  {
    name: "keys",
    title: "Keys, printing, full screen, pinching",
    answers: "Home Screen apps",
    about:
      "Which ⌘ shortcuts reach the page, whether window.print() and element full screen work, " +
      "and whether stopping gesturestart keeps a pinch from zooming the page. Try it as a Home " +
      "Screen app.",
  },
  {
    name: "layout",
    title: "Safe areas",
    answers: "iPadOS 26's window controls",
    about:
      "Shows env(safe-area-inset-*) and marks the edges it covers, so you can see whether the " +
      "window controls of an iPadOS 26 window cover anything the insets don't.",
  },
];

/** Whether run.js drives the page, which then runs without being touched. */
export const auto = new URLSearchParams(location.search).has("auto");

/** Where memory.js keeps a run, which a reload of any trial page reports. */
export const MEMORY_RUN = "trials.memoryRun";

/** @returns {Record<string, unknown>} what the results say about the device */
export function device() {
  const userAgent = navigator.userAgent;
  return {
    userAgent,
    safari: /Version\/([\d.]+).*Safari/.exec(userAgent)?.[1] ?? null,
    iPad: /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1),
    standalone:
      matchMedia("(display-mode: standalone)").matches ||
      /** @type {any} */ (navigator).standalone === true,
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
    viewport: `${innerWidth}×${innerHeight}`,
  };
}

/**
 * Shows a result on the page and sends it to the server, which adds it to
 * test/trials/results.jsonl. Without a server that takes it, it's only shown.
 *
 * @param {string} trial
 * @param {unknown} data
 */
export function report(trial, data) {
  const results = document.getElementById("results");
  if (results) {
    const entry = document.createElement("pre");
    const time = new Date().toLocaleTimeString();
    entry.textContent = `${time}  ${trial}\n${JSON.stringify(data, null, 2)}`;
    results.prepend(entry);
  }
  fetch("report", {
    method: "POST",
    body: JSON.stringify({ trial, device: device(), data }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Marks the page done, for run.js.
 *
 * @param {unknown} results
 */
export function finish(results) {
  /** @type {any} */ (window).trialResults = results;
  document.body.dataset.done = "true";
}

/**
 * Registers sw.js, and reports a memory run that a reload cut short. Every
 * trial page calls it first.
 *
 * @returns {Promise<ServiceWorkerRegistration | null>}
 */
export async function start() {
  reportInterruptedRun();
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
  } catch (error) {
    report("service-worker", { registered: false, error: String(error) });
    return null;
  }
}

/**
 * Asks the service worker that controls the page which build it has.
 *
 * @returns {Promise<{ id: string, files: number, kept: number } | null>}
 */
export function workerBuild() {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    controller.postMessage("build", [channel.port2]);
    setTimeout(() => resolve(null), 5000);
  });
}

/**
 * A memory run that is still marked running when a page loads ended with a
 * reload, which iPadOS does when the page uses too much memory.
 */
function reportInterruptedRun() {
  const run = JSON.parse(localStorage.getItem(MEMORY_RUN) ?? "null");
  if (!run?.running) return;
  localStorage.setItem(MEMORY_RUN, JSON.stringify({ ...run, running: false, reloaded: true }));
  report("memory", {
    reloaded: true,
    loadedFrames: run.loaded,
    whileOpening: run.loaded + 1,
    document: run.document,
    seconds: Math.round((Date.now() - run.startedAt) / 1000),
  });
}

/** @returns {Promise<IDBDatabase>} the database storage.js writes and sw.js reads */
export function openDatabase() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("pdflion-trials", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("bytes");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Makes an element.
 *
 * @param {string} tag
 * @param {Record<string, any>} [properties]
 * @param {(Node | string)[]} [children]
 * @returns {HTMLElement}
 */
export function element(tag, properties = {}, children = []) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

/** @param {number} bytes */
export function mb(bytes) {
  return Math.round(bytes / 1e5) / 10;
}
