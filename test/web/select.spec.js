/**
 * The pages' own menu in the web app, which a long press opens, as iPadOS
 * sends no contextmenu event, and whose Paste reads the clipboard.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  TRACEMONKEY,
  documentFrame,
  drawStroke,
  expect,
  openAppExplained,
  openFromHome,
  test,
} from "./pdflion.js";
import { FIRST_PAGE, dispatch } from "./input.js";

/** @typedef {import("./pdflion.js").Frame} Frame */

const NAME = "compressed.tracemonkey-pldi-09.pdf";

/** A 1 × 1 red PNG. */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * @param {Frame} frame
 * @returns {Promise<{ type: string, selected: boolean, middle: number[] }[]>}
 *   the first page's editors, with their middles in the window
 */
const editors = (frame) =>
  frame.evaluate(() => {
    const ui = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
    return [...ui.getEditors(0)].map((/** @type {any} */ editor) => {
      const { left, top, width, height } = editor.div.getBoundingClientRect();
      return {
        type: editor.editorType,
        selected: editor.isSelected,
        middle: [left + width / 2, top + height / 2],
      };
    });
  });

/**
 * Has the viewer's clipboard hold a 40 × 20 pixel red PNG, as the system's
 * would. Its read() is stubbed on the prototype, since the test's browsers
 * don't let a page read the system's.
 *
 * @param {Frame} frame
 */
const clipboardWithImage = (frame) =>
  frame.evaluate(async () => {
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [40, 20];
    const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    context.fillStyle = "red";
    context.fillRect(0, 0, 40, 20);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    Clipboard.prototype.read = async () => [new ClipboardItem({ "image/png": png })];
  });

test("a long press on a page opens its menu, whose Paste puts an image there", async ({ page }) => {
  await openAppExplained(page);
  await openFromHome(page, [TRACEMONKEY]);
  const frame = await documentFrame(page, NAME);
  // Where the select tool presses anything, text too.
  await frame.locator("#pdflionEditorSelectButton").click();
  await clipboardWithImage(frame);

  // Where the long press is, as the menu's event says.
  await frame.evaluate(() => {
    document.addEventListener("contextmenu", ({ clientX, clientY }) => {
      /** @type {any} */ (window).pressedAt = [clientX, clientY];
    });
  });
  const finger = { pointerType: /** @type {const} */ ("touch"), pointerId: 21 };
  await dispatch(frame, FIRST_PAGE, [
    { ...finger, type: "pointerdown", at: [0.6, 0.6] },
    { ...finger, type: "pointerup", at: [0.6, 0.6], wait: 700 },
  ]);
  const menu = frame.locator("#pdflionPageMenu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Cut",
    "Copy",
    "Paste",
    "Delete",
    "Add Image from File…",
  ]);
  await expect(menu.getByRole("menuitem", { name: "Cut" })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
  const at = await frame.evaluate(() => /** @type {any} */ (window).pressedAt);

  await menu.getByRole("menuitem", { name: "Paste" }).click();
  await expect(menu).toBeHidden();
  await expect.poll(async () => (await editors(frame)).map(({ type }) => type)).toEqual(["stamp"]);
  // Centred where the menu opened, once loaded, selected in the select tool,
  // where it can be resized.
  await expect
    .poll(async () => {
      const [{ middle }] = await editors(frame);
      return Math.max(Math.abs(middle[0] - at[0]), Math.abs(middle[1] - at[1]));
    })
    .toBeLessThan(3);
  await expect.poll(async () => (await editors(frame))[0].selected).toBe(true);
  await expect(frame.locator("#pdflionEditorSelectButton")).toHaveAttribute("aria-pressed", "true");
});

test("Add Image from File… in the page's menu opens a file picker in the tap, and adds the image", async ({
  page,
  dir,
}) => {
  await openAppExplained(page);
  await openFromHome(page, [TRACEMONKEY]);
  const frame = await documentFrame(page, NAME);
  await expect(frame.locator("#editorStamp")).toBeHidden();
  await frame.locator("#pdflionEditorSelectButton").click();
  const image = path.join(dir, "red.png");
  await fs.writeFile(image, RED_PNG);

  const finger = { pointerType: /** @type {const} */ ("touch"), pointerId: 21 };
  await dispatch(frame, FIRST_PAGE, [
    { ...finger, type: "pointerdown", at: [0.4, 0.5] },
    { ...finger, type: "pointerup", at: [0.4, 0.5], wait: 700 },
  ]);
  const choosing = page.waitForEvent("filechooser");
  await frame.locator("#pdflionPageMenu").getByRole("menuitem", { name: "Add Image from File…" }).click();
  await (await choosing).setFiles(image);
  await expect.poll(async () => (await editors(frame)).map(({ type }) => type)).toEqual(["stamp"]);
  await expect.poll(async () => (await editors(frame))[0].selected).toBe(true);
});

test("the page's own menu deletes what the select tool has selected, and Esc closes it", async ({
  page,
}) => {
  await openAppExplained(page);
  await openFromHome(page, [TRACEMONKEY]);
  const frame = await documentFrame(page, NAME);
  await drawStroke(page, frame);
  await frame.locator("#pdflionEditorSelectButton").click();
  await expect.poll(async () => (await editors(frame)).length).toBe(1);
  const [{ middle }] = await editors(frame);

  // A right click on the drawing selects it.
  await page.mouse.click(...(await inPage(frame, middle)), { button: "right" });
  const menu = frame.locator("#pdflionPageMenu");
  await expect(menu).toBeVisible();
  expect((await editors(frame))[0].selected).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await page.mouse.click(...(await inPage(frame, middle)), { button: "right" });
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(async () => (await editors(frame)).length).toBe(0);
});

/**
 * @param {Frame} frame
 * @param {number[]} point in the frame
 * @returns {Promise<[number, number]>} that point in the page, which
 *   Playwright's mouse takes
 */
async function inPage(frame, [x, y]) {
  const box = await frame.frameElement().then((element) => element.boundingBox());
  if (!box) throw new Error("No frame");
  return [box.x + x, box.y + y];
}
