/**
 * Runs the web app for its end-to-end tests. Each test gets a persistent
 * profile of its own, as Safari has one: in Playwright's default contexts,
 * WebKit stores no Blobs in IndexedDB.
 *
 * The shell is the page, and each tab a frame of it, the viewer's or
 * Home's. The helpers below find them by their URLs, and read the library
 * as the shell keeps it. Tests of offline use and updates serve a build of
 * their own (serveApp()), which they can swap or stop.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { serve } from "../../scripts/serve-web.js";

export { expect };

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Frame} Frame */

export const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/** The 14-page paper that ships with the pdf.js build. */
export const TRACEMONKEY = path.join(
  ROOT,
  "vendor/pdf.js/build/generic/web/compressed.tracemonkey-pldi-09.pdf",
);

/** Of a project's options, what makes a context look like its device. */
const CONTEXT_OPTIONS = [
  "viewport",
  "userAgent",
  "deviceScaleFactor",
  "isMobile",
  "hasTouch",
  "baseURL",
  "locale",
];

/**
 * Playwright's test, with `context` and `page` in a persistent profile, and
 * `dir`, a folder for the test's files.
 */
export const test = base.extend({
  // A test's own locale, from test.use(), comes as a fixture.
  context: async ({ playwright, browserName, locale }, use, testInfo) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "pdflion-web-"));
    /** @type {Record<string, unknown>} */
    const projectOptions = { ...testInfo.project.use, ...(locale ? { locale } : {}) };
    const options = Object.fromEntries(
      CONTEXT_OPTIONS.filter((key) => projectOptions[key] !== undefined).map((key) => [
        key,
        projectOptions[key],
      ]),
    );
    const context = await playwright[browserName].launchPersistentContext(profile, options);
    await use(context);
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()));
  },
  dir: async ({}, use) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdflion-web-files-"));
    await use(dir);
    await fs.rm(dir, { recursive: true, force: true });
  },
});

/**
 * Opens the app, and waits until Home has drawn.
 *
 * @param {Page} page
 * @param {string} [url] the app's, if not the tests' server's
 * @returns {Promise<Frame>} Home's frame
 */
export async function openApp(page, url = "./") {
  await page.goto(url);
  return homeFrame(page);
}

/**
 * The paths of the service worker's scripts, which the browser fetches
 * past every cache whenever it checks for a new version.
 */
export const SERVICE_WORKER_SCRIPTS = [
  "/PDFLion/sw.js",
  "/PDFLion/shared/ranges.js",
  "/PDFLion/web/library.js",
  "/PDFLion/web/precache.js",
];

/**
 * Serves a build of the app at /PDFLion/ on a port of its own, as
 * scripts/serve-web.js does for every test, and notes what's asked for.
 *
 * @param {string} root the build's folder
 * @returns {Promise<{ url: string, requests: string[], close: () => Promise<void> }>}
 *   the app's URL, the paths asked for, and a way to stop serving, as when
 *   the network is gone
 */
