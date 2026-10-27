import fs from "node:fs/promises";
import path from "node:path";
import {
  answerMessages,
  clickMenu,
  documentPage,
  documentPages,
  expect,
  isEdited,
  openFile,
  rendered,
  stripOf,
  stripTabs,
  tempDir,
  test,
  tracemonkey,
  windowCount,
  windowTitle,
} from "./pdflion.js";
import { writeForm } from "./pdfs.js";

/** @returns {Promise<string>} a new, empty one-field form */
async function newForm() {
  const file = path.join(await tempDir(), "form.pdf");
  await writeForm(file);
  return file;
}

test("saves form data into the file, and the edited marker follows", async ({ pdflion }) => {
  const file = await newForm();
  let { app, page } = await pdflion([file]);

  expect(await isEdited(app, page)).toBe(false);
  await page.locator(".annotationLayer input").fill("Ada Lovelace");
  await expect.poll(() => isEdited(app, page)).toBe(true);

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  await app.close();

  ({ app, page } = await pdflion([file]));
  await expect(page.locator(".annotationLayer input")).toHaveValue("Ada Lovelace");
  expect(await isEdited(app, page)).toBe(false);
});

test("Save As writes the document to the chosen file and shows its name", async ({ pdflion }) => {
  const dir = await tempDir();
  const file = await tracemonkey(dir);
  const copy = path.join(dir, "copy.pdf");
  const { app, page } = await pdflion([file]);
  await app.evaluate(({ dialog }, copy) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: copy });
  }, copy);

  await clickMenu(app, page, "saveAs");
  await expect(page).toHaveTitle("copy.pdf");
  expect(await fs.readFile(copy)).toEqual(await fs.readFile(file));
  if (process.platform === "darwin") {
    const win = await app.browserWindow(page);
    expect(await win.evaluate((win) => win.getRepresentedFilename())).toBe(copy);
  }
});

test("asks before closing an edited window", async ({ pdflion }) => {
  const { app, page } = await pdflion([await newForm()]);
  await page.locator(".annotationLayer input").fill("changed");
  await expect.poll(() => isEdited(app, page)).toBe(true);
  const win = await app.browserWindow(page);
  const messages = () => app.evaluate(() => globalThis.messages);

  await answerMessages(app, "Cancel");
  await win.evaluate((win) => win.close());
  await expect
    .poll(messages)
    .toEqual(["Do you want to save the changes made to the document “form.pdf”?"]);
  expect(page.isClosed()).toBe(false);

  await answerMessages(app, "Don’t Save");
  const closed = page.waitForEvent("close");
  await win.evaluate((win) => win.close());
  await closed;
});

test("asks before quitting with an edited window", async ({ pdflion }) => {
  const { app, page } = await pdflion([await newForm()]);
  await page.locator(".annotationLayer input").fill("changed");
  await expect.poll(() => isEdited(app, page)).toBe(true);

  await answerMessages(app, "Cancel");
  await app.evaluate(({ app }) => app.quit());
  await expect.poll(() => app.evaluate(() => globalThis.messages.length)).toBe(1);
  expect(page.isClosed()).toBe(false);

  await answerMessages(app, "Don’t Save");
  const quit = app.waitForEvent("close");
  await app.evaluate(({ app }) => app.quit()).catch(() => {}); // it may be gone before answering
  await quit;
});

/**
 * @param {import("./pdflion.js").ElectronApplication} app
 * @param {string} code what app.getLocaleCountryCode() answers from now on
 */
async function setCountry(app, code) {
  await app.evaluate(({ app }, code) => {
    app.getLocaleCountryCode = () => code;
  }, code);
}

/**
 * @param {import("./pdflion.js").Page} page
 * @returns {Promise<number[]>} the first page's size, as [x, y, width, height]
 */
function pageView(page) {
  return page.evaluate(async () => (await PDFViewerApplication.pdfDocument.getPage(1)).view);
}

test("New opens an untitled blank page, Letter or A4 by region", async ({ pdflion }) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  const strip = await stripOf(app, page);

  await setCountry(app, "US");
  await clickMenu(app, page, "newDocument");
  const letter = await documentPage(app, "Untitled.pdf");
  await rendered(letter);
  expect(await letter.evaluate(() => PDFViewerApplication.pagesCount)).toBe(1);
  expect(await pageView(letter)).toEqual([0, 0, 612, 792]);
  expect(await windowTitle(app, letter)).toBe("Untitled.pdf");
  expect(await stripTabs(strip)).toMatchObject([
    { name: "tracemonkey.pdf", active: false, edited: false },
    { name: "Untitled.pdf", active: true, edited: false },
  ]);

  await setCountry(app, "CH");
  await clickMenu(app, page, "newDocument");
  const a4 = await documentPage(app, "Untitled 2.pdf");
  await rendered(a4);
  expect(await pageView(a4)).toEqual([0, 0, 595.28, 841.89]);
  expect(await windowCount(app)).toBe(1);

  // An untouched new document closes without asking.
  await answerMessages(app, "Cancel");
  const closed = a4.waitForEvent("close");
  await clickMenu(app, a4, "closeTab");
  await closed;
  expect(await app.evaluate(() => /** @type {any} */ (globalThis).messages)).toEqual([]);

  // The lowest free number comes back.
  await clickMenu(app, page, "newDocument");
  await rendered(await documentPage(app, "Untitled 2.pdf"));
});

