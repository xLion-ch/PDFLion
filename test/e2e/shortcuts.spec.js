/**
 * The menu's shortcuts for PDFLion's own commands, which pdf.js mustn't act
 * on as well.
 *
 * Electron hands the native menu the keys the page leaves unhandled. A key
 * sent with webContents.sendInputEvent() reaches the menu that way on Windows
 * and Linux, but never on macOS. So pressShortcut() presses a key in the page
 * and checks that the page left it to the menu. On macOS it then checks that
 * the page acted on nothing, and clicks the one menu item with that
 * accelerator, as Electron would.
 */
import { clickMenu, expect, homePage, isEdited, tempDir, test, tracemonkey } from "./pdflion.js";

/** @typedef {import("./pdflion.js").ElectronApplication} ElectronApplication */
/** @typedef {import("./pdflion.js").Page} Page */

const isMac = process.platform === "darwin";

/** The shortcuts, as Electron's accelerators. */
const SHORTCUTS = isMac
  ? {
      insertBlankPage: "Shift+Cmd+N",
      pageOverview: "Alt+Cmd+6",
      eraser: "Shift+Cmd+E",
      home: "Shift+Cmd+H",
    }
  : {
      insertBlankPage: "Shift+Ctrl+N",
      pageOverview: "Shift+Ctrl+O",
      eraser: "Shift+Ctrl+E",
      home: "Shift+Ctrl+H",
    };

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
 * Presses a shortcut in a tab's page, and checks that the page leaves it to
 * the menu, whose one item with that accelerator then acts once.
 *
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {string} accelerator
 * @returns {Promise<string>} the menu item's id
 */
async function pressShortcut(app, page, accelerator) {
  const key = keyOf(accelerator);
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
  const [id] = matching;
  // Counts the item's clicks, the menu's own and clickMenu()'s alike.
  await app.evaluate(({ Menu }, id) => {
    const item = /** @type {Electron.MenuItem} */ (Menu.getApplicationMenu()?.getMenuItemById(id));
    /** @type {Map<Electron.MenuItem, number>} */
    const clicks = (/** @type {any} */ (globalThis).menuClicks ??= new Map());
    if (!clicks.has(item)) {
      const { click } = item;
      item.click = (...args) => {
        clicks.set(item, (clicks.get(item) ?? 0) + 1);
        return click.apply(item, args);
      };
    }
    clicks.set(item, 0);
  }, id);
  const clicks = () =>
    app.evaluate(({ Menu }, id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      return /** @type {any} */ (globalThis).menuClicks.get(item);
    }, id);

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
  if (isMac) {
    expect(await viewerState(page), `nothing acts on ${accelerator} in the page`).toEqual(before);
    await clickMenu(app, page, id);
  }
  await expect.poll(clicks, { message: `the menu acts on ${accelerator}` }).toBe(1);
  return id;
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
    // The document is edited once it has reopened with the page.
    await expect.poll(() => isEdited(app, page)).toBe(true);
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

  // Last, since Home then takes the window.
  await test.step("Home", async () => {
    expect(await pressShortcut(app, page, SHORTCUTS.home)).toBe("home");
    await homePage(app);
  });

  // A second blank page would have come by now.
  expect((await state()).pages).toBe(15);
});