export async function serveApp(root) {
  const { server, urls } = await serve({ root, port: 0, host: "localhost" });
  /** @type {string[]} */
  const requests = [];
  server.on("request", (/** @type {import("node:http").IncomingMessage} */ request) => {
    requests.push(new URL(request.url ?? "/", "http://localhost").pathname);
  });
  return {
    url: urls[0],
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * @param {Page} page
 * @returns {Promise<string>} the version of the app the page runs, as its
 *   service worker serves it
 */
export function appVersion(page) {
  return page.evaluate(async () => (await import(new URL("web/version.js", location.href).href)).VERSION);
}

/**
 * @param {Page} page
 * @returns {Promise<any>} the open tabs, as the shell last stored them
 */
export function readSession(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open("pdflion");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const session = await new Promise((resolve, reject) => {
      const request = database.transaction("session").objectStore("session").get("tabs");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return session;
  });
}

/**
 * @param {Page} page
 * @returns {string[]} the files of the viewers whose frames are loaded
 */
export function loadedDocuments(page) {
  return page
    .frames()
    .map((frame) => URL.parse(frame.url()))
    .filter((url) => url?.pathname.endsWith("/viewer/web/viewer.html"))
    .map((url) => decodeURIComponent((url?.searchParams.get("file") ?? "").split("/").pop() ?? ""))
    .sort();
}

/**
 * Opens the app as one that has already explained where its saves go, so
 * that the explanation's dialog, which takes every press while it shows,
 * doesn't come in the way of a test's taps.
 *
 * @param {Page} page
 * @returns {Promise<Frame>} Home's frame
 */
export async function openAppExplained(page) {
  await openApp(page);
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open("pdflion");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("settings", "readwrite");
      transaction.objectStore("settings").put(true, "notInFilesExplained");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();
  return homeFrame(page);
}

/**
 * @param {Page} page
 * @param {(url: string) => boolean} test
 * @returns {Promise<Frame>}
 */
async function frameWhere(page, test) {
  /** @type {Frame | undefined} */
  let frame;
  await expect
    .poll(() => (frame = page.frames().find((other) => other !== page.mainFrame() && test(other.url()))), {
      timeout: 30_000,
    })
    .toBeTruthy();
  return /** @type {Frame} */ (frame);
}

/**
 * @param {Page} page
 * @returns {Promise<Frame>} Home's frame, once it shows and has drawn. Home's
 *   tab is there from the start, so its frame may be loaded but hidden.
 */
export async function homeFrame(page) {
  const frame = await frameWhere(page, (url) => url.includes("/home/home.html")).catch(
    async (error) => {
      throw new Error(`Home never showed. ${await startState(page)}`, { cause: error });
    },
  );
  await page.locator("#frames > .page.active[src$='/home/home.html']").waitFor({ state: "attached" });
  await frame.locator("#recent:not([hidden]), #empty:not([hidden])").waitFor();
  return frame;
}

/**
 * @param {Page} page
 * @returns {Promise<string>} how far the shell got starting: its service
 *   worker, which caches the app's files, and the library, for a launch that
 *   never shows Home
 */
function startState(page) {
  return page
    .evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const worker = (/** @type {ServiceWorker | null | undefined} */ w) => w?.state ?? "none";
      const caches_ = await Promise.all(
        (await caches.keys()).map(
          async (name) => `${name} (${(await (await caches.open(name)).keys()).length} files)`,
        ),
      );
      const databases = (await indexedDB.databases?.())?.map(({ name }) => name) ?? "unknown";
      return JSON.stringify({
        installing: worker(registration?.installing),
        waiting: worker(registration?.waiting),
        active: worker(registration?.active),
        controlled: !!navigator.serviceWorker.controller,
        caches: caches_,
        databases,
        tabs: document.querySelectorAll("#tabs .tab").length,
      });
    })
    .catch((/** @type {Error} */ error) => `Its state couldn't be read: ${error.message}`);
}

/**
 * @param {Page} page
 * @param {string} name the document's
 * @returns {Promise<Frame>} the frame of its viewer, once it shows a page
 */
export async function documentFrame(page, name) {
  const frame = await frameWhere(page, (url) => {
    // A frame that's still loading has no URL yet.
    const parsed = URL.parse(url);
    return (
      !!parsed &&
      parsed.pathname.endsWith("/viewer/web/viewer.html") &&
      (parsed.searchParams.get("file") ?? "").endsWith(`/${encodeURIComponent(name)}`)
    );
  });
  await rendered(frame);
  return frame;
}

/**
 * Waits until the viewer has rendered its first page, and its bridge.js is
 * listening.
 *
 * @param {Frame} frame
 */
export async function rendered(frame) {
  await frame.locator('.page[data-page-number="1"] canvas').first().waitFor({ timeout: 30_000 });
  await frame.waitForFunction(() => window.PDFViewerApplication?.pdfDocument && window.PDFViewerApplication.pdfViewer.pagesCount > 0);
}

/**
 * Opens files through the file picker that an Open… opens.
 *
 * @param {Page} page
 * @param {import("@playwright/test").Locator} open the button
 * @param {string[]} files
 */
export async function pickFiles(page, open, files) {
  const chooser = page.waitForEvent("filechooser");
  await open.click();
  await (await chooser).setFiles(files);
}

/**
 * @param {Page} page
 * @param {string[]} files opened from Home's Open…
 */
