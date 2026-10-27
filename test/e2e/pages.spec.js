import fs from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  answerMessages,
  clickMenu,
  documentPage,
  expect,
  isEdited,
  rendered,
  stripOf,
  stripTabs,
  tempDir,
  test,
  tracemonkey,
} from "./pdflion.js";
import { writeBrokenForm, writeForm, writeSigned } from "./pdfs.js";

/** @typedef {import("./pdflion.js").ElectronApplication} ElectronApplication */
/** @typedef {import("./pdflion.js").Page} Page */

/** @param {Page} page */
const pagesCount = (page) => page.evaluate(() => PDFViewerApplication.pagesCount);

/** @param {Page} page */
const currentPage = (page) => page.evaluate(() => PDFViewerApplication.page);

/**
 * @param {Page} page
 * @param {number} number
 * @returns {Promise<number[]>} the page's view, as [x, y, width, height]
 */
const pageView = (page, number) =>
  page.evaluate(async (number) => (await PDFViewerApplication.pdfDocument.getPage(number)).view, number);

/**
 * @param {ElectronApplication} app
 * @returns {Promise<string[]>} the messages answerMessages() has answered
 */
const messages = (app) => app.evaluate(() => /** @type {any} */ (globalThis).messages ?? []);

test("Insert Blank Page adds a page after the current one, and Save appends it", async ({
  pdflion,
}) => {
  const file = await tracemonkey(await tempDir());
  const original = await fs.readFile(file);
  const { app, page } = await pdflion([file]);
  await page.evaluate(() => {
    PDFViewerApplication.page = 3;
  });

  await clickMenu(app, page, "insertBlankPage");
  await expect.poll(() => pagesCount(page)).toBe(15);
  await expect.poll(() => currentPage(page)).toBe(4);
  expect(await pageView(page, 4)).toEqual(await pageView(page, 3));
  await expect.poll(() => isEdited(app, page)).toBe(true);
  await expect(page).toHaveTitle("tracemonkey.pdf");

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  const saved = await fs.readFile(file);
  expect(saved.length).toBeGreaterThan(original.length);
  // An incremental update: the file as it was, then the new page.
  expect(saved.subarray(0, original.length).equals(original)).toBe(true);
  await app.close();

  const { page: reopened } = await pdflion([file]);
  expect(await pagesCount(reopened)).toBe(15);
});

test("a typed form value survives inserting a page and saving", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "form.pdf");
  await writeForm(file);
  let { app, page } = await pdflion([file]);
  await page.locator(".annotationLayer input").fill("Ada Lovelace");
  await expect.poll(() => isEdited(app, page)).toBe(true);

  await clickMenu(app, page, "insertBlankPage");
  await expect.poll(() => pagesCount(page)).toBe(2);
  await page.evaluate(() => {
    PDFViewerApplication.page = 1;
  });
  await expect(page.locator(".annotationLayer input")).toHaveValue("Ada Lovelace");
  expect(await isEdited(app, page)).toBe(true);

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  await app.close();

  ({ app, page } = await pdflion([file]));
  expect(await pagesCount(page)).toBe(2);
  await expect(page.locator(".annotationLayer input")).toHaveValue("Ada Lovelace");
});

test("the toolbar button inserts a page too", async ({ pdflion }) => {
  const { page } = await pdflion([await tracemonkey(await tempDir())]);
  const button = page.locator("#pdflionInsertBlankPage");
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => pagesCount(page)).toBe(15);
  await expect(button).toBeEnabled();
});

test("a document with a password keeps its pages, and says why", async ({ pdflion }) => {
  // Encrypted with an owner password only, so it opens without asking.
  const file = path.join(await tempDir(), "protected.pdf");
  await fs.copyFile(path.join(ROOT, "vendor/pdf.js/test/pdfs/empty_protected.pdf"), file);
  const { app, page } = await pdflion([file]);
  await answerMessages(app, "OK");

  await clickMenu(app, page, "insertBlankPage");
  await expect
    .poll(() => messages(app))
    .toEqual(["The pages of the document “protected.pdf” can’t be changed."]);
  expect(await pagesCount(page)).toBe(1);
  expect(await isEdited(app, page)).toBe(false);
  await expect(page.locator("#pdflionInsertBlankPage")).toBeDisabled();
});

test("a signed document asks before its first page change only", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "signed.pdf");
  await writeSigned(file);
  const { app, page } = await pdflion([file]);
  const ask = "Changing pages invalidates the signatures in “signed.pdf”.";

  await answerMessages(app, "Cancel");
  await clickMenu(app, page, "insertBlankPage");
  await expect.poll(() => messages(app)).toEqual([ask]);
  expect(await pagesCount(page)).toBe(1);

  await answerMessages(app, "Change Pages");
  await clickMenu(app, page, "insertBlankPage");
  await expect.poll(() => pagesCount(page)).toBe(2);
  await clickMenu(app, page, "insertBlankPage");
  await expect.poll(() => pagesCount(page)).toBe(3);
  expect(await messages(app)).toEqual([ask, ask]);
});

test("a document the library can't read stays as it was, and says so", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "broken.pdf");
  await writeBrokenForm(file);
  const { app, page } = await pdflion([file]);
  await answerMessages(app, "OK");

  await clickMenu(app, page, "insertBlankPage");
  await expect
    .poll(() => messages(app))
    .toEqual(["The pages of the document “broken.pdf” couldn’t be changed."]);
  expect(await pagesCount(page)).toBe(1);
  expect(await isEdited(app, page)).toBe(false);
});

test("a new document with an inserted page asks about saving when it closes", async ({
  pdflion,
}) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  await clickMenu(app, page, "newDocument");
  const untitled = await documentPage(app, "Untitled.pdf");
  await rendered(untitled);

  await clickMenu(app, untitled, "insertBlankPage");
  await expect.poll(() => pagesCount(untitled)).toBe(2);
  const strip = await stripOf(app, page);
  await expect.poll(async () => (await stripTabs(strip))[1]).toMatchObject({
    name: "Untitled.pdf",
    edited: true,
  });

  await answerMessages(app, "Don’t Save");
  const closed = untitled.waitForEvent("close");
  await clickMenu(app, untitled, "closeTab");
  await closed;
  expect(await messages(app)).toEqual([
    "Do you want to save the changes made to the document “Untitled.pdf”?",
  ]);
});
