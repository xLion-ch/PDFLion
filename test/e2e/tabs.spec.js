import path from "node:path";
import {
  answerMessages,
  clickMenu,
  documentPage,
  documentPages,
  expect,
  isEdited,
  openFile,
  readFromMain,
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

/** @typedef {import("./pdflion.js").ElectronApplication} ElectronApplication */
/** @typedef {import("./pdflion.js").Page} Page */

/** The drag data type of a tab, in src/tabs/tabs.js. */
const TAB_TYPE = "application/x-pdflion-tab";

/** The strip's height, STRIP_HEIGHT in src/main/tabs.js. */
const STRIP_HEIGHT = 36;

/**
 * Starts PDFLion with one copy of the tracemonkey paper per name, opened one
 * after another as tabs of one window. A tab that isn't shown doesn't render,
 * so each waits for its first page before the next opens.
 *
 * @param {(files: string[]) => Promise<{ app: ElectronApplication, page: Page }>} pdflion
 * @param {string[]} names
 * @returns {Promise<{ app: ElectronApplication, pages: Page[], files: string[] }>}
 */
async function openTabs(pdflion, names) {
  const dir = await tempDir();
  const files = [];
  for (const name of names) files.push(await tracemonkey(dir, name));
  const { app, page } = await pdflion([files[0]]);
  const pages = [page];
  for (const file of files.slice(1)) pages.push(await openAndRender(app, file));
  return { app, pages, files };
}

/**
 * @param {ElectronApplication} app
 * @param {string} file
 * @returns {Promise<Page>} the file's page, once it shows its first page
 */
async function openAndRender(app, file) {
  await openFile(app, file);
  const page = await documentPage(app, path.basename(file));
  await rendered(page);
  return page;
}

/**
 * @param {ElectronApplication} app
 * @param {Page} page a tab's viewer
 * @returns {Promise<{ view: Electron.Rectangle, content: Electron.Rectangle, visible: boolean }>}
 *   the bounds of the tab's view, and of its window's content
 */
function viewBounds(app, page) {
  return app.evaluate(
    ({ BrowserWindow, webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((other) => other.getURL().split("#")[0] === url.split("#")[0]);
      if (!contents) throw new Error(`No page at ${url}`);
      const win = /** @type {Electron.BrowserWindow} */ (BrowserWindow.fromWebContents(contents));
      const view = win.contentView.children.find(
        (child) => /** @type {Electron.WebContentsView} */ (child).webContents === contents,
      );
      if (!view) throw new Error(`No view for ${url}`);
      return { view: view.getBounds(), content: win.getContentBounds(), visible: view.getVisible() };
    },
    page.url(),
  );
}

/**
 * @param {Page} strip
 * @returns {Promise<string[]>} the names of its tabs, left to right
 */
async function tabNames(strip) {
  return (await stripTabs(strip)).map(({ name }) => name);
}

/**
 * @param {Page} strip
 * @returns {Promise<string | undefined>} the name of its active tab
 */
async function activeName(strip) {
  return (await stripTabs(strip)).find(({ active }) => active)?.name;
}

/**
 * @param {Page} strip
 * @param {string} name
 * @returns {Promise<string>} the id of the tab named `name`
 */
async function tabId(strip, name) {
  const tab = (await stripTabs(strip)).find((other) => other.name === name);
  if (!tab) throw new Error(`No tab ${name}`);
  return tab.id;
}

/**
 * @param {Page} strip
 * @param {string} name
 */
function tab(strip, name) {
  return strip.locator(`.tab[title=${JSON.stringify(name)}]`);
}

/**
 * Replaces the context menu's popup with one that keeps the menu, for
 * clickContextMenu().
 *
 * @param {ElectronApplication} app
 */
async function catchContextMenus(app) {
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      /** @type {any} */ (globalThis).contextMenu = this;
    };
  });
}

/**
 * @param {ElectronApplication} app
 * @returns {Promise<{ label: string, enabled: boolean }[]>} the items of the
 *   last context menu
 */
function contextMenuItems(app) {
  return app.evaluate(() =>
    /** @type {any} */ (globalThis).contextMenu.items
      .filter((/** @type {Electron.MenuItem} */ item) => item.type !== "separator")
      .map((/** @type {Electron.MenuItem} */ item) => ({
        label: item.label,
        enabled: item.enabled,
      })),
  );
}

