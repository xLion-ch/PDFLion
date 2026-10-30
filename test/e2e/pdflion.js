/**
 * Runs the real app from this checkout for the end-to-end tests. Each launch
 * gets its own userData folder, so tests never touch the user's window
 * placement or recent documents, and on Windows and Linux never hand their
 * files to a PDFLion that's already running.
 *
 * Playwright lists each tab's viewer and each window's tab strip as pages.
 * app.browserWindow() gives the window either is in. The helpers below find a
 * document's page by its URL, which names its file.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, _electron as electron, expect } from "@playwright/test";

export { expect };

/** @typedef {import("@playwright/test").ElectronApplication} ElectronApplication */
/** @typedef {import("@playwright/test").Page} Page */

/**
 * Playwright's test, with a `pdflion` fixture: launch() for the test, and
 * after it, quit every app it started. Unsaved changes are discarded rather
 * than prompted for.
 */
export const test = base.extend({
  // Playwright reads the fixtures this one needs from the pattern: none.
  pdflion: async ({}, use) => {
    /** @type {ElectronApplication[]} */
    const apps = [];
    await use(
      /** @type {typeof launch} */
      async (files, options) => {
        const launched = await launch(files, options);
        apps.push(launched.app);
        return launched;
      },
    );
    for (const app of apps) {
      await answerMessages(app, "Don’t Save").catch(() => {});
      await app.close().catch(() => {}); // it may have quit already
    }
  },
});

export const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/** The 14-page paper that ships with the pdf.js build. */
const TRACEMONKEY = path.join(
  ROOT,
  "vendor/pdf.js/build/generic/web/compressed.tracemonkey-pldi-09.pdf",
);

/** `RenderingStates.FINISHED` in pdf.js's web/renderable_view.js. */
const RENDERING_FINISHED = 3;

/**
 * The size of the first window's content in every launch. Tests then see the
 * same window on every machine, and it fits the smallest screen CI has: 1024
 * × 768 on Windows, where a new window's default size doesn't fit.
 */
export const WINDOW_SIZE = { width: 1000, height: 640 };

/** @returns {Promise<string>} a new temporary folder, with its real path */
export async function tempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdflion-e2e-")));
}

/**
 * @param {string} dir
 * @param {string} [name]
 * @returns {Promise<string>} a copy of the tracemonkey paper in `dir`
 */
export async function tracemonkey(dir, name = "tracemonkey.pdf") {
  const file = path.join(dir, name);
  await fs.copyFile(TRACEMONKEY, file);
  return file;
}

/**
 * Starts PDFLion with `files` on its command line, sizes the window to
 * WINDOW_SIZE, and waits until the first of them shows its first page.
 *
 * @param {string[]} files
 * @param {{ userData?: string, lang?: string, args?: string[], env?: Record<string, string> }} [options]
 *   userData: reuse a folder. lang: the language, such as `de`, for pdf.js's
 *   labels, rather than the system's. args: more switches. env: variables to
 *   set besides this process's
 * @returns {Promise<{ app: ElectronApplication, page: Page, userData: string }>}
 */
