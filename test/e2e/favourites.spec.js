import fs from "node:fs/promises";
import path from "node:path";
import {
  answerMessages,
  clickMenu,
  documentPage,
  expect,
  openFile,
  rendered,
  setWidth,
  tempDir,
  test,
  tracemonkey,
  windowCount,
} from "./pdflion.js";

/** @typedef {import("./pdflion.js").Page} Page */

const pencil = { tool: "ink", color: "#1e66f5", thickness: 1, opacity: 1 };
const text = { tool: "freetext", color: "#000000", size: 10 };

/** @param {Page} page */
const toolSettings = (page) => page.evaluate(() => window.pdflion.getToolSettings());

/**
 * @param {Page} page
 * @param {unknown} changes
 */
const setToolSettings = (page, changes) =>
  page.evaluate((changes) => window.pdflion.setToolSettings(changes), changes);

/**
 * Keeps what the page hears of changed tool settings, for heard().
 * @param {Page} page
 */
const listen = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.heard = [];
    window.pdflion.onToolSettingsChange((settings) => w.heard.push(settings));
  });

/** @param {Page} page */
const heard = (page) => page.evaluate(() => /** @type {any} */ (window).heard);

test("tool settings reach every tab, and last until the next launch", async ({ pdflion }) => {
  const dir = await tempDir();
  const [first, second] = [await tracemonkey(dir, "first.pdf"), await tracemonkey(dir, "second.pdf")];
  const { app, page, userData } = await pdflion([first]);
  expect(await toolSettings(page)).toEqual({
    eraser: { mode: "object", size: 10 },
    penOnly: false,
    favourites: [],
  });

  await openFile(app, second);
  const other = await documentPage(app, "second.pdf");
  await rendered(other);
  await clickMenu(app, other, "moveTabToNewWindow");
  await expect.poll(() => windowCount(app)).toBe(2);
  await listen(page);
  await listen(other);

  const settings = {
    eraser: { mode: "line", size: 20 },
    penOnly: true,
    favourites: [pencil, text],
  };
  await setToolSettings(page, settings);
  await expect.poll(() => heard(other)).toEqual([settings]);
  expect(await heard(page)).toEqual([settings]);
  expect(await toolSettings(other)).toEqual(settings);

  // Each part on its own leaves the other.
  await setToolSettings(other, { favourites: [text] });
  await expect.poll(() => toolSettings(page)).toEqual({ ...settings, favourites: [text] });

  const stateFile = path.join(userData, "state.json");
  await expect
    .poll(async () => JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "{}")).favourites)
    .toEqual([text]);
  await app.close();

  const { page: relaunched } = await pdflion([first], { userData });
  expect(await toolSettings(relaunched)).toEqual({ ...settings, favourites: [text] });
});

test("Save as Favourite keeps each drawing tool's settings, once, for every tab", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const [first, second] = [await tracemonkey(dir, "first.pdf"), await tracemonkey(dir, "second.pdf")];
  const { app, page } = await pdflion([first]);
  await rendered(page);

  await page.locator("#editorInkButton").click();
  await page.locator("#editorInkColor").fill("#1e66f5");
  await page.locator("#editorInkThickness").fill("5");
  await page.locator("#editorInkOpacity").fill("0.35");
  const saveInk = page.locator("#pdflionSaveInkFavourite");
  await expect(saveInk).toHaveText("Save as Favourite");
  await saveInk.click();
  await expect(saveInk).toHaveText("Saved");
  await saveInk.click();
  await expect(saveInk).toHaveText("Already a Favourite");

  await page.locator("#editorFreeTextButton").click();
  await page.locator("#editorFreeTextColor").fill("#e64553");
  await page.locator("#editorFreeTextFontSize").fill("24");
  await page.locator("#pdflionSaveFreeTextFavourite").click();

  await page.locator("#editorHighlightButton").click();
  await page.locator('#editorHighlightColorPicker [data-color="#53FFBC"]').click();
  await page.locator("#editorFreeHighlightThickness").fill("16");
  await page.locator("#pdflionSaveHighlightFavourite").click();

  await expect
    .poll(async () => (await toolSettings(page)).favourites)
    .toEqual([
      { tool: "ink", color: "#1e66f5", thickness: 5, opacity: 0.35 },
      { tool: "freetext", color: "#e64553", size: 24 },
      { tool: "highlight", color: "#53ffbc", thickness: 16 },
    ]);
  await expect(saveInk).toHaveText("Save as Favourite");

  // A tab opened later knows them, and one open already hears of new ones.
  await openFile(app, second);
  const other = await documentPage(app, "second.pdf");
  await rendered(other);
  await other.locator("#editorFreeTextButton").click();
  await other.locator("#editorFreeTextColor").fill("#e64553");
  await other.locator("#editorFreeTextFontSize").fill("24");
  const otherSaveText = other.locator("#pdflionSaveFreeTextFavourite");
  await otherSaveText.click();
  await expect(otherSaveText).toHaveText("Already a Favourite");
  await other.locator("#editorFreeTextFontSize").fill("48");
  await otherSaveText.click();
  await expect(otherSaveText).toHaveText("Saved");

  await clickMenu(app, other, "previousTab");
  await page.locator("#editorFreeTextButton").click();
  await page.locator("#editorFreeTextFontSize").fill("48");
  const saveText = page.locator("#pdflionSaveFreeTextFavourite");
  await saveText.click();
  await expect(saveText).toHaveText("Already a Favourite");
  expect((await toolSettings(page)).favourites).toHaveLength(4);
});