/**
 * Right-clicks a tab in the strip, then chooses an item of its context menu.
 *
 * @param {ElectronApplication} app
 * @param {Page} strip
 * @param {string} name the tab
 * @param {string} label the item
 */
async function chooseFromContextMenu(app, strip, name, label) {
  await app.evaluate(() => {
    /** @type {any} */ (globalThis).contextMenu = null;
  });
  await tab(strip, name).click({ button: "right" });
  await expect
    .poll(() => app.evaluate(() => Boolean(/** @type {any} */ (globalThis).contextMenu)))
    .toBe(true);
  await app.evaluate((_electron, label) => {
    const item = /** @type {any} */ (globalThis).contextMenu.items.find(
      (/** @type {Electron.MenuItem} */ other) => other.label === label,
    );
    item.click();
  }, label);
}

/**
 * @param {ElectronApplication} app
 * @param {string} id a menu item id
 * @returns {Promise<boolean>}
 */
function isMenuItemEnabled(app, id) {
  return app.evaluate(
    ({ Menu }, id) => Boolean(Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled),
    id,
  );
}

/**
 * Drops a tab on a page as the operating system's drag would: on the strip's
 * tab list at `clientX`, or on a document.
 *
 * @param {Page} page a strip or a viewer
 * @param {string} id
 * @param {number} [clientX]
 */
async function dropTab(page, id, clientX = 0) {
  await page.evaluate(
    ({ id, clientX, type }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(type, id);
      const target = document.getElementById("tabs") ?? window;
      target.dispatchEvent(
        new DragEvent("drop", { dataTransfer, clientX, bubbles: true, cancelable: true }),
      );
    },
    { id, clientX, type: TAB_TYPE },
  );
}

test("files open as tabs after Home, the leftmost tab, an icon alone", async ({ pdflion }) => {
  const dir = await tempDir();
  const { app, page: first } = await pdflion([await tracemonkey(dir, "first.pdf")]);
  const strip = await stripOf(app, first);
  // With one document, the strip shows Home before it.
  expect(await stripTabs(strip)).toMatchObject([
    { name: "Home", home: true, active: false },
    { name: "first.pdf", home: false, active: true },
  ]);
  const one = await viewBounds(app, first);
  expect(one.view).toEqual({
    x: 0,
    y: STRIP_HEIGHT,
    width: one.content.width,
    height: one.content.height - STRIP_HEIGHT,
  });
  const home = strip.locator(".tab.home");
  await expect(home.locator(".name")).toHaveText("");
  await expect(home.locator(".close")).toBeHidden();
  expect(await home.getAttribute("draggable")).toBe("false");
  const width = async (/** @type {import("@playwright/test").Locator} */ locator) =>
    (await locator.boundingBox())?.width ?? 0;
  expect(await width(home)).toBeLessThan(await width(tab(strip, "first.pdf")));

  const second = await openAndRender(app, await tracemonkey(dir, "second.pdf"));
  expect(await windowCount(app)).toBe(1);
  expect(await stripTabs(strip)).toMatchObject([
    { name: "Home", home: true, active: false },
    { name: "first.pdf", active: false },
    { name: "second.pdf", active: true },
  ]);
  const two = await viewBounds(app, second);
  expect(two.view).toEqual({
    x: 0,
    y: STRIP_HEIGHT,
    width: two.content.width,
    height: two.content.height - STRIP_HEIGHT,
  });
  expect(two.visible).toBe(true);
  expect((await viewBounds(app, first)).visible).toBe(false);
  expect(await windowTitle(app, second)).toBe("second.pdf");
});

test("opening a file that's already open selects its tab", async ({ pdflion }) => {
  const { app, pages, files } = await openTabs(pdflion, ["first.pdf", "second.pdf"]);
  const strip = await stripOf(app, pages[0]);
  expect(await activeName(strip)).toBe("second.pdf");

  await openFile(app, files[0]);
  await expect.poll(() => activeName(strip)).toBe("first.pdf");
  expect(documentPages(app)).toHaveLength(2);
  expect(await windowTitle(app, pages[0])).toBe("first.pdf");
  if (process.platform === "darwin") {
    const win = await app.browserWindow(pages[0]);
    expect(await win.evaluate((win) => win.getRepresentedFilename())).toBe(files[0]);
  }
});

