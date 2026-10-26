/**
 * Runs the real app from this checkout for the end-to-end tests. Each launch
 * gets its own userData folder, so tests never touch the user's window
 * placement or recent documents, and on Windows and Linux never hand their
 * files to a PDFLion that's already running.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, _electron as electron } from "@playwright/test";

export { expect } from "@playwright/test";

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
 * Starts PDFLion with `files` on its command line and waits until the first
 * window shows the first page.
 *
 * @param {string[]} files
 * @param {{ userData?: string }} [options] userData: reuse a folder
 * @returns {Promise<{ app: ElectronApplication, page: Page, userData: string }>}
 */
export async function launch(files, { userData } = {}) {
  userData ??= await tempDir();
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${userData}`, ...files],
    cwd: ROOT,
  });
  const page = await app.firstWindow();
  await rendered(page);
  return { app, page, userData };
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
