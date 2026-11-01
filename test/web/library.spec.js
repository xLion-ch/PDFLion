import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { writeLabelled } from "../e2e/pdfs.js";
import {
  TRACEMONKEY,
  commandKey,
  documentFrame,
  drawStroke,
  expect,
  homeFrame,
  openApp,
  openFromHome,
  pickFiles,
  readLibrary,
  storedBytes,
  stripTabs,
  stubShare,
  test,
} from "./pdflion.js";

/** The first save's explanation, which comes once ever. */
const EXPLANATION = /are saved in PDFLion\./;

test("a PDF from Files is kept, shows on Home, and opens the same document again", async ({
  page,
}) => {
  await openApp(page);
  await openFromHome(page, [TRACEMONKEY]);
  const viewer = await documentFrame(page, "compressed.tracemonkey-pldi-09.pdf");
  // It took Home's place.
  expect(await stripTabs(page)).toHaveLength(1);
  const [record] = await readLibrary(page);
  expect(record).toMatchObject({
    name: "compressed.tracemonkey-pldi-09.pdf",
    size: (await fs.stat(TRACEMONKEY)).size,
    revision: 0,
    exportedRevision: 0,
    source: "files",
  });

  // Home shows it, with its first page, and that it's open.
  await viewer.locator("#pdflionHomeButton").click();
  const home = await homeFrame(page);
  const card = home.locator(".card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".name")).toHaveText("compressed.tracemonkey-pldi-09.pdf");
  await expect(card.locator(".preview img")).toBeVisible();
  await expect(card.locator(".mark")).toHaveText(["Open"]);
  expect(await card.locator(".folder").textContent()).toMatch(/^\d+(\.\d)? [kM]B$/);

  // The same file again opens the document it is.
  await openFromHome(page, [TRACEMONKEY]);
  await expect.poll(async () => (await stripTabs(page)).find((tab) => tab.active)?.home).toBe(false);
  expect(await readLibrary(page)).toHaveLength(1);
});

test("New makes Untitled.pdf, which goes again if it's closed unchanged", async ({ page }) => {
  const home = await openApp(page);
  await home.locator("#empty .new").click();
  await documentFrame(page, "Untitled.pdf");
  expect(await readLibrary(page)).toMatchObject([
    { name: "Untitled.pdf", source: "new", revision: 0, exportedRevision: -1 },
  ]);
  // It was never in Files.
  const viewer = await documentFrame(page, "Untitled.pdf");
  await expect(viewer.locator("#pdflionSaveStatus")).toHaveText("Only in PDFLion");

  await page.keyboard.press(`${await commandKey(page)}+w`);
  await homeFrame(page);
  await expect.poll(() => readLibrary(page)).toEqual([]);
});

test("Home's menu renames and deletes a document", async ({ page }) => {
  await openApp(page);
  await openFromHome(page, [TRACEMONKEY]);
  const viewer = await documentFrame(page, "compressed.tracemonkey-pldi-09.pdf");
  await viewer.locator("#pdflionHomeButton").click();
  const home = await homeFrame(page);

  await home.locator(".card").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const field = page.locator("dialog .field");
  await expect(field).toHaveValue("compressed.tracemonkey-pldi-09.pdf");
  await field.fill("Tracing");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(home.locator(".card .name")).toHaveText("Tracing.pdf");
  expect((await readLibrary(page))[0].name).toBe("Tracing.pdf");
  // The open tab takes the name too.
  await expect.poll(async () => (await stripTabs(page)).map((tab) => tab.name)).toContain("Tracing.pdf");

  await home.locator(".card").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await expect(page.locator("dialog .message")).toHaveText("Delete “Tracing.pdf” from PDFLion?");
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(home.locator("#empty")).toBeVisible();
  expect(await readLibrary(page)).toEqual([]);
  // Its tab went with it.
  expect((await stripTabs(page)).map((tab) => tab.home)).toEqual([true]);
});

test("a drawing saves by itself, and the first save says what that means", async ({ page }) => {
  await openApp(page);
  await openFromHome(page, [TRACEMONKEY]);
  const viewer = await documentFrame(page, "compressed.tracemonkey-pldi-09.pdf");
  await expect(viewer.locator("#pdflionSaveStatus")).toBeHidden();

  await drawStroke(page, viewer);
  // About 2 s after the change.
  await expect.poll(async () => (await readLibrary(page))[0].revision, { timeout: 10_000 }).toBe(1);
  await expect(page.locator("dialog .message")).toHaveText(EXPLANATION);
  await page.getByRole("button", { name: "OK" }).click();
  await expect(viewer.locator("#pdflionSaveStatus")).toHaveText("Not in Files");
  const [record] = await readLibrary(page);
  const bytes = await storedBytes(page, record.id);
  expect(bytes.subarray(-2048).toString("latin1")).toMatch(/\/Subtype \/Ink/);

  // A stroke more is saved at once when the page is hidden, as when the app
  // is left, and the explanation doesn't come again.
  await drawStroke(page, viewer, 0.5);
  await viewer.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () => (await readLibrary(page))[0].revision, { timeout: 1500 }).toBe(2);
  await expect(page.locator("dialog")).toHaveCount(0);

  // Home marks it.
  await viewer.locator("#pdflionHomeButton").click();
  const home = await homeFrame(page);
  await expect(home.locator(".card .mark.status")).toHaveText("Not in Files");
});