test("selects and closes tabs from the strip, and the title follows", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf", "third.pdf"]);
  const [first, second, third] = pages;
  const strip = await stripOf(app, first);
  expect(await windowTitle(app, first)).toBe("third.pdf");

  await tab(strip, "first.pdf").click();
  await expect.poll(() => activeName(strip)).toBe("first.pdf");
  expect(await windowTitle(app, first)).toBe("first.pdf");
  expect((await viewBounds(app, first)).visible).toBe(true);
  expect((await viewBounds(app, third)).visible).toBe(false);

  // Arrow keys move between tabs and select them.
  await strip.keyboard.press("ArrowRight");
  await expect.poll(() => activeName(strip)).toBe("second.pdf");
  await strip.keyboard.press("ArrowLeft");
  await expect.poll(() => activeName(strip)).toBe("first.pdf");

  // The middle button closes a tab.
  const secondClosed = second.waitForEvent("close");
  await tab(strip, "second.pdf").click({ button: "middle" });
  await secondClosed;
  expect(await tabNames(strip)).toEqual(["Home", "first.pdf", "third.pdf"]);

  // Closing the active tab selects its right neighbour.
  const firstClosed = first.waitForEvent("close");
  await tab(strip, "first.pdf").locator(".close").click();
  await firstClosed;
  await expect.poll(() => tabNames(strip)).toEqual(["Home", "third.pdf"]);
  expect(await windowTitle(app, third)).toBe("third.pdf");
  expect((await viewBounds(app, third)).view.y).toBe(STRIP_HEIGHT);

  // Closing the last document leaves Home, which neither the middle button
  // nor the strip closes.
  const thirdClosed = third.waitForEvent("close");
  await tab(strip, "third.pdf").locator(".close").click();
  await thirdClosed;
  await expect.poll(() => stripTabs(strip)).toMatchObject([{ name: "Home", active: true }]);
  expect(await windowTitle(app, strip)).toBe("PDFLion");
  await tab(strip, "Home").click({ button: "middle" });
  const homeId = await tabId(strip, "Home");
  await strip.evaluate((id) => window.pdflionTabs.close(id), homeId);
  await strip.waitForTimeout(300);
  expect(await tabNames(strip)).toEqual(["Home"]);
  expect(await windowCount(app)).toBe(1);
});

test("menu commands reach the active tab", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf"]);
  const [first, second] = pages;
  const scale = (/** @type {Page} */ page) => () =>
    page.evaluate(() => PDFViewerApplication.pdfViewer.currentScale);
  const firstScale = await scale(first)();
  const secondScale = await scale(second)();

  await clickMenu(app, first, "zoomIn");
  await expect.poll(scale(second)).toBeGreaterThan(secondScale);
  expect(await scale(first)()).toBe(firstScale);

  await tab(await stripOf(app, first), "first.pdf").click();
  await clickMenu(app, first, "rotateRight");
  await expect
    .poll(() => first.evaluate(() => PDFViewerApplication.pdfViewer.pagesRotation))
    .toBe(90);
  expect(await second.evaluate(() => PDFViewerApplication.pdfViewer.pagesRotation)).toBe(0);
});

