import fs from "node:fs/promises";
import path from "node:path";
import {
  clickMenu,
  documentPage,
  expect,
  openFile,
  rendered,
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
    favourites: [],
  });

  await openFile(app, second);
  const other = await documentPage(app, "second.pdf");
  await rendered(other);
  await clickMenu(app, other, "moveTabToNewWindow");
  await expect.poll(() => windowCount(app)).toBe(2);
  await listen(page);
  await listen(other);

  const settings = { eraser: { mode: "line", size: 20 }, favourites: [pencil, text] };
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
  await expect.poll(() => heard(page)).toEqual([{ eraser: { mode: "object", size: 10 }, favourites: [text] }]);
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
