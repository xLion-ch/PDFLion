import {
  clickMenu,
  documentPage,
  documentPages,
  expect,
  openFile,
  readFromMain,
  rendered,
  tempDir,
  test,
  tracemonkey,
  windowCount,
} from "./pdflion.js";

test("opens a PDF in a window, titled with its name", async ({ pdflion }) => {
  const file = await tracemonkey(await tempDir());
  const { app, page } = await pdflion([file]);

  await expect(page).toHaveTitle("tracemonkey.pdf");
  expect(await page.evaluate(() => PDFViewerApplication.pagesCount)).toBe(14);
  const win = await app.browserWindow(page);
  expect(await win.evaluate((win) => win.getTitle())).toBe("tracemonkey.pdf");
  if (process.platform === "darwin") {
    expect(await win.evaluate((win) => win.getRepresentedFilename())).toBe(file);
  }
});

test("opening a file again keeps its tab, and another file opens as a tab", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const [first, second] = [
    await tracemonkey(dir, "first.pdf"),
    await tracemonkey(dir, "second.pdf"),
  ];
  const { app } = await pdflion([first]);

  await openFile(app, first);
  await expect.poll(() => documentPages(app).length).toBe(1);

  await openFile(app, second);
  const page = await documentPage(app, "second.pdf");
  await rendered(page);
  await expect(page).toHaveTitle("second.pdf");
  expect(documentPages(app)).toHaveLength(2);
  expect(await windowCount(app)).toBe(1);
});

test("menu commands reach pdf.js", async ({ pdflion }) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  /** @param {() => unknown} read evaluated in the page */
  const viewer = (read) => () => page.evaluate(read);

  await test.step("zoom", async () => {
    const scale = viewer(() => PDFViewerApplication.pdfViewer.currentScale);
    const before = /** @type {number} */ (await scale());
    await clickMenu(app, page, "zoomIn");
    await expect.poll(scale).toBeGreaterThan(before);
    const zoomedIn = /** @type {number} */ (await scale());
    await clickMenu(app, page, "zoomOut");
    await expect.poll(scale).toBeLessThan(zoomedIn);
    await clickMenu(app, page, "actualSize");
    await expect
      .poll(viewer(() => PDFViewerApplication.pdfViewer.currentScaleValue))
      .toBe("page-actual");
    await expect.poll(scale).toBe(1);
  });

  await test.step("rotate", async () => {
    const rotation = viewer(() => PDFViewerApplication.pdfViewer.pagesRotation);
    await clickMenu(app, page, "rotateRight");
    await expect.poll(rotation).toBe(90);
    await clickMenu(app, page, "rotateLeft");
    await clickMenu(app, page, "rotateLeft");
    await expect.poll(rotation).toBe(270);
  });

  await test.step("sidebar", async () => {
    const isOpen = viewer(() => PDFViewerApplication.viewsManager.isOpen);
    const before = await isOpen();
    await clickMenu(app, page, "toggleSidebar");
    await expect.poll(isOpen).toBe(!before);
    await clickMenu(app, page, "toggleSidebar");
    await expect.poll(isOpen).toBe(before);
  });

  await test.step("find", async () => {
    await clickMenu(app, page, "find");
    await expect.poll(viewer(() => PDFViewerApplication.findBar.opened)).toBe(true);
  });
});

test("Presentation Mode fills the screen, also when chosen with the mouse", async ({ pdflion }) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  const win = await app.browserWindow(page);
  // Read from main: page.evaluate() would count as a user gesture.
  /** @param {string} code */
  const read = (code) => readFromMain(app, page, code);
  const presenting = () => read("PDFViewerApplication.pdfViewer.isInPresentationMode");

  // A click on the native menu gives the page no user activation, which
  // requestFullscreen() needs. So wait until earlier gestures have expired.
  await expect.poll(() => read("navigator.userActivation.isActive")).toBe(false);
  await clickMenu(app, page, "presentation");
  await expect.poll(presenting).toBe(true);

  // Leaving full screen, as with the window's green button, ends it. Escape
  // works too, but only once macOS has settled into the full-screen space.
  await expect.poll(() => win.evaluate((win) => win.isFullScreen())).toBe(true);
  await win.evaluate((win) => win.setFullScreen(false));
  await expect.poll(presenting).toBe(false);
});

test("Print renders every page before the print dialog", async ({ pdflion }) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  // pdf.js keeps the window.print it finds at load and calls it once every
  // page is rendered. Stand in for it, rather than open the dialog.
  await page.addInitScript(() => {
    window.print = () => {
      /** @type {any} */ (window).printedPages = document.querySelectorAll(
        "#printContainer > .printedPage",
      ).length;
    };
  });
  await page.reload();
  await rendered(page);

  await clickMenu(app, page, "print");
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).printedPages)).toBe(14);
});
