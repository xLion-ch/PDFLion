import path from "node:path";
import { writeLabelled } from "../e2e/pdfs.js";
import {
  TRACEMONKEY,
  documentFrame,
  drawStroke,
  expect,
  homeFrame,
  loadedDocuments,
  openApp,
  openAppExplained,
  openFromHome,
  readLibrary,
  readSession,
  stripTabs,
  test,
} from "./pdflion.js";

const PAPER = "compressed.tracemonkey-pldi-09.pdf";

test("after a reload, the tabs come back in order with the active one, where each document was", async ({
  page,
  dir,
}) => {
  const other = path.join(dir, "Other.pdf");
  await writeLabelled(other, 2);
  await openApp(page);
  await openFromHome(page, [TRACEMONKEY, other]);
  await documentFrame(page, "Other.pdf");
  await page.locator("#tabs .tab").first().click();
  const viewer = await documentFrame(page, PAPER);
  await viewer.evaluate(() => {
    window.PDFViewerApplication.pdfViewer.currentScaleValue = "1.5";
    window.PDFViewerApplication.page = 5;
  });
  // Home, after the paper, which then shows again.
  await viewer.locator("#pdflionHomeButton").click();
  await homeFrame(page);
  await page.locator("#tabs .tab").first().click();
  await expect
    .poll(async () => {
      const session = await readSession(page);
      return { kinds: session?.tabs.map((tab) => tab.kind), active: session?.active, page: session?.tabs[0].view?.page };
    })
    .toEqual({ kinds: ["document", "home", "document"], active: 0, page: 5 });

  // Not from pdf.js's own history, in localStorage, which iPadOS may lose.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const restored = await documentFrame(page, PAPER);
  expect(await stripTabs(page)).toMatchObject([
    { name: PAPER, active: true },
    { home: true, active: false },
    { name: "Other.pdf", active: false },
  ]);
  await expect.poll(() => restored.evaluate(() => window.PDFViewerApplication.page)).toBe(5);
  expect(await restored.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale)).toBeCloseTo(1.5);
  // The others load once they're shown.
  expect(loadedDocuments(page)).toEqual([PAPER]);
  await page.locator("#tabs .tab").nth(2).click();
  await documentFrame(page, "Other.pdf");
  await page.locator("#tabs .tab").nth(1).click();
  await homeFrame(page);
});

test("a deleted document's tab doesn't come back, and without tabs Home shows", async ({ page }) => {
  await openApp(page);
  await openFromHome(page, [TRACEMONKEY]);
  await documentFrame(page, PAPER);
  await expect.poll(async () => (await readSession(page))?.tabs.length).toBe(1);
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("pdflion");
        open.onsuccess = () => {
          const transaction = open.result.transaction("documents", "readwrite");
          transaction.objectStore("documents").clear();
          transaction.oncomplete = () => resolve(undefined);
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
  await page.reload();
  await homeFrame(page);
  expect(await stripTabs(page)).toMatchObject([{ home: true, active: true }]);
});

test("a fifth document sends the one shown longest ago to sleep, saved, and it wakes where it was", async ({
  page,
  dir,
}) => {
  const names = ["A.pdf", "B.pdf", "C.pdf", "D.pdf", "E.pdf"];
  for (const name of names) await writeLabelled(path.join(dir, name), 3, name);
  await openAppExplained(page);

  await openFromHome(page, [path.join(dir, "A.pdf")]);
  let viewer = await documentFrame(page, "A.pdf");
  await drawStroke(page, viewer);
  await viewer.evaluate(() => {
    window.PDFViewerApplication.page = 2;
  });
  for (const name of names.slice(1)) {
    await viewer.locator("#pdflionHomeButton").click();
    await openFromHome(page, [path.join(dir, name)]);
    viewer = await documentFrame(page, name);
  }

  // A slept, once its drawing was stored.
  await expect.poll(() => loadedDocuments(page)).toEqual(["B.pdf", "C.pdf", "D.pdf", "E.pdf"]);
  expect((await readLibrary(page)).find((record) => record.name === "A.pdf")?.revision).toBe(1);
  expect((await stripTabs(page)).map((tab) => tab.name)).toEqual(names);

  // Shown, it loads again, with its drawing, where it was, and B sleeps.
  await page.locator("#tabs .tab").first().click();
  const woken = await documentFrame(page, "A.pdf");
  await expect.poll(() => woken.evaluate(() => window.PDFViewerApplication.page)).toBe(2);
  const annotations = await woken.evaluate(async () => {
    const pdfPage = await window.PDFViewerApplication.pdfDocument.getPage(1);
    return (await pdfPage.getAnnotations()).map((annotation) => annotation.subtype);
  });
  expect(annotations).toContain("Ink");
  await expect.poll(() => loadedDocuments(page)).toEqual(["A.pdf", "C.pdf", "D.pdf", "E.pdf"]);
});
