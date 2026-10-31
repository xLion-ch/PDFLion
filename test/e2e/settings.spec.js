/**
 * File > Export Settings… and Import Settings…, with the dialogs stubbed.
 */
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

/** @typedef {import("./pdflion.js").ElectronApplication} ElectronApplication */
/** @typedef {import("./pdflion.js").Page} Page */

const pencil = { tool: "ink", color: "#1e66f5", thickness: 2, opacity: 1 };
const text = { tool: "freetext", color: "#e64553", size: 24 };
const highlight = { tool: "highlight", color: "#53ffbc", thickness: 16 };

/** The import prompt's buttons in the platform's order. */
const PROMPT_BUTTONS = process.platform === "linux" ? ["Cancel", "Import"] : ["Import", "Cancel"];

/** @param {Page} page */
const toolSettings = (page) => page.evaluate(() => window.pdflion.getToolSettings());

/**
 * @param {Page} page
 * @param {object} settings
 */
const setToolSettings = (page, settings) =>
  page.evaluate((settings) => window.pdflion.setToolSettings(settings), settings);

/**
 * @param {Page} page
 * @returns {Promise<number>} how many favourites the page's toolbar shows
 */
const favouriteButtons = (page) => page.locator("#pdflionFavourites > .pdflionFavourite").count();

/**
 * Replaces Electron's message boxes with one that answers with `button`, or
 * with the only one an alert has, and records each box on
 * `globalThis.boxes` in main.
 *
 * @param {ElectronApplication} app
 * @param {string} button
 */
const answerWith = (app, button) =>
  app.evaluate(({ dialog }, button) => {
    const boxes = /** @type {object[]} */ ((/** @type {any} */ (globalThis).boxes = []));
    dialog.showMessageBox = async (/** @type {any[]} */ ...args) => {
      const { message, detail, buttons = ["OK"] } = args.at(-1);
      boxes.push({ message, detail, buttons });
      return { response: Math.max(0, buttons.indexOf(button)), checkboxChecked: false };
    };
  }, button);

/**
 * @param {ElectronApplication} app
 * @returns {Promise<{ message: string, detail?: string, buttons: string[] }[]>}
 */
const boxes = (app) => app.evaluate(() => /** @type {any} */ (globalThis).boxes);

/**
 * @param {ElectronApplication} app
 * @param {string} file what the save dialog answers
 */
const saveDialogAnswers = (app, file) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);

/**
 * @param {ElectronApplication} app
 * @param {string} file what the open dialog answers
 */
const openDialogAnswers = (app, file) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);

/**
 * @param {string} userData
 * @returns {Promise<Record<string, unknown>>} what state.json holds, which
 *   state.js writes a second after the last change
 */
const storedState = (userData) =>
  fs.readFile(path.join(userData, "state.json"), "utf8").then(JSON.parse, () => ({}));

/**
 * @param {object} settings
 * @returns {string} a settings file of version 1 with `settings`
 */
const settingsFile = (settings) =>
  JSON.stringify({ format: "pdflion-settings", version: 1, ...settings }, null, 2);

test("Export Settings writes the settings to the file the save dialog names", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const { app, page } = await pdflion([await tracemonkey(dir)]);
  await setToolSettings(page, {
    eraser: { mode: "line", size: 20 },
    penOnly: true,
    favourites: [pencil, text],
  });
  await expect.poll(() => toolSettings(page)).toMatchObject({ penOnly: true });

  const file = path.join(dir, "PDFLion Settings.json");
  await saveDialogAnswers(app, file);
  await clickMenu(app, page, "exportSettings");
  const written = () => fs.readFile(file, "utf8").then(JSON.parse, () => null);
  await expect.poll(written).toMatchObject({
    format: "pdflion-settings",
    version: 1,
    exportedBy: { platform: process.platform },
    toolSettings: { eraser: { mode: "line", size: 20 }, penOnly: true },
    favourites: [pencil, text],
    updates: { automatic: true },
  });
  // Not where windows were, nor the recent documents.
  expect(Object.keys(await written()).sort()).toEqual([
    "exportedAt",
    "exportedBy",
    "favourites",
    "format",
    "toolSettings",
    "updates",
    "version",
  ]);
});

