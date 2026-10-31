/**
 * Home: the recent documents, Open and New, and where Home shows. Home's
 * documents come from main by their recent ids. A document opened from Home
 * takes the home tab's place.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  answerMessages,
  clickMenu,
  documentPage,
  documentPages,
  expect,
  homePage,
  homePages,
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

/** @typedef {import("./pdflion.js").ElectronApplication} ElectronApplication */
/** @typedef {import("./pdflion.js").Page} Page */

/** The context menu's item that shows the file where it is. */
const SHOW_IN_FOLDER =
  process.platform === "darwin"
    ? "Show in Finder"
    : process.platform === "win32"
      ? "Show in Explorer"
      : "Show in Files";

/**
 * @param {Page} home
 * @returns {Promise<{ id: string, name: string, open: boolean, missing: boolean, thumbnail: boolean }[]>}
 *   the cards Home shows, in order
 */
const cards = (home) =>
  home.locator(".card").evaluateAll((buttons) =>
    buttons.map((button) => ({
      id: /** @type {HTMLElement} */ (button).dataset.id ?? "",
      name: button.querySelector(".name")?.textContent ?? "",
      open: button.querySelector(".mark:not(.missing)") !== null,
      missing: button.classList.contains("missing"),
      thumbnail:
        (/** @type {HTMLImageElement | null} */ (button.querySelector("img"))?.naturalWidth ?? 0) > 0,
    })),
  );

/**
 * @param {string} userData
 * @returns {Promise<string[]>} the thumbnails main keeps
 */
const thumbnailFiles = async (userData) =>
  (await fs.readdir(path.join(userData, "thumbnails")).catch(() => [])).sort();

/**
 * Closes a document's tab with its close button in the strip, rather than
 * File > Close Tab, which closes the active tab.
 *
 * @param {ElectronApplication} app
 * @param {Page} page the document's
 */
async function closeTab(app, page) {
  const strip = await stripOf(app, page);
  const file = new URL(page.url()).searchParams.get("file") ?? "";
  const name = decodeURIComponent(file.split("/").pop() ?? "");
  const closed = page.waitForEvent("close");
  await strip.locator(".tab", { hasText: name }).locator(".close").click({ force: true });
  await closed;
}

/**
 * Opens documents one after the other, each once the last has shown, since a
 * tab that isn't shown doesn't render, and makes no thumbnail.
 *
 * @param {ElectronApplication} app
 * @param {string[]} files
 */
async function openEach(app, files) {
  for (const file of files) {
    await openFile(app, file);
    await rendered(await documentPage(app, path.basename(file)));
  }
}

/**
 * Has main record the context menus it shows, rather than show them.
 *
 * @param {ElectronApplication} app
 */
const recordContextMenus = (app) =>
  app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      /** @type {any} */ (globalThis).contextMenu = this;
    };
  });

/**
 * @param {ElectronApplication} app
 * @returns {Promise<string[]>} the labels of the last context menu
 */
const contextMenuLabels = (app) =>
  app.evaluate(() => /** @type {any} */ (globalThis).contextMenu?.items.map((item) => item.label));

/**
 * @param {ElectronApplication} app
 * @param {string} label
 */
const clickContextMenu = (app, label) =>
  app.evaluate((_electron, label) => {
    /** @type {any} */ (globalThis).contextMenu.items.find((item) => item.label === label).click();
  }, label);

test("a launch without a document shows Home, in a window titled PDFLion", async ({ pdflion }) => {
  const { app, page: home } = await pdflion([]);
  await expect(home.locator("#empty")).toBeVisible();
  await expect(home.locator("#empty .message")).toHaveText("No recent documents");
  await expect(home.locator("#empty .open")).toBeVisible();
  await expect(home.locator("#empty .new")).toBeVisible();
  expect(await windowTitle(app, home)).toBe("PDFLion");
  expect(await stripTabs(await stripOf(app, home))).toMatchObject([{ name: "Home", active: true }]);
  expect(await home.evaluate(() => typeof window.pdflionHome)).toBe("object");
});

test("lists the documents opened, newest first, with their thumbnails", async ({ pdflion }) => {
  const dir = await tempDir();
  const first = await tracemonkey(dir, "first.pdf");
  const second = await tracemonkey(dir, "second.pdf");
  const { app, page: home, userData } = await pdflion([]);

  // The first document takes Home's place, as it's the active tab.
  await openFile(app, first);
  const firstPage = await documentPage(app, "first.pdf");
  await rendered(firstPage);
  await expect.poll(() => homePages(app).length).toBe(0);
  await openFile(app, second);
  const secondPage = await documentPage(app, "second.pdf");
  await rendered(secondPage);
  expect(documentPages(app)).toHaveLength(2);
  await expect.poll(() => thumbnailFiles(userData)).toHaveLength(2);

  await clickMenu(app, secondPage, "home");
  const again = await homePage(app, [home]);
  await expect
    .poll(() => cards(again))
    .toMatchObject([
      { name: "second.pdf", open: true, missing: false, thumbnail: true },
      { name: "first.pdf", open: true, missing: false, thumbnail: true },
    ]);
  // After the active tab.
  expect((await stripTabs(await stripOf(app, again))).map(({ name }) => name)).toEqual([
    "first.pdf",
    "second.pdf",
    "Home",
  ]);
  expect(await windowTitle(app, again)).toBe("PDFLion");

  // A closed document isn't open any more.
  await closeTab(app, firstPage);
  await expect.poll(() => cards(again)).toMatchObject([{ open: true }, { open: false }]);
});