test("Save on an unchanged new document asks where, and then it's that file", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const file = path.join(dir, "saved.pdf");
  const { app, page } = await pdflion([await tracemonkey(dir)]);
  await app.evaluate(({ app, dialog }, file) => {
    const globals = /** @type {any} */ (globalThis);
    globals.saveDialogs = [];
    dialog.showSaveDialog = async (_win, options) => {
      globals.saveDialogs.push(options.defaultPath);
      return { canceled: false, filePath: file };
    };
    // macOS and Windows hand recent documents to the system.
    globals.recent = [];
    if (process.platform !== "linux") app.addRecentDocument = (path) => globals.recent.push(path);
  }, file);
  const saveDialogs = () => app.evaluate(() => /** @type {any} */ (globalThis).saveDialogs);

  await clickMenu(app, page, "newDocument");
  const untitled = await documentPage(app, "Untitled.pdf");
  await rendered(untitled);
  expect(await isEdited(app, untitled)).toBe(false);
  await clickMenu(app, untitled, "save");
  await expect(untitled).toHaveTitle("saved.pdf");
  const documents = await app.evaluate(({ app }) => app.getPath("documents"));
  expect(await saveDialogs()).toEqual([path.join(documents, "Untitled.pdf")]);

  const saved = await fs.readFile(file, "latin1");
  expect(saved.startsWith("%PDF-")).toBe(true);
  expect(saved).toMatch(/\/MediaBox \[0 0 [\d.]+ [\d.]+\]/);
  expect(await windowTitle(app, untitled)).toBe("saved.pdf");
  expect((await stripTabs(await stripOf(app, untitled))).map(({ name }) => name)).toEqual([
    "tracemonkey.pdf",
    "saved.pdf",
  ]);
  if (process.platform === "darwin") {
    const win = await app.browserWindow(untitled);
    expect(await win.evaluate((win) => win.getRepresentedFilename())).toBe(file);
  }
  if (process.platform !== "linux") {
    expect(await app.evaluate(() => /** @type {any} */ (globalThis).recent)).toContain(file);
  }
  if (process.platform !== "darwin") {
    // File > Open Recent, from PDFLion's own list.
    const recent = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((item) => item.label === "&File")
        ?.submenu?.items.find((item) => item.label === "Open &Recent")
        ?.submenu?.items.map((item) => item.label),
    );
    expect(recent).toContain("&1 saved.pdf");
  }

  // It's an ordinary document now: Save doesn't ask, and opening the file
  // selects its tab.
  await clickMenu(app, untitled, "save");
  await clickMenu(app, page, "nextTab");
  await openFile(app, file);
  await expect.poll(() => windowTitle(app, untitled)).toBe("saved.pdf");
  expect(documentPages(app)).toHaveLength(2);
  expect(await saveDialogs()).toHaveLength(1);
});

test("New works on macOS without a window", async ({ pdflion }) => {
  test.skip(process.platform !== "darwin", "Windows and Linux quit with their last window");
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  const closed = page.waitForEvent("close");
  await clickMenu(app, page, "closeWindow");
  await closed;
  expect(await windowCount(app)).toBe(0);

  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("newDocument")?.click());
  await rendered(await documentPage(app, "Untitled.pdf"));
  expect(await windowCount(app)).toBe(1);
});

test("the save prompt's Save on a new document asks where to save it", async ({ pdflion }) => {
  const dir = await tempDir();
  const file = path.join(dir, "kept.pdf");
  const { app, page } = await pdflion([await tracemonkey(dir)]);
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
  await clickMenu(app, page, "newDocument");
  const untitled = await documentPage(app, "Untitled.pdf");
  await rendered(untitled);
  // A blank page has no form field to type into, so report a change as the
  // viewer's preload would.
  await app.evaluate(({ ipcMain, webContents }, url) => {
    const sender = webContents.getAllWebContents().find((other) => other.getURL() === url);
    if (!sender) throw new Error(`No page at ${url}`);
    ipcMain.emit("pdflion:set-edited", { sender, senderFrame: sender.mainFrame }, true);
  }, untitled.url());
  await expect.poll(async () => (await stripTabs(await stripOf(app, page)))[1].edited).toBe(true);

  await answerMessages(app, "Save");
  const closed = untitled.waitForEvent("close");
  await clickMenu(app, untitled, "closeTab");
  await closed;
  expect(await app.evaluate(() => /** @type {any} */ (globalThis).messages)).toEqual([
    "Do you want to save the changes made to the document “Untitled.pdf”?",
  ]);
  expect((await fs.readFile(file, "latin1")).startsWith("%PDF-")).toBe(true);
});