test("after the explanation, each document's first save says so once a session", async ({
  page,
  dir,
}) => {
  const other = path.join(dir, "Other.pdf");
  await writeLabelled(other, 1);
  await openApp(page);
  await openFromHome(page, [TRACEMONKEY]);
  const first = await documentFrame(page, "compressed.tracemonkey-pldi-09.pdf");
  await drawStroke(page, first);
  await expect(page.locator("dialog .message")).toHaveText(EXPLANATION, { timeout: 10_000 });
  await page.getByRole("button", { name: "OK" }).click();

  // Open… in the viewer's ⋮ menu.
  await first.locator("#secondaryToolbarToggleButton").click();
  await pickFiles(page, first.locator("#pdflionSecondaryOpen"), [other]);
  const second = await documentFrame(page, "Other.pdf");
  await drawStroke(page, second);
  const snackbar = page.locator(".snackbar");
  await expect(snackbar.locator(".text")).toHaveText(
    "Saved in PDFLion. The file in Files hasn’t changed.",
    { timeout: 10_000 },
  );
  await expect(snackbar.locator(".action")).toHaveText("Share…");
  await snackbar.evaluate((element) => element.setAttribute("data-seen", ""));

  // Its next save says nothing.
  await drawStroke(page, second, 0.6);
  await expect.poll(async () => (await readLibrary(page))[0].revision, { timeout: 10_000 }).toBe(2);
  await expect(page.locator(".snackbar:not([data-seen])")).toHaveCount(0);
  await expect(page.locator("dialog")).toHaveCount(0);
});

test("Share hands over the stored document, after which it's in Files", async ({ page }) => {
  await openApp(page);
  await openFromHome(page, [TRACEMONKEY]);
  const viewer = await documentFrame(page, "compressed.tracemonkey-pldi-09.pdf");
  await drawStroke(page, viewer);
  await expect(page.locator("dialog .message")).toHaveText(EXPLANATION, { timeout: 10_000 });
  await page.getByRole("button", { name: "OK" }).click();
  const status = viewer.locator("#pdflionSaveStatus");
  await expect(status).toBeVisible();

  // Closing the share sheet changes nothing.
  await stubShare(page, "cancel");
  await viewer.locator("#pdflionShareButton").click();
  await expect.poll(() => page.evaluate(() => window.shareCalls)).toBe(1);
  await expect(status).toBeVisible();

  await stubShare(page, "share");
  await viewer.locator("#pdflionShareButton").click();
  await expect.poll(() => page.evaluate(() => window.shared)).toEqual([
    {
      name: "compressed.tracemonkey-pldi-09.pdf",
      size: (await readLibrary(page))[0].size,
      type: "application/pdf",
    },
  ]);
  await expect(status).toBeHidden();
  const [record] = await readLibrary(page);
  expect(record.exportedRevision).toBe(record.revision);
});

test("a page change that drops XMP asks first, and saves once the tab is left", async ({
  page,
  dir,
}) => {
  const file = path.join(dir, "Labelled.pdf");
  await writeLabelled(file, 3, "Page", { xmp: true });
  await openApp(page);
  await openFromHome(page, [file]);
  const viewer = await documentFrame(page, "Labelled.pdf");

  // The second page, deleted from the sidebar's Manage menu.
  await viewer.locator("#viewsManagerToggleButton").click();
  const checkbox = viewer.locator('#thumbnailsView .thumbnail[page-number="2"] > input');
  await checkbox.check();
  await viewer.locator("#viewsManagerStatusActionButton").click();
  await viewer.locator("#viewsManagerStatusActionDelete").click();
  await expect(page.locator("dialog .message")).toHaveText("Saving removes some information from “Labelled.pdf”.");
  await expect(page.locator("dialog .detail")).toHaveText(/its XMP metadata/);
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => viewer.evaluate(() => window.PDFViewerApplication.pdfViewer.pagesCount)).toBe(2);
  // Not yet: pdf.js offers to undo it.
  expect((await readLibrary(page))[0].revision).toBe(0);

  await page.keyboard.press(`${await commandKey(page)}+Shift+h`);
  await expect.poll(async () => (await readLibrary(page))[0].revision, { timeout: 10_000 }).toBe(1);
  const [record] = await readLibrary(page);
  const saved = await PDFDocument.load(await storedBytes(page, record.id));
  expect(saved.getPageCount()).toBe(2);
});
