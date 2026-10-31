/**
 * Asks the browser what the web app would use, and reports the answers, so
 * that an iPad's can be compared with Playwright's WebKit's.
 */
import { device, element, finish, openDatabase, report, sleep, workerBuild } from "./trials.js";

/** How long a probe may take. */
const PROBE_TIMEOUT = 15_000;

/** @type {Record<string, () => unknown>} */
const PROBES = {
  browser: () => device(),
  secureContext: () => isSecureContext,
  serviceWorker: async () => {
    const registration = await navigator.serviceWorker?.ready;
    const build = await workerBuild();
    return {
      registered: !!registration,
      controlling: !!navigator.serviceWorker?.controller,
      build,
    };
  },
  moduleServiceWorker: probeModuleWorker,
  indexedDBBlob: probeBlobStorage,
  cacheStorage: () => typeof caches?.open === "function",
  storage: async () => {
    const estimate = await navigator.storage?.estimate?.();
    return {
      usageMB: estimate ? Math.round((estimate.usage ?? 0) / 1e6) : null,
      quotaMB: estimate ? Math.round((estimate.quota ?? 0) / 1e6) : null,
      persistedBefore: await navigator.storage?.persisted?.(),
      persist: await navigator.storage?.persist?.(),
    };
  },
  opfsInPage: () => ({
    getDirectory: typeof navigator.storage?.getDirectory === "function",
    createWritable:
      typeof FileSystemFileHandle === "function" &&
      typeof FileSystemFileHandle.prototype.createWritable === "function",
  }),
  opfsInWorker: probeWorker,
  filePickers: () => ({
    showOpenFilePicker: typeof (/** @type {any} */ (window).showOpenFilePicker),
    showSaveFilePicker: typeof (/** @type {any} */ (window).showSaveFilePicker),
    launchQueue: "launchQueue" in window,
  }),
  share: () => {
    const file = new File(["%PDF-1.7"], "Trial.pdf", { type: "application/pdf" });
    return {
      share: typeof navigator.share === "function",
      canShareFiles: navigator.canShare?.({ files: [file] }) ?? null,
    };
  },
  pointerEvents: () => ({
    getCoalescedEvents: typeof PointerEvent.prototype.getCoalescedEvents === "function",
    getPredictedEvents: typeof PointerEvent.prototype.getPredictedEvents === "function",
    altitudeAngle: "altitudeAngle" in PointerEvent.prototype,
    pointerrawupdate: "onpointerrawupdate" in window,
  }),
  touch: () => ({
    touchEvents: "ontouchstart" in window,
    maxTouchPoints: navigator.maxTouchPoints,
    touchType: typeof Touch === "function" && "touchType" in Touch.prototype,
  }),
  gestureEvents: () => "ongesturestart" in window,
  fullscreen: () => ({
    fullscreenEnabled: document.fullscreenEnabled ?? null,
    webkitFullscreenEnabled: /** @type {any} */ (document).webkitFullscreenEnabled ?? null,
    requestFullscreen: typeof Element.prototype.requestFullscreen === "function",
    webkitRequestFullscreen:
      typeof (/** @type {any} */ (Element.prototype).webkitRequestFullscreen) === "function",
  }),
  print: () => typeof window.print === "function",
  media: () =>
    Object.fromEntries(
      [
        "(display-mode: standalone)",
        "(pointer: coarse)",
        "(any-pointer: fine)",
        "(hover: hover)",
        "(any-hover: hover)",
        "(prefers-contrast: more)",
        "(forced-colors: active)",
      ].map((query) => [query, matchMedia(query).matches]),
    ),
  safeAreaInsets: () => CSS.supports("padding-top: env(safe-area-inset-top)"),
  dialog: () => typeof HTMLDialogElement === "function",
  popover: () => Object.hasOwn(HTMLElement.prototype, "popover"),
  relativeTimeFormat: () => typeof Intl.RelativeTimeFormat === "function",
  sha256: () => typeof crypto.subtle?.digest === "function",
  messageChannel: () => typeof MessageChannel === "function",
  visualViewport: () => !!window.visualViewport,
};

/** @param {HTMLElement} main */
export async function run(main) {
  const body = element("tbody");
  main.append(element("table", {}, [body]));

  /** @type {Record<string, unknown>} */
  const results = {};
  for (const [name, probe] of Object.entries(PROBES)) {
    const cell = element("td", { textContent: "…" });
    body.append(element("tr", {}, [element("th", { textContent: name }), cell]));
    try {
      results[name] = await Promise.race([
        probe(),
        sleep(PROBE_TIMEOUT).then(() => Promise.reject(new Error("timed out"))),
      ]);
    } catch (error) {
      results[name] = error instanceof Error ? `${error.name}: ${error.message}` : `threw ${error}`;
    }
    cell.textContent = JSON.stringify(results[name], null, 1);
  }
  report("features", results);
  finish(results);
}

/**
 * Registers sw-module.js as a module at a scope of its own, and asks it
 * whether its import worked.
 */
async function probeModuleWorker() {
  if (!("serviceWorker" in navigator)) return "no service workers";
  const scope = new URL("module-probe/", location.href).href;
  const registration = await navigator.serviceWorker.register("sw-module.js", {
    type: "module",
    scope,
    updateViaCache: "none",
  });
  try {
    const worker = await activeWorker(registration);
    const answer = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      worker.postMessage("ping", [channel.port2]);
    });
    return { registered: true, ...answer };
  } finally {
    await registration.unregister();
  }
}

/**
 * @param {ServiceWorkerRegistration} registration
 * @returns {Promise<ServiceWorker>}
 */
function activeWorker(registration) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (registration.active) resolve(registration.active);
      const pending = registration.installing ?? registration.waiting;
      pending?.addEventListener("statechange", () => {
        if (pending.state === "redundant") reject(new Error("the module worker became redundant"));
        check();
      });
    };
    check();
  });
}

/** Stores a Blob of 1 MiB in IndexedDB and reads it back. */
async function probeBlobStorage() {
  const bytes = new Uint8Array(1 << 20).map((_, index) => index & 255);
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("bytes", "readwrite");
      transaction.objectStore("bytes").put({ blob: new Blob([bytes]), revision: 0 }, "probe");
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
    });
    const record = await new Promise((resolve, reject) => {
      const get = db.transaction("bytes").objectStore("bytes").get("probe");
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    const back = new Uint8Array(await record.blob.slice(1000, 1004).arrayBuffer());
    db.transaction("bytes", "readwrite").objectStore("bytes").delete("probe");
    return {
      isBlob: record.blob instanceof Blob,
      size: record.blob.size,
      sliceMatches: back.every((byte, index) => byte === ((1000 + index) & 255)),
    };
  } finally {
    db.close();
  }
}

/** Asks worker.js about the origin private file system. */
function probeWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker("worker.js");
    worker.onmessage = (event) => {
      resolve(event.data);
      worker.terminate();
    };
    worker.onerror = (event) => reject(new Error(event.message));
    worker.postMessage("probe");
  });
}