export async function openFromHome(page, files) {
  const home = await homeFrame(page);
  await pickFiles(page, home.locator(".open:visible").first(), files);
}

/**
 * @param {Page} page
 * @returns {Promise<Record<string, any>[]>} the library's documents, as
 *   library.js keeps their records, the most recently opened first
 */
export function readLibrary(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open("pdflion");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction("documents").objectStore("documents").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return records.sort((a, b) => b.openedAt - a.openedAt);
  });
}

/**
 * @param {Page} page
 * @param {string} id a document's
 * @returns {Promise<Buffer>} its stored bytes
 */
export async function storedBytes(page, id) {
  const base64 = await page.evaluate(async (id) => {
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open("pdflion");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const blob = await new Promise((resolve, reject) => {
      const request = database.transaction("bytes").objectStore("bytes").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }, id);
  return Buffer.from(base64, "base64");
}

/**
 * @param {Page} page
 * @returns {Promise<{ id: string, name: string, home: boolean, edited: boolean, active: boolean }[]>}
 *   the strip's tabs, as the shell last drew them
 */
export function stripTabs(page) {
  return page.locator("#tabs .tab").evaluateAll((tabs) =>
    tabs.map((tab) => ({
      id: /** @type {HTMLElement} */ (tab).dataset.id ?? "",
      // Home shows its icon alone, and its name as its title.
      name: tab.getAttribute("title") ?? "",
      home: tab.classList.contains("home"),
      edited: tab.classList.contains("edited"),
      active: tab.classList.contains("active"),
    })),
  );
}

/**
 * @param {Page} page
 * @returns {Promise<string>} the modifier of the shortcuts here, as keys.js
 *   decides: `Meta` on Apple's devices, else `Control`
 */
export async function commandKey(page) {
  return (await page.evaluate(() => PDFLionKeys.commandKeyHere())) === "meta" ? "Meta" : "Control";
}

/**
 * Draws a stroke with Pencil across the left of the first page, away from
 * Pencil's option box, which pdf.js would take the lift of the mouse.
 *
 * @param {Page} page
 * @param {Frame} frame the document's
 * @param {number} [offset] how far down the page, as a share of the part of
 *   it in view
 */
export async function drawStroke(page, frame, offset = 0.3) {
  const pencil = frame.locator("#editorInkButton");
  if (!(await pencil.evaluate((button) => button.classList.contains("toggled")))) await pencil.click();
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (
    await frame.locator('.page[data-page-number="1"]').boundingBox()
  );
  const bottom = Math.min(box.y + box.height, /** @type {{ height: number }} */ (page.viewportSize()).height);
  const y = box.y + (bottom - box.y) * offset;
  await page.mouse.move(box.x + box.width * 0.1, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(box.x + box.width * (0.1 + 0.03 * step), y + step * 2);
  }
  await page.mouse.up();
}

/**
 * Has `navigator.share` record what it's given, or fail as cancelled, as
 * the share sheet does when it's closed.
 *
 * @param {Page} page
 * @param {"share" | "cancel"} answer
 */
export async function stubShare(page, answer) {
  await page.evaluate((answer) => {
    window.shared = [];
    window.sharedFiles = [];
    window.shareCalls = 0;
    navigator.canShare = () => true;
    navigator.share = async ({ files }) => {
      window.shareCalls++;
      if (answer === "cancel") throw new DOMException("Share canceled", "AbortError");
      for (const file of files) {
        window.shared.push({ name: file.name, size: file.size, type: file.type });
        window.sharedFiles.push(file);
      }
    };
  }, answer);
}

/**
 * @param {Page} page with `navigator.share` stubbed
 * @param {number} index
 * @returns {Promise<{ name: string, type: string, bytes: Buffer }>} the file
 *   shared at that place, once it has been
 */
export async function sharedFile(page, index) {
  await expect.poll(() => page.evaluate(() => window.sharedFiles.length)).toBeGreaterThan(index);
  const { name, type, base64 } = await page.evaluate(async (index) => {
    const file = window.sharedFiles[index];
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name: file.name, type: file.type, base64: btoa(text) };
  }, index);
  return { name, type, bytes: Buffer.from(base64, "base64") };
}