export async function launch(files, { userData, lang, args = [], env = {} } = {}) {
  userData ??= await tempDir();
  const app = await electron.launch({
    args: [
      ROOT,
      `--user-data-dir=${userData}`,
      ...(lang ? [`--lang=${lang}`] : []),
      ...args,
      ...files,
    ],
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
  const page = await documentPage(app, path.basename(files[0]));
  await setSize(app, page, WINDOW_SIZE);
  await rendered(page);
  return { app, page, userData };
}

/**
 * @param {string} url
 * @returns {boolean} whether `url` is a tab's viewer
 */
export function isViewer(url) {
  return url.startsWith("pdflion://app/viewer/web/viewer.html");
}

/**
 * @param {string} url
 * @returns {boolean} whether `url` is a window's tab strip
 */
export function isStrip(url) {
  return url.startsWith("pdflion://app/tabs/tabs.html");
}

/**
 * The viewer page of the tab that opened the file named `name`, once there
 * is one. Save As doesn't change the page's URL.
 *
 * @param {ElectronApplication} app
 * @param {string} name e.g. "tracemonkey.pdf"
 * @returns {Promise<Page>}
 */
export async function documentPage(app, name) {
  /** @param {Page} page */
  const matches = (page) => {
    if (!isViewer(page.url())) return false;
    const file = new URL(page.url()).searchParams.get("file") ?? "";
    return decodeURIComponent(file.split("/").pop() ?? "") === name;
  };
  return app.windows().find(matches) ?? app.waitForEvent("window", { predicate: matches });
}

/**
 * @param {ElectronApplication} app
 * @returns {Page[]} the open tabs' viewer pages
 */
export function documentPages(app) {
  return app.windows().filter((page) => isViewer(page.url()));
}

/**
 * @param {ElectronApplication} app
 * @returns {Promise<number>} how many windows are open
 */
export function windowCount(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/**
 * @param {ElectronApplication} app
 * @param {Page} page a tab's viewer
 * @returns {Promise<Page>} the tab strip of the window the tab is in, once
 *   Playwright knows it: a new window's strip may still be loading
 */
export async function stripOf(app, page) {
  const id = await (await app.browserWindow(page)).evaluate((win) => win.id);
  const deadline = Date.now() + 10_000;
  do {
    for (const other of app.windows()) {
      if (!isStrip(other.url())) continue;
      if ((await (await app.browserWindow(other)).evaluate((win) => win.id)) === id) return other;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`No tab strip for ${page.url()}`);
}

/**
 * @param {Page} strip
 * @returns {Promise<{ id: string, name: string, active: boolean, edited: boolean, label: string }[]>}
 *   the tabs the strip shows, left to right
 */
export function stripTabs(strip) {
  return strip.evaluate(() =>
    [...document.querySelectorAll(".tab")].map((tab) => ({
      id: /** @type {HTMLElement} */ (tab).dataset.id ?? "",
      name: tab.querySelector(".name")?.textContent ?? "",
      active: tab.getAttribute("aria-selected") === "true",
      edited: tab.classList.contains("edited"),
      label: tab.getAttribute("aria-label") ?? "",
    })),
  );
}

/**
 * Runs `code` in a tab's page from main. page.evaluate() would count as a user
 * gesture, which hides what needs user activation.
 *
 * @param {ElectronApplication} app
 * @param {Page} page a tab's viewer
 * @param {string} code
 * @returns {Promise<unknown>}
 */
export function readFromMain(app, page, code) {
  return app.evaluate(
    ({ webContents }, { url, code }) => {
      const withoutHash = (/** @type {string} */ href) => href.split("#")[0];
      const contents = webContents
        .getAllWebContents()
        .find((other) => withoutHash(other.getURL()) === withoutHash(url));
      if (!contents) throw new Error(`No page at ${url}`);
      return contents.executeJavaScript(code);
    },
    { url: page.url(), code },
  );
}

/**
 * @param {ElectronApplication} app
 * @param {Page} page
 * @returns {Promise<string>} the title of the window `page` is in
 */
export async function windowTitle(app, page) {
  return (await app.browserWindow(page)).evaluate((win) => win.getTitle());
}

/**
 * Opens a file while PDFLion runs, as Finder does on macOS, and a second
 * process on Windows and Linux.
 *
 * @param {ElectronApplication} app
 * @param {string} file
 */
export async function openFile(app, file) {
  await app.evaluate(({ app }, file) => {
    if (process.platform === "darwin") app.emit("open-file", { preventDefault() {} }, file);
    else app.emit("second-instance", {}, [], "", { files: [file] });
  }, file);
}

/** @param {Page} page */
export async function rendered(page) {
  await page.waitForFunction(
    (finished) =>
      window.PDFViewerApplication?.pdfViewer?.getPageView(0)?.renderingState === finished,
    RENDERING_FINISHED,
  );
}

/**
 * Sets the size of a page's window, as far as its minimum width and the
 * screen let it, and waits until the page has laid itself out at that size.
 *
 * @param {ElectronApplication} app
 * @param {Page} page a tab's viewer
 * @param {{ width: number, height: number }} size of the window's content, in pixels
 * @returns {Promise<{ width: number, height: number }>} the size it got
 */
export async function setSize(app, page, { width, height }) {
  const win = await app.browserWindow(page);
  await win.evaluate((win, [width, height]) => win.setContentSize(width, height), [width, height]);
  // The window may take a moment to resize, and the tab's view, the page's
  // own size, follows it.
  const layout = () =>
    win.evaluate((win, url) => {
      const [width, height] = win.getContentSize();
      const tab = win.contentView.children.find(
        (child) =>
          /** @type {Electron.WebContentsView} */ (child).webContents?.getURL().split("#")[0] ===
          url.split("#")[0],
      );
      return { content: { width, height }, view: tab?.getBounds() };
    }, page.url());
  await expect
    .poll(async () => {
      const { content, view } = await layout();
      return view?.width === content.width && view.y + view.height === content.height;
    }, { message: "the tab's view fills the window" })
    .toBe(true);
  const { content: got, view } = await layout();
  await page.waitForFunction(
    ({ width, height }) => innerWidth === width && innerHeight === height,
    /** @type {Electron.Rectangle} */ (view),
  );
  // ResizeObservers, such as the toolbar's, run in the frame after a resize.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return got;
}

/**
 * Sets the width of a page's window, as setSize() does.
 *
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {number} width of the window's content, in pixels
 * @returns {Promise<number>} the width it got
 */
export async function setWidth(app, page, width) {
  const win = await app.browserWindow(page);
  const height = await win.evaluate((win) => win.getContentSize()[1]);
  return (await setSize(app, page, { width, height })).width;
}

/**
 * Clicks a menu item for a window, as the user would with the window focused.
 *
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {string} id an item id from src/main/menu.js, such as "zoomIn"
 */
export async function clickMenu(app, page, id) {
  const win = await app.browserWindow(page);
  await app.evaluate(
    ({ Menu }, { win, id }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      if (!item) throw new Error(`No menu item ${id}`);
      item.click(undefined, win, win.webContents);
    },
    { win, id },
  );
}

/**
 * @param {ElectronApplication} app
 * @param {Page} page
 * @returns {Promise<boolean>} whether the window shows unsaved changes: the
 *   dot in the close button on macOS, a "*" before the title on Windows and
 *   Linux
 */
export async function isEdited(app, page) {
  const win = await app.browserWindow(page);
  return win.evaluate((win) =>
    process.platform === "darwin" ? win.isDocumentEdited() : win.getTitle().startsWith("*"),
  );
}

/**
 * Replaces Electron's message boxes with one that answers with `button`, and
 * records each message on `globalThis.messages` in main.
 *
 * @param {ElectronApplication} app
 * @param {string} button e.g. "Cancel" or "Don’t Save"
 */
export async function answerMessages(app, button) {
  await app.evaluate(({ dialog }, button) => {
    const messages = (globalThis.messages ??= []);
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      messages.push(options.message);
      return { response: options.buttons.indexOf(button), checkboxChecked: false };
    };
  }, button);
}