test("a card opens its document in Home's place, or shows its tab if it's open", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const { app, page: first } = await pdflion([await tracemonkey(dir, "first.pdf")]);
  await clickMenu(app, first, "home");
  const home = await homePage(app);

  // Open: its tab is shown, and Home stays.
  await home.locator(".card").first().click();
  const strip = await stripOf(app, home);
  await expect
    .poll(() => stripTabs(strip))
    .toMatchObject([
      { name: "first.pdf", active: true },
      { name: "Home", active: false },
    ]);

  // Closed: it opens in Home's place.
  await closeTab(app, first);
  await home.locator(".card").first().click();
  await rendered(await documentPage(app, "first.pdf"));
  await expect.poll(() => homePages(app).length).toBe(0);
  expect(await windowCount(app)).toBe(1);
});

test("a document whose file is gone shows as missing, and can be removed", async ({ pdflion }) => {
  const dir = await tempDir();
  const file = await tracemonkey(dir, "gone.pdf");
  const { app, page } = await pdflion([file]);
  await clickMenu(app, page, "home");
  const home = await homePage(app);
  await closeTab(app, page);
  await fs.rm(file);
  // Selecting Home again has main send the list afresh.
  await clickMenu(app, home, "home");
  await expect.poll(() => cards(home)).toMatchObject([{ name: "gone.pdf", missing: true }]);

  await answerMessages(app, "Remove");
  await home.locator(".card").first().click();
  await expect.poll(() => cards(home)).toEqual([]);
  expect(await app.evaluate(() => /** @type {any} */ (globalThis).messages)).toEqual([
    "The file “gone.pdf” couldn’t be opened because there is no such file.",
  ]);
  await expect(home.locator("#empty")).toBeVisible();
});

test("New and Open… open in Home's place", async ({ pdflion }) => {
  const dir = await tempDir();
  const picked = await tracemonkey(dir, "picked.pdf");
  const { app, page: home } = await pdflion([]);
  await home.locator("#empty .new").click();
  const untitled = await documentPage(app, "Untitled.pdf");
  await rendered(untitled);
  await expect.poll(() => homePages(app).length).toBe(0);

  await clickMenu(app, untitled, "home");
  const again = await homePage(app, [home]);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, picked);
  // An untitled document isn't a recent one, so Home is still empty.
  await again.locator("#empty .open").click();
  await rendered(await documentPage(app, "picked.pdf"));
  await expect.poll(() => homePages(app).length).toBe(0);
  expect((await stripTabs(await stripOf(app, untitled))).map(({ name }) => name)).toEqual([
    "Untitled.pdf",
    "picked.pdf",
  ]);
});

test("a PDF dropped on Home opens in its place", async ({ pdflion }) => {
  const file = await tracemonkey(await tempDir(), "dropped.pdf");
  const { app, page: home } = await pdflion([]);
  // A real drop of a file, so the preload gets its path.
  const cdp = await home.context().newCDPSession(home);
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", { type, x: 300, y: 300, data });
  }
  await rendered(await documentPage(app, "dropped.pdf"));
  await expect.poll(() => homePages(app).length).toBe(0);
});

test("the context menu and Delete remove a document, Clear all, with their thumbnails", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const [a, b, c] = ["a.pdf", "b.pdf", "c.pdf"].map((name) => path.join(dir, name));
  for (const file of [a, b, c]) await tracemonkey(dir, path.basename(file));
  const { app, page, userData } = await pdflion([a]);
  await openEach(app, [b, c]);
  await expect.poll(() => thumbnailFiles(userData)).toHaveLength(3);
  await clickMenu(app, page, "home");
  const home = await homePage(app);
  await expect.poll(() => cards(home)).toHaveLength(3);
  const [third, second] = await cards(home);
  expect([third.name, second.name]).toEqual(["c.pdf", "b.pdf"]);

  await recordContextMenus(app);
  await home.locator(".card").first().click({ button: "right" });
  await expect
    .poll(() => contextMenuLabels(app))
    .toEqual(["Open", SHOW_IN_FOLDER, "", "Remove from Recent"]);
  await clickContextMenu(app, "Remove from Recent");
  const names = async () => (await cards(home)).map(({ name }) => name);
  await expect.poll(names).toEqual(["b.pdf", "a.pdf"]);
  await expect.poll(() => thumbnailFiles(userData)).not.toContain(`${third.id}.png`);

  // Delete takes the focused card off, and the next one gets the keyboard.
  await home.locator(".card").first().focus();
  await home.keyboard.press("Delete");
  await expect.poll(names).toEqual(["a.pdf"]);
  const focused = () => home.evaluate(() => document.activeElement?.textContent);
  await expect.poll(focused).toContain("a.pdf");
  expect(await thumbnailFiles(userData)).not.toContain(`${second.id}.png`);

  await home.locator("#clear").click();
  await expect(home.locator("#empty")).toBeVisible();
  await expect.poll(() => thumbnailFiles(userData)).toEqual([]);
  // state.js writes a moment later.
  const stored = async () =>
    JSON.parse(await fs.readFile(path.join(userData, "state.json"), "utf8")).recent;
  await expect.poll(stored).toEqual([]);
});