test("closing a window with two edited tabs asks about each, and Cancel keeps both", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const [a, b] = [path.join(dir, "a.pdf"), path.join(dir, "b.pdf")];
  await writeForm(a);
  await writeForm(b);
  const { app, page: pageA } = await pdflion([a]);
  await pageA.locator(".annotationLayer input").fill("changed");
  const pageB = await openAndRender(app, b);
  await pageB.locator(".annotationLayer input").fill("changed");
  const strip = await stripOf(app, pageA);
  const edits = async () => (await stripTabs(strip)).map(({ edited }) => edited);
  await expect.poll(edits).toEqual([false, true, true]);
  const win = await app.browserWindow(pageA);
  const messages = () => app.evaluate(() => /** @type {any} */ (globalThis).messages);
  const ask = (/** @type {string} */ name) =>
    `Do you want to save the changes made to the document “${name}”?`;

  await answerMessages(app, "Cancel");
  await win.evaluate((win) => win.close());
  await expect.poll(messages).toEqual([ask("a.pdf")]);
  // It selected the tab it asked about.
  expect(await activeName(strip)).toBe("a.pdf");
  expect(documentPages(app)).toHaveLength(2);

  await app.evaluate(() => {
    /** @type {any} */ (globalThis).messages = [];
  });
  await answerMessages(app, "Don’t Save");
  const closed = Promise.all([pageA.waitForEvent("close"), pageB.waitForEvent("close")]);
  await win.evaluate((win) => win.close()).catch(() => {}); // Windows and Linux quit with it
  await closed;
  if (process.platform === "darwin") {
    expect(await messages()).toEqual([ask("a.pdf"), ask("b.pdf")]);
  }
});

test("Presentation Mode in a tab fills the screen, over the strip", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf"]);
  const second = pages[1];
  const win = await app.browserWindow(second);
  /** @param {string} code */
  const read = (code) => readFromMain(app, second, code);
  const presenting = () => read("PDFViewerApplication.pdfViewer.isInPresentationMode");

  await expect.poll(() => read("navigator.userActivation.isActive")).toBe(false);
  await clickMenu(app, second, "presentation");
  await expect.poll(presenting).toBe(true);
  await expect.poll(() => win.evaluate((win) => win.isFullScreen())).toBe(true);
  await expect
    .poll(async () => {
      const { view, content } = await viewBounds(app, second);
      return view.y === 0 && view.height === content.height && view.width === content.width;
    })
    .toBe(true);

  await win.evaluate((win) => win.setFullScreen(false));
  await expect.poll(presenting).toBe(false);
  await expect.poll(async () => (await viewBounds(app, second)).view.y).toBe(STRIP_HEIGHT);
});

test("Close Tab, Close Tab on Home, and Close Window", async ({ pdflion }) => {
  const { app, pages, files } = await openTabs(pdflion, ["first.pdf", "second.pdf", "third.pdf"]);
  const [first, second, third] = pages;
  const strip = await stripOf(app, first);

  const thirdClosed = third.waitForEvent("close");
  await clickMenu(app, first, "closeTab");
  await thirdClosed;
  expect(await tabNames(strip)).toEqual(["Home", "first.pdf", "second.pdf"]);
  expect(await activeName(strip)).toBe("second.pdf");

  // On Home, which closes only with its window, it closes the window.
  await tab(strip, "Home").click();
  await expect.poll(() => activeName(strip)).toBe("Home");
  const closed = Promise.all([first.waitForEvent("close"), second.waitForEvent("close")]);
  await clickMenu(app, first, "closeTab").catch(() => {}); // Windows and Linux quit with it
  await closed;
  if (process.platform === "darwin") expect(await windowCount(app)).toBe(0);

  // Close Window.
  const { app: other, page } = await pdflion([files[0]]);
  const pageClosed = page.waitForEvent("close");
  await clickMenu(other, page, "closeWindow").catch(() => {});
  await pageClosed;
});

test("Show Next Tab and Show Previous Tab wrap around", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf", "third.pdf"]);
  const page = pages[0];
  const strip = await stripOf(app, page);
  expect(await activeName(strip)).toBe("third.pdf");

  for (const [id, expected] of [
    ["nextTab", "Home"],
    ["nextTab", "first.pdf"],
    ["previousTab", "Home"],
    ["previousTab", "third.pdf"],
    ["nextTabAlternate", "Home"],
    ["previousTabAlternate", "third.pdf"],
  ]) {
    await clickMenu(app, page, id);
    await expect.poll(() => activeName(strip)).toBe(expected);
  }
  expect(await windowTitle(app, page)).toBe("third.pdf");
});