/**
 * @param {Page} page
 * @returns {import("@playwright/test").Locator} the favourites' buttons in the toolbar
 */
const toolbarFavourites = (page) => page.locator("#pdflionFavourites > .pdflionFavourite");

/**
 * Draws a line across the middle of the first page with the tool that's on,
 * and ends the drawing.
 *
 * @param {Page} page
 */
async function drawLine(page) {
  const box = await page.locator('.page[data-page-number="1"]').boundingBox();
  if (!box) throw new Error("The first page isn't shown");
  const y = box.y + box.height / 3;
  await page.mouse.move(box.x + box.width / 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

/**
 * @param {Page} page
 * @returns {Promise<{ color: number[], thickness: number, opacity: number }[]>}
 *   the first page's Pencil drawings
 */
const inkDrawings = (page) =>
  page.evaluate(() =>
    [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)]
      .filter((editor) => editor.editorType === "ink")
      .map((editor) => {
        const { color, thickness, opacity } = editor.serialize(true);
        return { color: [...color], thickness, opacity };
      }),
  );

test("a favourite shows in every window's toolbar, draws with its settings, and lasts until removed", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const [first, second] = [await tracemonkey(dir, "first.pdf"), await tracemonkey(dir, "second.pdf")];
  const { app, page, userData } = await pdflion([first]);
  await openFile(app, second);
  const other = await documentPage(app, "second.pdf");
  await rendered(other);
  await clickMenu(app, other, "moveTabToNewWindow");
  await expect.poll(() => windowCount(app)).toBe(2);
  // Wide enough for the favourite's button.
  for (const each of [page, other]) await setWidth(app, each, 1400);
  await expect(page.locator("#pdflionFavourites")).toBeHidden();
  await expect(page.locator("#pdflionFavouritesSeparator")).toBeHidden();

  await page.locator("#editorInkButton").click();
  await page.locator("#editorInkColor").fill("#1e66f5");
  await page.locator("#editorInkThickness").fill("5");
  await page.locator("#editorInkOpacity").fill("0.35");
  await page.locator("#pdflionSaveInkFavourite").click();
  await expect(toolbarFavourites(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pdflionFavouritesSeparator")).toBeVisible();

  // The other window shows it, and uses it.
  const favourite = toolbarFavourites(other);
  await expect(favourite).toHaveCount(1);
  await expect(favourite).toHaveAttribute("title", "Pencil, #1E66F5, 5 pt, 35 %");
  await expect(favourite).toHaveAttribute("aria-pressed", "false");
  await favourite.click();
  // Pencil is on, with its option box closed, since the favourite chose its settings.
  await expect(other.locator("#editorInkButton")).toHaveClass(/toggled/);
  await expect(other.locator("#editorInkParamsToolbar")).toBeHidden();
  await expect(other.locator("#editorInkColor")).toHaveValue("#1e66f5");
  await expect(other.locator("#editorInkThickness")).toHaveValue("5");
  await expect(other.locator("#editorInkOpacity")).toHaveValue("0.35");
  await expect(favourite).toHaveAttribute("aria-pressed", "true");
  await drawLine(other);
  expect(await inkDrawings(other)).toEqual([{ color: [30, 102, 245], thickness: 5, opacity: 0.35 }]);
  // Pencil off and on again opens its box, with the favourite's settings.
  await other.locator("#editorInkButton").click();
  await other.locator("#editorInkButton").click();
  await expect(other.locator("#editorInkThickness")).toHaveValue("5");
  await other.locator("#editorInkThickness").fill("6");
  await expect(favourite).toHaveAttribute("aria-pressed", "false");
  // The line drawn is an unsaved change, which quitting would ask about.
  await answerMessages(app, "Don’t Save");
  await app.close();

  const { app: relaunched, page: again } = await pdflion([first], { userData });
  await setWidth(relaunched, again, 1400);
  const kept = toolbarFavourites(again);
  await expect(kept).toHaveCount(1);
  await relaunched.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      /** @type {any} */ (globalThis).contextMenu = this;
    };
  });
  await kept.click({ button: "right" });
  await expect
    .poll(() => relaunched.evaluate(() => /** @type {any} */ (globalThis).contextMenu?.items[0].label))
    .toBe("Remove Favourite");
  await relaunched.evaluate(() => /** @type {any} */ (globalThis).contextMenu.items[0].click());
  await expect(kept).toHaveCount(0);
  await expect(again.locator("#pdflionFavourites")).toBeHidden();
});

