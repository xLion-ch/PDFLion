/**
 * The menu's shortcuts for PDFLion's own commands, which pdf.js mustn't act
 * on as well.
 *
 * Electron hands the native menu the keys the page leaves unhandled, but a key
 * sent with webContents.sendInputEvent() never reaches the menu on macOS. So
 * pressShortcut() presses a key in the page, checks that the page left it to
 * the menu and acted on nothing, and then clicks the one menu item with that
 * accelerator, as Electron would.
 */
import { clickMenu, expect, tempDir, test, tracemonkey } from "./pdflion.js";

/** @typedef {import("./pdflion.js").ElectronApplication} ElectronApplication */
/** @typedef {import("./pdflion.js").Page} Page */

const isMac = process.platform === "darwin";

/** The shortcuts, as Electron's accelerators. */
const SHORTCUTS = isMac
  ? { insertBlankPage: "Shift+Cmd+N", pageOverview: "Alt+Cmd+6", eraser: "Shift+Cmd+E" }
  : { insertBlankPage: "Shift+Ctrl+N", pageOverview: "Shift+Ctrl+O", eraser: "Shift+Ctrl+E" };

/** sendInputEvent()'s name for each modifier of an accelerator. */
const MODIFIERS = {
  cmdorctrl: isMac ? "meta" : "control",
  commandorcontrol: isMac ? "meta" : "control",
  cmd: "meta",
  command: "meta",
  ctrl: "control",
  control: "control",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

/**
 * @param {string} accelerator such as "Shift+CmdOrCtrl+N"
 * @returns {{ keyCode: string, modifiers: string[] }} the key, as
 *   sendInputEvent() takes it
 */
function keyOf(accelerator) {
  const parts = accelerator.split("+");
  const keyCode = /** @type {string} */ (parts.pop()).toUpperCase();
  const modifiers = parts.map(
    (part) => MODIFIERS[/** @type {keyof typeof MODIFIERS} */ (part.toLowerCase())],
  );
  return { keyCode, modifiers: modifiers.sort() };
}

/**
 * @param {Page} page
 * @returns {Promise<object>} what pdf.js would change if it acted on a key
 */
const viewerState = (page) =>
  page.evaluate(() => {
    const { classList } = /** @type {HTMLElement} */ (document.getElementById("outerContainer"));
    return {
      page: PDFViewerApplication.page,
      pages: PDFViewerApplication.pagesCount,
      rotation: PDFViewerApplication.pdfViewer.pagesRotation,
      scale: PDFViewerApplication.pdfViewer.currentScaleValue,
      sidebar: PDFViewerApplication.viewsManager.isOpen,
      findBar: PDFViewerApplication.findBar.opened,
      tool: PDFViewerApplication.pdfViewer.annotationEditorMode,
      overview: classList.contains("pdflionPageOverview"),
      erasing: classList.contains("pdflionErasing"),
    };
  });

/**
 * Presses a shortcut in a tab's page. Once the page has left it unhandled,
 * without acting on it, clicks the menu item with its accelerator.
 *
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {string} accelerator
 * @returns {Promise<string>} the menu item's id
 */
async function pressShortcut(app, page, accelerator) {
  const key = keyOf(accelerator);
  await page.evaluate(() => {
    /** @type {any} */ (window).pressed = null;
    // After the listeners of pdf.js and bridge.js.
    addEventListener(
      "keydown",
      (event) => {
        /** @type {any} */ (window).pressed = { prevented: event.defaultPrevented };
      },
      { once: true },
    );
  });
  const before = await viewerState(page);
  await app.evaluate(
    ({ BrowserWindow, webContents }, { url, key }) => {
      const contents = webContents.getAllWebContents().find((other) => other.getURL() === url);
      if (!contents) throw new Error(`No page at ${url}`);
      // sendInputEvent() needs the window focused.
      BrowserWindow.fromWebContents(contents)?.focus();
      contents.focus();
      contents.sendInputEvent({ type: "keyDown", ...key });
      contents.sendInputEvent({ type: "keyUp", ...key });
    },
    { url: page.url(), key },
  );
  await expect
    .poll(() => page.evaluate(() => /** @type {any} */ (window).pressed?.prevented), {
      message: `the page leaves ${accelerator} to the menu`,
    })
    .toBe(false);
  expect(await viewerState(page), `nothing acts on ${accelerator} in the page`).toEqual(before);

  const items = await app.evaluate(({ Menu }) => {
    /** @type {{ id: string, accelerator: string }[]} */
    const found = [];
    /** @param {Electron.Menu | null | undefined} menu */
    const collect = (menu) => {
      for (const item of menu?.items ?? []) {
        if (item.accelerator) found.push({ id: item.id, accelerator: item.accelerator });
        collect(item.submenu);
      }
    };
    collect(Menu.getApplicationMenu());
    return found;
  });
  const same = (/** @type {string} */ other) =>
    JSON.stringify(keyOf(other)) === JSON.stringify(key);
  const matching = items.filter((item) => same(item.accelerator)).map((item) => item.id);
  expect(matching, `one menu item has ${accelerator}`).toHaveLength(1);
  await clickMenu(app, page, matching[0]);
  return matching[0];
}

test("PDFLion's own shortcuts each act once, and pdf.js doesn't act on them", async ({
  pdflion,
}) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  const state = () => viewerState(page);

  await test.step("Insert Blank Page", async () => {
    expect(await pressShortcut(app, page, SHORTCUTS.insertBlankPage)).toBe("insertBlankPage");
    // After the current page, which it shows.
    await expect.poll(state).toMatchObject({ pages: 15, page: 2 });
  });

  await test.step("Page Overview", async () => {
    expect(await pressShortcut(app, page, SHORTCUTS.pageOverview)).toBe("pageOverview");
    await expect.poll(state).toMatchObject({ overview: true });
    // Again from the overview, whose thumbnails have the focus.
    expect(await pressShortcut(app, page, SHORTCUTS.pageOverview)).toBe("pageOverview");
    await expect.poll(state).toMatchObject({ overview: false });
  });

  await test.step("Eraser", async () => {
    expect(await pressShortcut(app, page, SHORTCUTS.eraser)).toBe("eraser");
    await expect.poll(state).toMatchObject({ erasing: true, tool: 15 });
    expect(await pressShortcut(app, page, SHORTCUTS.eraser)).toBe("eraser");
    await expect.poll(state).toMatchObject({ erasing: false, tool: 0 });
  });

  // A second blank page would have come by now.
  expect((await state()).pages).toBe(15);
});