test("Move Tab to New Window, then Merge All Windows", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf"]);
  const [first, second] = pages;
  expect(await isMenuItemEnabled(app, "mergeAllWindows")).toBe(false);

  // The page moves with the tab, without reloading.
  await second.evaluate(() => {
    /** @type {any} */ (window).marker = "kept";
  });
  await clickMenu(app, second, "moveTabToNewWindow");
  await expect.poll(() => windowCount(app)).toBe(2);
  expect(await second.evaluate(() => /** @type {any} */ (window).marker)).toBe("kept");
  const [firstStrip, secondStrip] = [await stripOf(app, first), await stripOf(app, second)];
  expect(firstStrip).not.toBe(secondStrip);
  expect(await tabNames(firstStrip)).toEqual(["Home", "first.pdf"]);
  expect(await tabNames(secondStrip)).toEqual(["Home", "second.pdf"]);
  expect(await activeName(secondStrip)).toBe("second.pdf");
  expect(await windowTitle(app, second)).toBe("second.pdf");
  await expect.poll(() => isMenuItemEnabled(app, "mergeAllWindows")).toBe(true);
  // A window's only document stays in it.
  expect(await isMenuItemEnabled(app, "moveTabToNewWindow")).toBe(false);

  // The new window is in front, so the other window's tabs join it.
  await clickMenu(app, second, "mergeAllWindows");
  await expect.poll(() => windowCount(app)).toBe(1);
  expect(await tabNames(secondStrip)).toEqual(["Home", "second.pdf", "first.pdf"]);
  expect(await activeName(secondStrip)).toBe("second.pdf");
  expect(await first.evaluate(() => PDFViewerApplication.pagesCount)).toBe(14);
  await expect.poll(() => isMenuItemEnabled(app, "mergeAllWindows")).toBe(false);
});

test("the tab context menu closes and moves tabs", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf", "third.pdf"]);
  const [first, second, third] = pages;
  const strip = await stripOf(app, first);
  await catchContextMenus(app);

  await chooseFromContextMenu(app, strip, "second.pdf", "Move Tab to New Window");
  await expect.poll(() => windowCount(app)).toBe(2);
  expect(await tabNames(strip)).toEqual(["Home", "first.pdf", "third.pdf"]);
  expect(await tabNames(await stripOf(app, second))).toEqual(["Home", "second.pdf"]);

  // Home stays.
  const thirdClosed = third.waitForEvent("close");
  await chooseFromContextMenu(app, strip, "first.pdf", "Close Other Tabs");
  await thirdClosed;
  expect(await tabNames(strip)).toEqual(["Home", "first.pdf"]);

  // The last document of a window leaves Home.
  const firstClosed = first.waitForEvent("close");
  await chooseFromContextMenu(app, strip, "first.pdf", "Close Tab");
  await firstClosed;
  // With one document, there are no others to close or to move away from.
  expect(await contextMenuItems(app)).toEqual([
    { label: "Close Tab", enabled: true },
    { label: "Close Other Tabs", enabled: false },
    { label: "Move Tab to New Window", enabled: false },
  ]);
  await expect.poll(() => tabNames(strip)).toEqual(["Home"]);
  expect(await windowCount(app)).toBe(2);

  // Home's menu only closes the documents.
  await chooseFromContextMenu(app, strip, "Home", "Close Other Tabs");
  expect(await contextMenuItems(app)).toEqual([{ label: "Close Other Tabs", enabled: false }]);
  const otherStrip = await stripOf(app, second);
  const secondClosed = second.waitForEvent("close");
  await chooseFromContextMenu(app, otherStrip, "Home", "Close Other Tabs");
  expect(await contextMenuItems(app)).toEqual([{ label: "Close Other Tabs", enabled: true }]);
  await secondClosed;
  expect(await tabNames(otherStrip)).toEqual(["Home"]);
});