test("favourites that don't fit move into the ★ menu, which works with the mouse and the keys", async ({
  pdflion,
}) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  const black = { ...pencil, color: "#000000" };
  const red = { tool: "freetext", color: "#e64553", size: 24 };
  const highlight = { tool: "highlight", color: "#53ffbc", thickness: 16 };
  await setToolSettings(page, { favourites: [pencil, red, highlight, black] });
  const more = page.locator("#pdflionFavouritesMoreButton");
  const items = page.locator("#pdflionFavouritesMenu .pdflionFavourite");

  /**
   * @returns {Promise<{ inToolbar: boolean[], inMenu: boolean[], more: boolean, compact: boolean }>}
   *   which favourites show in the toolbar and the menu, whether the ★ button
   *   does, and whether the toolbar has its 32 px buttons
   */
  const layout = () =>
    page.evaluate(() => {
      const shown = (/** @type {string} */ selector) =>
        [...document.querySelectorAll(selector)].map(
          (element) => !(/** @type {HTMLElement} */ (element).hidden),
        );
      const container = /** @type {HTMLElement} */ (document.getElementById("toolbarContainer"));
      return {
        inToolbar: shown("#pdflionFavourites > .pdflionFavourite"),
        inMenu: shown("#pdflionFavouritesMenu .pdflionFavourite"),
        more: !(/** @type {HTMLElement} */ (document.getElementById("pdflionFavouritesMore")).hidden),
        compact: container.classList.contains("pdflionToolbarCompact"),
      };
    });

  // Wide, all fit.
  await setWidth(app, page, 1400);
  expect(await layout()).toEqual({
    inToolbar: [true, true, true, true],
    inMenu: [false, false, false, false],
    more: false,
    compact: false,
  });

  // Narrower, the toolbar gives up its 40 px buttons first, then the last
  // favourites, which go into the menu. toolbar.spec.js checks that it fits.
  let width = 1400;
  let narrower = await layout();
  while (!narrower.more && width > 760) {
    await setWidth(app, page, (width -= 10));
    narrower = await layout();
  }
  const kept = narrower.inToolbar.indexOf(false);
  expect(kept).toBeGreaterThan(0);
  expect(narrower.inToolbar.slice(kept)).toEqual(narrower.inToolbar.slice(kept).map(() => false));
  expect(narrower.inMenu).toEqual(narrower.inToolbar.map((shown) => !shown));
  expect(narrower.compact).toBe(true);

  // In pdf.js's medium view, all are in the menu.
  await setWidth(app, page, 700);
  expect(await layout()).toMatchObject({
    inToolbar: [false, false, false, false],
    inMenu: [true, true, true, true],
    more: true,
  });

  await more.click();
  await expect(page.locator("#pdflionFavouritesMenu")).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await items.nth(1).click();
  await expect(page.locator("#pdflionFavouritesMenu")).toBeHidden();
  await expect(page.locator("#editorFreeTextButton")).toHaveClass(/toggled/);
  await expect(page.locator("#editorFreeTextParamsToolbar")).toBeHidden();
  await expect(page.locator("#editorFreeTextColor")).toHaveValue("#e64553");
  await expect(page.locator("#editorFreeTextFontSize")).toHaveValue("24");
  await expect(items.nth(1)).toHaveAttribute("aria-checked", "true");

  // With the keys, as pdf.js's menus.
  await more.focus();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("h");
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#pdflionFavouritesMenu")).toBeHidden();
  await expect(more).toBeFocused();
  await expect(page.locator("#editorInkButton")).toHaveClass(/toggled/);
  await expect(page.locator("#editorInkColor")).toHaveValue("#000000");

  await page.keyboard.press("Enter");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#pdflionFavouritesMenu")).toBeHidden();
  await expect(more).toBeFocused();

  // A press elsewhere closes it.
  await more.click();
  await expect(page.locator("#pdflionFavouritesMenu")).toBeVisible();
  await page.mouse.click(10, 300);
  await expect(page.locator("#pdflionFavouritesMenu")).toBeHidden();

  // Wide again, they're back in the toolbar.
  await setWidth(app, page, 1400);
  await expect.poll(async () => (await layout()).more).toBe(false);
});