test("Import Settings gives every tab of every window the settings, and the new favourites", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const { app, page: first, userData } = await pdflion([await tracemonkey(dir, "first.pdf")]);
  await openFile(app, await tracemonkey(dir, "second.pdf"));
  const second = await documentPage(app, "second.pdf");
  await rendered(second);
  await clickMenu(app, second, "moveTabToNewWindow");
  await expect.poll(() => windowCount(app)).toBe(2);
  await setToolSettings(first, { favourites: [pencil] });
  await expect.poll(() => favouriteButtons(second)).toBe(1);

  const file = path.join(dir, "PDFLion Settings.json");
  await fs.writeFile(
    file,
    settingsFile({
      toolSettings: { eraser: { mode: "line", size: 30 }, penOnly: true, colour: "red" },
      favourites: [pencil, text, { ...highlight, thickness: 99 }, highlight],
      updates: { automatic: false },
      window: { x: 0, y: 0 },
    }),
  );
  await openDialogAnswers(app, file);
  await answerWith(app, "Import");
  await clickMenu(app, first, "importSettings");

  const imported = {
    eraser: { mode: "line", size: 30 },
    penOnly: true,
    favourites: [pencil, text, highlight],
  };
  await expect.poll(() => toolSettings(first)).toEqual(imported);
  expect(await toolSettings(second)).toEqual(imported);
  await expect.poll(() => favouriteButtons(first)).toBe(3);
  await expect.poll(() => favouriteButtons(second)).toBe(3);
  expect(await boxes(app)).toEqual([
    {
      message: "Import the settings from “PDFLion Settings.json”?",
      detail:
        "Your eraser, pen, and update settings are replaced, and its 2 favourites you don’t have yet are added after yours.",
      buttons: PROMPT_BUTTONS,
    },
  ]);
  await expect.poll(() => storedState(userData)).toMatchObject({ updates: { automatic: false } });
});

test("a file that isn't one, a newer one, and Cancel change nothing", async ({ pdflion }) => {
  const dir = await tempDir();
  const { app, page, userData } = await pdflion([await tracemonkey(dir)]);
  await setToolSettings(page, { eraser: { mode: "line", size: 12 }, favourites: [pencil] });
  await expect.poll(() => favouriteButtons(page)).toBe(1);
  const before = await toolSettings(page);
  const file = path.join(dir, "settings.json");

  /**
   * Imports `content`, and answers its box with `button`.
   *
   * @param {string} content
   * @param {string} button
   */
  const importing = async (content, button) => {
    await fs.writeFile(file, content);
    await openDialogAnswers(app, file);
    await answerWith(app, button);
    await clickMenu(app, page, "importSettings");
    await expect.poll(() => boxes(app)).toHaveLength(1);
    return (await boxes(app))[0];
  };

  const refused = "The settings in “settings.json” couldn’t be imported.";
  const notSettings = "It isn’t a PDFLion settings file.";
  const newer = "They come from a newer version of PDFLion. Update PDFLion, and try again.";
  const tooLarge = "The file is larger than a settings file can be.";
  for (const [content, detail] of [
    ["{ format: pdflion-settings", notSettings],
    [JSON.stringify({ format: "pdflion-backup", version: 1, favourites: [text] }), notSettings],
    [settingsFile({ version: 2, favourites: [text] }), newer],
    [settingsFile({ favourites: [text], padding: "x".repeat(1024 * 1024) }), tooLarge],
  ]) {
    expect(await importing(content, "OK")).toEqual({ message: refused, detail, buttons: ["OK"] });
  }

  // Nothing new.
  expect(await importing(settingsFile({ favourites: [pencil] }), "OK")).toMatchObject({
    message: "There’s nothing to import from “settings.json”.",
  });

  // Cancel at the prompt.
  const good = settingsFile({
    toolSettings: { eraser: { mode: "object", size: 40 } },
    favourites: [text],
    updates: { automatic: false },
  });
  expect(await importing(good, "Cancel")).toMatchObject({
    message: "Import the settings from “settings.json”?",
  });

  // Longer than state.js waits before it writes.
  await page.waitForTimeout(1500);
  expect(await toolSettings(page)).toEqual(before);
  expect(await favouriteButtons(page)).toBe(1);
  expect((await storedState(userData)).updates).toBeUndefined();
});