test("reorders tabs by dragging them within the strip", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf", "third.pdf"]);
  const strip = await stripOf(app, pages[0]);

  await tab(strip, "third.pdf").dragTo(tab(strip, "first.pdf"), {
    targetPosition: { x: 4, y: 10 },
  });
  await expect.poll(() => tabNames(strip)).toEqual(["Home", "third.pdf", "first.pdf", "second.pdf"]);
  expect(await activeName(strip)).toBe("third.pdf");

  const box = /** @type {{ width: number }} */ (await tab(strip, "second.pdf").boundingBox());
  await tab(strip, "first.pdf").dragTo(tab(strip, "second.pdf"), {
    targetPosition: { x: box.width - 4, y: 10 },
  });
  await expect.poll(() => tabNames(strip)).toEqual(["Home", "third.pdf", "second.pdf", "first.pdf"]);

  // Nothing goes before Home, which doesn't move.
  await tab(strip, "second.pdf").dragTo(tab(strip, "Home"), { targetPosition: { x: 4, y: 10 } });
  await expect.poll(() => tabNames(strip)).toEqual(["Home", "second.pdf", "third.pdf", "first.pdf"]);
  const homeId = await tabId(strip, "Home");
  await strip.evaluate((id) => window.pdflionTabs.move(id, 2), homeId);
  await strip.evaluate((id) => window.pdflionTabs.move(id, 0), await tabId(strip, "first.pdf"));
  await expect.poll(() => tabNames(strip)).toEqual(["Home", "first.pdf", "second.pdf", "third.pdf"]);
});

test("a tab dropped on another window's strip or document moves there", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf", "third.pdf"]);
  const [first, second, third] = pages;
  const stripA = await stripOf(app, first);
  await clickMenu(app, third, "moveTabToNewWindow");
  await expect.poll(() => windowCount(app)).toBe(2);
  const stripB = await stripOf(app, third);

  // On a document, it goes last.
  const secondId = await tabId(stripA, "second.pdf");
  await stripA.evaluate((id) => window.pdflionTabs.dragStarted(id), secondId);
  await dropTab(third, secondId);
  await expect.poll(() => tabNames(stripB)).toEqual(["Home", "third.pdf", "second.pdf"]);
  expect(await activeName(stripB)).toBe("second.pdf");
  expect(await tabNames(stripA)).toEqual(["Home", "first.pdf"]);
  expect(await second.evaluate(() => PDFViewerApplication.pagesCount)).toBe(14);
  await stripA.evaluate((id) => window.pdflionTabs.dragEnded(id, "move"), secondId);

  // On a strip, it goes where it was dropped, after Home even when dropped on
  // it. Window A, left with only Home, closes.
  const firstId = await tabId(stripA, "first.pdf");
  await stripA.evaluate((id) => window.pdflionTabs.dragStarted(id), firstId);
  await dropTab(stripB, firstId, 1);
  await expect.poll(() => tabNames(stripB)).toEqual(["Home", "first.pdf", "third.pdf", "second.pdf"]);
  await expect.poll(() => windowCount(app)).toBe(1);
});

test("a tab dropped outside every window tears off into its own", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf"]);
  const [first, second] = pages;
  const strip = await stripOf(app, first);
  /** @param {Page} page */
  const normalBounds = async (page) =>
    (await app.browserWindow(page)).evaluate((win) => win.getNormalBounds());
  const sourceBounds = await normalBounds(first);
  await app.evaluate(({ screen }) => {
    screen.getCursorScreenPoint = () => ({ x: -10000, y: -10000 });
  });

  const secondId = await tabId(strip, "second.pdf");
  await strip.evaluate((id) => window.pdflionTabs.dragStarted(id), secondId);
  await strip.evaluate((id) => window.pdflionTabs.dragEnded(id, "none"), secondId);
  await expect.poll(() => windowCount(app)).toBe(2);
  expect(await tabNames(strip)).toEqual(["Home", "first.pdf"]);
  expect(await tabNames(await stripOf(app, second))).toEqual(["Home", "second.pdf"]);
  const newBounds = await normalBounds(second);
  expect({ width: newBounds.width, height: newBounds.height }).toEqual({
    width: sourceBounds.width,
    height: sourceBounds.height,
  });
});

test("ignores a drop of a tab that isn't being dragged", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf", "third.pdf"]);
  const [first, , third] = pages;
  const stripA = await stripOf(app, first);
  await clickMenu(app, third, "moveTabToNewWindow");
  await expect.poll(() => windowCount(app)).toBe(2);
  const stripB = await stripOf(app, third);
  const [firstId, secondId] = [await tabId(stripA, "first.pdf"), await tabId(stripA, "second.pdf")];

  await stripB.evaluate((id) => window.pdflionTabs.drop(id, 0), secondId);
  await dropTab(third, secondId);
  // A drag of another tab doesn't make this one droppable.
  await stripA.evaluate((id) => window.pdflionTabs.dragStarted(id), firstId);
  await stripB.evaluate((id) => window.pdflionTabs.drop(id, 0), secondId);
  await first.waitForTimeout(500);
  expect(await tabNames(stripA)).toEqual(["Home", "first.pdf", "second.pdf"]);
  expect(await tabNames(stripB)).toEqual(["Home", "third.pdf"]);
});