test("favourites move when dragged onto another, in the toolbar and in the ★ menu", async ({
  pdflion,
}) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  const red = { tool: "freetext", color: "#e64553", size: 24 };
  const highlight = { tool: "highlight", color: "#53ffbc", thickness: 16 };
  await setToolSettings(page, { favourites: [pencil, red, highlight] });
  await setWidth(app, page, 1400);
  const buttons = toolbarFavourites(page);
  await expect(buttons).toHaveCount(3);
  const favourites = async () => (await toolSettings(page)).favourites;

  // Onto the far half of the third: after it.
  await buttons.nth(0).dragTo(buttons.nth(2), { targetPosition: { x: 30, y: 20 } });
  await expect.poll(favourites).toEqual([red, highlight, pencil]);
  await expect(buttons.nth(2)).toHaveAttribute("title", "Pencil, #1E66F5, 1 pt, 100 %");
  // Onto the near half of the first: before it.
  await buttons.nth(2).dragTo(buttons.nth(0), { targetPosition: { x: 10, y: 20 } });
  await expect.poll(favourites).toEqual([pencil, red, highlight]);
  await expect(page.locator(".pdflionDropBefore, .pdflionDropAfter, .pdflionDragged")).toHaveCount(0);

  // Down the ★ menu, in pdf.js's medium view, where all are in it.
  await setWidth(app, page, 700);
  await page.locator("#pdflionFavouritesMoreButton").click();
  const items = page.locator("#pdflionFavouritesMenu .pdflionFavourite");
  await expect(items.nth(2)).toBeVisible();
  const { height } = /** @type {{ height: number }} */ (await items.nth(0).boundingBox());
  await items.nth(2).dragTo(items.nth(0), { targetPosition: { x: 20, y: height / 4 } });
  await expect.poll(favourites).toEqual([highlight, pencil, red]);
  await expect(items.nth(0)).toContainText("Highlight, #53FFBC, 16 pt");
});

test("a favourite's context menu removes it", async ({ pdflion }) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      /** @type {any} */ (globalThis).contextMenu = this;
    };
  });
  await setToolSettings(page, { favourites: [pencil, text] });
  await expect.poll(async () => (await toolSettings(page)).favourites).toEqual([pencil, text]);
  await listen(page);

  // Colours compare in any case.
  await page.evaluate((favourite) => window.pdflion.showFavouriteMenu(favourite), {
    ...pencil,
    color: "#1E66F5",
  });
  await expect
    .poll(() =>
      app.evaluate(() =>
        /** @type {any} */ (globalThis).contextMenu?.items.map(
          (/** @type {Electron.MenuItem} */ item) => item.label,
        ),
      ),
    )
    .toEqual(["Remove Favourite"]);
  await app.evaluate(() => /** @type {any} */ (globalThis).contextMenu.items[0].click());
  await expect
    .poll(() => heard(page))
    .toEqual([{ eraser: { mode: "object", size: 10 }, penOnly: false, favourites: [text] }]);
});

test("takes only tool settings that are right, and shows no menu for anything else", async ({
  pdflion,
}) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      /** @type {any} */ (globalThis).menus = (/** @type {any} */ (globalThis).menus ?? 0) + 1;
    };
  });
  const before = await toolSettings(page);
  await listen(page);

  for (const changes of [
    { eraser: { mode: "line", size: 500 } },
    { favourites: [pencil, { ...text, size: "10" }] },
    { favourites: [{ ...pencil, tool: "stamp" }] },
    { eraser: { mode: "line", size: 20 }, theme: "dark" },
    {},
    "favourites",
    null,
  ]) {
    await setToolSettings(page, changes);
  }
  for (const favourite of [{ ...pencil, color: "javascript:alert(1)" }, "Remove Favourite", null]) {
    await page.evaluate((favourite) => window.pdflion.showFavouriteMenu(favourite), favourite);
  }
  // A last good change, which arrives after the others.
  await setToolSettings(page, { favourites: [text] });
  await expect.poll(() => heard(page)).toEqual([{ ...before, favourites: [text] }]);
  expect(await app.evaluate(() => /** @type {any} */ (globalThis).menus)).toBeUndefined();
});