test("the arrow keys move through the cards, and Return opens one", async ({ pdflion }) => {
  const dir = await tempDir();
  const { app, page } = await pdflion([await tracemonkey(dir, "a.pdf")]);
  await openEach(app, [await tracemonkey(dir, "b.pdf"), await tracemonkey(dir, "c.pdf")]);
  await clickMenu(app, page, "home");
  const home = await homePage(app);
  await expect.poll(() => cards(home)).toHaveLength(3);
  const focused = () =>
    home.evaluate(() => document.activeElement?.querySelector(".name")?.textContent ?? null);

  // Tab reaches the first card, and only one card.
  expect(await home.locator('.card[tabindex="0"] .name').allTextContents()).toEqual(["c.pdf"]);
  await home.locator(".card").first().focus();
  await home.keyboard.press("ArrowRight");
  expect(await focused()).toBe("b.pdf");
  await home.keyboard.press("End");
  expect(await focused()).toBe("a.pdf");
  await home.keyboard.press("ArrowLeft");
  expect(await focused()).toBe("b.pdf");
  await home.keyboard.press("Home");
  expect(await focused()).toBe("c.pdf");
  expect(await home.locator('.card[tabindex="0"] .name').allTextContents()).toEqual(["c.pdf"]);

  // b.pdf is open, so Return shows its tab, and Home stays.
  await home.keyboard.press("ArrowRight");
  await home.keyboard.press("Enter");
  const strip = await stripOf(app, home);
  await expect
    .poll(async () => (await stripTabs(strip)).find(({ active }) => active)?.name)
    .toBe("b.pdf");
  expect(homePages(app)).toHaveLength(1);
});

test("File > Home and the Home button show the window's home tab, or add one", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const { app, page } = await pdflion([await tracemonkey(dir, "first.pdf")]);
  const strip = await stripOf(app, page);
  const names = async () =>
    (await stripTabs(strip)).map(({ name, active }) => `${name}${active ? "*" : ""}`);
  const saveEnabled = () =>
    app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("save")?.enabled);

  // The toolbar's button, left of the sidebar's.
  await expect(page.locator("#pdflionHomeButton + #viewsManagerToggleButton")).toHaveCount(1);
  await page.locator("#pdflionHomeButton").click();
  await expect.poll(names).toEqual(["first.pdf", "Home*"]);
  const home = await homePage(app);
  // Menu items for documents don't act on Home.
  await expect.poll(saveEnabled).toBe(false);

  await strip.locator(".tab").first().click();
  await expect.poll(names).toEqual(["first.pdf*", "Home"]);
  await expect.poll(saveEnabled).toBe(true);
  await clickMenu(app, page, "home");
  await expect.poll(names).toEqual(["first.pdf", "Home*"]);
  expect(homePages(app)).toEqual([home]);
});

test("a second launch without documents shows Home in the front window", async ({ pdflion }) => {
  const dir = await tempDir();
  const { app, page } = await pdflion([await tracemonkey(dir, "first.pdf")]);
  // What a second process hands the first on Windows and Linux.
  await app.evaluate(({ app }) => app.emit("second-instance", {}, [], "", { files: [] }));
  await homePage(app);
  expect((await stripTabs(await stripOf(app, page))).map(({ name }) => name)).toEqual([
    "first.pdf",
    "Home",
  ]);
  expect(await windowCount(app)).toBe(1);
});

test("on macOS, the Dock icon shows Home when no window is open", async ({ pdflion }) => {
  test.skip(process.platform !== "darwin", "Windows and Linux quit with their last window");
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  const closed = page.waitForEvent("close");
  await clickMenu(app, page, "closeWindow");
  await closed;
  expect(await windowCount(app)).toBe(0);

  await app.evaluate(({ app }) => app.emit("activate"));
  const home = await homePage(app);
  await expect.poll(() => cards(home)).toMatchObject([{ name: "tracemonkey.pdf", open: false }]);
  expect(await windowCount(app)).toBe(1);
});