test("shows unsaved changes in the title with one document, and on the tabs with several", async ({
  pdflion,
}) => {
  const isMac = process.platform === "darwin";
  /** What the title shows for an edited document alone in its window. */
  const editedTitle = (/** @type {string} */ name) =>
    ({ darwin: `${name} — Edited`, win32: `*${name}`, linux: `*${name}` })[process.platform];
  const dir = await tempDir();
  const [a, b] = [path.join(dir, "a.pdf"), path.join(dir, "b.pdf")];
  await writeForm(a);
  await writeForm(b);
  const { app, page: pageA } = await pdflion([a]);
  const strip = await stripOf(app, pageA);
  const edits = async () => (await stripTabs(strip)).map(({ edited }) => edited);
  /** @returns {Promise<boolean>} the dot in the close button, on macOS */
  const windowDot = async () =>
    (await app.browserWindow(pageA)).evaluate((win) => win.isDocumentEdited());

  // One document: the title.
  await pageA.locator(".annotationLayer input").fill("changed");
  await expect.poll(() => windowTitle(app, pageA)).toBe(editedTitle("a.pdf"));
  expect(await isEdited(app, pageA)).toBe(true);
  await clickMenu(app, pageA, "save");
  await expect.poll(() => windowTitle(app, pageA)).toBe("a.pdf");
  expect(await isEdited(app, pageA)).toBe(false);

  // Several documents: each tab, and the title names the document alone.
  const pageB = await openAndRender(app, b);
  await pageB.locator(".annotationLayer input").fill("changed");
  await expect.poll(edits).toEqual([false, false, true]);
  expect(await windowTitle(app, pageB)).toBe("b.pdf");
  expect((await stripTabs(strip))[2].label).toBe("b.pdf, edited");
  await expect(tab(strip, "b.pdf").locator(".dot")).toBeVisible();
  await expect(tab(strip, "b.pdf").locator(".close")).toBeHidden();
  await expect(tab(strip, "a.pdf").locator(".dot")).toBeHidden();
  if (isMac) expect(await windowDot()).toBe(true);

  // The pointer over an edited tab shows its close button again.
  await tab(strip, "b.pdf").hover();
  await expect(tab(strip, "b.pdf").locator(".close")).toBeVisible();

  await tab(strip, "a.pdf").click();
  await pageA.locator(".annotationLayer input").fill("changed again");
  await expect.poll(edits).toEqual([false, true, true]);
  expect(await windowTitle(app, pageA)).toBe("a.pdf");
  await clickMenu(app, pageA, "save");
  await expect.poll(edits).toEqual([false, false, true]);
  if (isMac) expect(await windowDot()).toBe(true);

  await tab(strip, "b.pdf").click();
  await clickMenu(app, pageB, "save");
  await expect.poll(edits).toEqual([false, false, false]);
  expect(await windowTitle(app, pageB)).toBe("b.pdf");
  if (isMac) expect(await windowDot()).toBe(false);
});

test("a tab whose page goes away by itself closes", async ({ pdflion }) => {
  const { app, pages } = await openTabs(pdflion, ["first.pdf", "second.pdf"]);
  const [first, second] = pages;
  const strip = await stripOf(app, second);
  const closed = first.waitForEvent("close");
  await app.evaluate(({ webContents }, url) => {
    webContents.getAllWebContents().find((other) => other.getURL() === url)?.close();
  }, first.url());
  await closed;
  await expect.poll(() => tabNames(strip)).toEqual(["Home", "second.pdf"]);
  expect((await viewBounds(app, second)).view.y).toBe(STRIP_HEIGHT);
  // Main still answers, and its timers run.
  expect(await app.evaluate(() => new Promise((resolve) => setTimeout(() => resolve(true), 50)))).toBe(true);
});
