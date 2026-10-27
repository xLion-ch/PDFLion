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
import { writeBrokenForm, writeForm, writeLabelled, writeSigned } from "./pdfs.js";

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

/**
 * @param {Page} page
 * @returns {Promise<string[]>} the text of each page, in the order the viewer
 *   shows them, with the page tools' changes
 */
const pageTexts = (page) =>
  page.evaluate(async () => {
    const { pdfDocument, pdfViewer } = PDFViewerApplication;
    const texts = [];
    for (let number = 1; number <= pdfViewer.pagesCount; number++) {
      const { items } = await (await pdfDocument.getPage(number)).getTextContent();
      texts.push(items.map((item) => /** @type {any} */ (item).str ?? "").join(""));
    }
    return texts;
  });

/**
 * @param {Page} page
 * @param {number} number
 * @returns {import("@playwright/test").Locator} the page's thumbnail
 */
const thumbnail = (page, number) =>
  page.locator(`#thumbnailsView > .thumbnail[page-number="${number}"]`);

/**
 * Opens the sidebar on the pages' thumbnails, where pdf.js's page tools are.
 *
 * @param {Page} page
 */
async function showThumbnails(page) {
  await page.locator("#viewsManagerToggleButton").click();
  await expect(page.locator("#thumbnailsView")).toBeVisible();
  const count = await page.evaluate(() => PDFViewerApplication.pagesCount);
  await expect(page.locator("#thumbnailsView > .thumbnail")).toHaveCount(count);
}

/**
 * Drags a page's thumbnail with the mouse, and drops it after another's.
 *
 * @param {Page} page
 * @param {number} from
 * @param {number} after
 */
async function dragThumbnail(page, from, after) {
  const start = await thumbnail(page, from).locator(".thumbnailImageContainer").boundingBox();
  const end = await thumbnail(page, after).locator(".thumbnailImageContainer").boundingBox();
  if (!start || !end) throw new Error("No thumbnail to drag");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  // pdf.js drops it after the thumbnail whose middle the dragged one's is below.
  await page.mouse.move(end.x + end.width / 2, end.y + end.height * 0.75, { steps: 20 });
  await page.mouse.up();
}

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

test("pages moved in the thumbnails are saved in their new order", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 3);
  let { app, page } = await pdflion([file]);
  await showThumbnails(page);

  await dragThumbnail(page, 1, 3);
  await expect.poll(() => pageTexts(page)).toEqual(["Page 2", "Page 3", "Page 1"]);
  await expect.poll(() => isEdited(app, page)).toBe(true);

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  // The tab shows the file as it's now saved.
  await expect.poll(() => pageTexts(page)).toEqual(["Page 2", "Page 3", "Page 1"]);
  expect(await pagesCount(page)).toBe(3);
  await expect(page).toHaveTitle("pages.pdf");
  await app.close();

  ({ app, page } = await pdflion([file]));
  expect(await pageTexts(page)).toEqual(["Page 2", "Page 3", "Page 1"]);
});

test("a page deleted in the thumbnails comes back with Undo", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 3);
  const { app, page } = await pdflion([file]);
  await showThumbnails(page);

  await thumbnail(page, 2).locator("input").check();
  await page.locator("#viewsManagerStatusActionButton").click();
  await page.locator("#viewsManagerStatusActionDelete").click();
  await expect.poll(() => pageTexts(page)).toEqual(["Page 1", "Page 3"]);
  await expect.poll(() => isEdited(app, page)).toBe(true);

  await page.locator("#viewsManagerStatusUndoButton").click();
  await expect.poll(() => pageTexts(page)).toEqual(["Page 1", "Page 2", "Page 3"]);
  // Undone, the document is as it was.
  await expect.poll(() => isEdited(app, page)).toBe(false);
});

test("Add file adds a file's pages after the current page", async ({ pdflion }) => {
  const dir = await tempDir();
  const file = path.join(dir, "pages.pdf");
  await writeLabelled(file, 3);
  const more = path.join(dir, "more.pdf");
  await writeLabelled(more, 2, "More");
  let { app, page } = await pdflion([file]);
  await showThumbnails(page);
  await page.evaluate(() => {
    PDFViewerApplication.page = 2;
  });

  await page.locator("#viewsManagerAddFilePicker").setInputFiles(more);
  const added = ["Page 1", "Page 2", "More 1", "More 2", "Page 3"];
  await expect.poll(() => pageTexts(page)).toEqual(added);
  expect(await pagesCount(page)).toBe(5);
  await expect.poll(() => currentPage(page)).toBe(3);
  await expect.poll(() => isEdited(app, page)).toBe(true);
  await expect(page).toHaveTitle("pages.pdf");
  // pdf.js selects the pages it added.
  await expect(page.locator("#thumbnailsView input:checked")).toHaveCount(2);

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  await app.close();

  ({ app, page } = await pdflion([file]));
  expect(await pageTexts(page)).toEqual(added);
});

test("a PDF dropped on the thumbnails adds its pages there", async ({ pdflion }) => {
  const dir = await tempDir();
  const file = path.join(dir, "pages.pdf");
  await writeLabelled(file, 2);
  const more = path.join(dir, "more.pdf");
  await writeLabelled(more, 1, "More");
  const { app, page } = await pdflion([file]);
  await showThumbnails(page);

  const bytes = [...(await fs.readFile(more))];
  /** Drops more.pdf, as a file without a path, below the middle of `target`. */
  const drop = (/** @type {string} */ target) =>
    page.evaluate(
      async ({ target, bytes }) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(
          new File([new Uint8Array(bytes)], "more.pdf", { type: "application/pdf" }),
        );
        const element = /** @type {Element} */ (document.querySelector(target));
        const { left, top, width, height } = element.getBoundingClientRect();
        const at = { clientX: left + width / 2, clientY: top + height * 0.75 };
        for (const type of ["dragenter", "dragover", "drop"]) {
          element.dispatchEvent(
            new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true, ...at }),
          );
        }
      },
      { target, bytes },
    );

  // On the document, PDFLion opens dropped PDFs as tabs, which needs their paths.
  await drop("#viewerContainer");
  await drop('#thumbnailsView > .thumbnail[page-number="1"] .thumbnailImageContainer');
  await expect.poll(() => pageTexts(page)).toEqual(["Page 1", "More 1", "Page 2"]);
  await expect(page).toHaveTitle("pages.pdf");
  await expect.poll(() => isEdited(app, page)).toBe(true);
});

test("a typed form value survives moving pages and saving", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "form.pdf");
  await writeForm(file, { pages: 2 });
  let { app, page } = await pdflion([file]);
  await page.locator(".annotationLayer input").fill("Ada Lovelace");
  await expect.poll(() => isEdited(app, page)).toBe(true);
  await showThumbnails(page);

  await dragThumbnail(page, 1, 2);
  await expect.poll(() => pageTexts(page)).toEqual(["Page 2", "Name:"]);
  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  await app.close();

  ({ app, page } = await pdflion([file]));
  expect(await pageTexts(page)).toEqual(["Page 2", "Name:"]);
  await page.evaluate(() => {
    PDFViewerApplication.page = 2;
  });
  await expect(page.locator(".annotationLayer input")).toHaveValue("Ada Lovelace");
});
