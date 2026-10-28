import path from "node:path";
import { clickMenu, expect, isEdited, tempDir, test } from "./pdflion.js";
import { INK_STROKES, writeForm, writeInk, writeLabelled } from "./pdfs.js";

/** @typedef {import("./pdflion.js").Page} Page */

/**
 * @param {Page} page
 * @param {number} x
 * @param {number} y
 * @returns {Promise<[number, number]>} where a point of the first page, in
 *   PDF coordinates, is in the window
 */
async function toWindow(page, x, y) {
  const [left, top] = await page.evaluate(([x, y]) => {
    const view = PDFViewerApplication.pdfViewer.getPageView(0);
    const { left, top } = view.div.getBoundingClientRect();
    const [vx, vy] = view.viewport.convertToViewportPoint(x, y);
    return [left + view.div.clientLeft + vx, top + view.div.clientTop + vy];
  }, [x, y]);
  return [left, top];
}

/**
 * Drags the mouse along points of the first page, in PDF coordinates.
 *
 * @param {Page} page
 * @param {number[][]} points
 */
async function drag(page, points) {
  await page.mouse.move(...(await toWindow(page, points[0][0], points[0][1])));
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(...(await toWindow(page, x, y)), { steps: 10 });
  }
  await page.mouse.up();
}

/**
 * @param {Page} page
 * @returns {Promise<string[]>} the first page's drawings and highlights, as
 *   pdf.js's editors, with the number of strokes of each drawing
 */
const drawings = (page) =>
  page.evaluate(() =>
    [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].map(
      (editor) =>
        editor.editorType === "ink"
          ? `ink of ${editor.serialize(true)?.paths.points.length}`
          : editor.editorType,
    ),
  );

/**
 * @param {Page} page
 * @returns {Promise<{ subtype: string, strokes?: number }[]>} the first page's
 *   annotations, as the file has them
 */
const annotations = (page) =>
  page.evaluate(async () =>
    (await (await PDFViewerApplication.pdfDocument.getPage(1)).getAnnotations()).map(
      (/** @type {any} */ annotation) => ({
        subtype: annotation.subtype,
        strokes: annotation.inkLists?.length,
      }),
    ),
  );

/** @param {Page} page @returns {Promise<boolean>} */
const isErasing = (page) =>
  page.evaluate(() =>
    /** @type {HTMLElement} */ (document.getElementById("outerContainer")).classList.contains(
      "pdflionErasing",
    ),
  );

test("Object erasing removes a drawing, which comes back with Undo, from the keys and the menu", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  let { app, page } = await pdflion([file]);

  // Two drawings: Esc ends Pencil's first, whose strokes would be one drawing.
  await page.locator("#editorInkButton").click();
  await drag(page, [[100, 650], [300, 660]]);
  await page.keyboard.press("Escape");
  await drag(page, [[100, 550], [300, 560]]);
  await page.keyboard.press("Escape");
  expect(await drawings(page)).toEqual(["ink of 1", "ink of 1"]);

  const eraser = page.locator("#pdflionEditorEraserButton");
  await eraser.click();
  await expect(eraser).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#pdflionEditorEraserParamsToolbar")).toBeVisible();
  await expect(page.locator("#editorInkParamsToolbar")).toBeHidden();
  // Across the first drawing only.
  await drag(page, [[200, 700], [200, 600]]);
  await expect.poll(() => drawings(page)).toEqual(["ink of 1"]);
  await expect.poll(() => isEdited(app, page)).toBe(true);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => drawings(page)).toHaveLength(2);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => drawings(page)).toHaveLength(1);
  await clickMenu(app, page, "undo");
  await expect.poll(() => drawings(page)).toHaveLength(2);
  await clickMenu(app, page, "redo");
  await expect.poll(() => drawings(page)).toHaveLength(1);
  expect(await isErasing(page)).toBe(true);

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  await app.close();

  ({ page } = await pdflion([file]));
  expect(await annotations(page)).toEqual([{ subtype: "Ink", strokes: 1 }]);
});

test("erases an ink annotation from the file, which Save deletes", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "ink.pdf");
  await writeInk(file);
  let { app, page } = await pdflion([file]);
  expect(await annotations(page)).toEqual([{ subtype: "Ink", strokes: 2 }]);

  await page.locator("#pdflionEditorEraserButton").click();
  await expect.poll(() => drawings(page)).toEqual(["ink of 2"]);
  // Across the second stroke, away from the first.
  const [x, y] = INK_STROKES[1].slice(20, 22);
  await drag(page, [[x, y - 30], [x, y + 30]]);
  await expect.poll(() => drawings(page)).toEqual([]);

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  await app.close();

  ({ page } = await pdflion([file]));
  expect(await annotations(page)).toEqual([]);
});

test("leaves free highlights alone", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { page } = await pdflion([file]);
  await page.locator("#editorHighlightButton").click();
  await drag(page, [[100, 500], [400, 500]]);
  await page.locator("#editorInkButton").click();
  await drag(page, [[250, 450], [250, 550]]);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await drawings(page)).sort()).toEqual(["highlight", "ink of 1"]);

  await page.locator("#pdflionEditorEraserButton").click();
  // Across both.
  await drag(page, [[150, 520], [350, 480]]);
  await expect.poll(() => drawings(page)).toEqual(["highlight"]);
});

test("Pencil, another tool or Esc turns the eraser off, and its circle follows the pointer", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { page } = await pdflion([file]);
  const eraser = page.locator("#pdflionEditorEraserButton");
  const circle = page.locator("#pdflionEraserCursor");
  const mode = () => page.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode);

  await eraser.click();
  await expect.poll(mode).toBe(15);
  await page.mouse.move(...(await toWindow(page, 300, 600)));
  await expect(circle).toBeVisible();
  // 10 points wide by default, at the page's zoom.
  const scale = await page.evaluate(() => PDFViewerApplication.pdfViewer.getPageView(0).viewport.scale);
  const box = await circle.boundingBox();
  expect(box?.width).toBeCloseTo(10 * scale, 0);
  await page.mouse.move(5, 5);
  await expect(circle).toBeHidden();

  // Pencil stays on, and draws.
  await page.locator("#editorInkButton").click();
  expect(await isErasing(page)).toBe(false);
  expect(await mode()).toBe(15);
  await expect(page.locator("#editorInkParamsToolbar")).toBeVisible();
  await expect(page.locator("#pdflionEditorEraserParamsToolbar")).toBeHidden();
  await drag(page, [[100, 400], [300, 400]]);
  await page.keyboard.press("Escape");
  await expect.poll(() => drawings(page)).toEqual(["ink of 1"]);

  await eraser.click();
  await page.locator("#editorFreeTextButton").click();
  await expect.poll(mode).toBe(3);
  expect(await isErasing(page)).toBe(false);

  await eraser.click();
  await expect.poll(() => isErasing(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(mode).toBe(0);
  expect(await isErasing(page)).toBe(false);
  await expect(eraser).toHaveAttribute("aria-expanded", "false");
});

test("Edit > Undo still undoes typing in a form", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "form.pdf");
  await writeForm(file);
  const { app, page } = await pdflion([file]);
  const field = page.locator(".annotationLayer input");
  await field.fill("Ada");
  await field.pressSequentially(" Lovelace");
  await clickMenu(app, page, "undo");
  await expect(field).not.toHaveValue("Ada Lovelace");
  await clickMenu(app, page, "redo");
  await expect(field).toHaveValue("Ada Lovelace");
});

/**
 * @param {Page} page
 * @returns {Promise<{ strokes: number[][], color: number[], thickness: number, opacity: number }[]>}
 *   the first page's Pencil drawings, with their strokes in PDF coordinates
 */
const inkDrawings = (page) =>
  page.evaluate(() =>
    [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)]
      .filter((editor) => editor.editorType === "ink")
      .map((editor) => {
        const { paths, color, thickness, opacity } = editor.serialize(true);
        return { strokes: paths.points.map((points) => [...points]), color: [...color], thickness, opacity };
      }),
  );

/**
 * Turns the eraser on and chooses Line.
 * @param {Page} page
 */
async function eraseLines(page) {
  await page.locator("#pdflionEditorEraserButton").click();
  await page.locator(".pdflionEraserMode", { hasText: "Line" }).click();
  await expect(page.locator('input[name="pdflionEraserMode"][value="line"]')).toBeChecked();
}

test("Line erasing cuts a stroke in two, which keeps its look, as one step to undo", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  let { app, page } = await pdflion([file]);
  await page.locator("#editorInkButton").click();
  await page.locator("#editorInkColor").fill("#1e66f5");
  await page.locator("#editorInkThickness").fill("5");
  await page.locator("#editorInkOpacity").fill("0.5");
  await drag(page, [[100, 650], [300, 650]]);
  await page.keyboard.press("Escape");
  const [drawn] = await inkDrawings(page);
  expect(drawn).toMatchObject({ color: [30, 102, 245], thickness: 5, opacity: 0.5 });

  await eraseLines(page);
  await drag(page, [[200, 700], [200, 600]]);
  await expect.poll(async () => (await inkDrawings(page)).map((drawing) => drawing.strokes.length)).toEqual([2]);
  const [cut] = await inkDrawings(page);
  expect(cut).toMatchObject({ color: [30, 102, 245], thickness: 5, opacity: 0.5 });
  // The eraser, 10 points wide, and the stroke's round ends, 2.5 points, either side of x 200.
  const [left, right] = cut.strokes;
  expect(left[0]).toBeCloseTo(drawn.strokes[0][0], 0);
  expect(left.at(-2)).toBeLessThan(193);
  expect(right[0]).toBeGreaterThan(207);
  expect(right.at(-2)).toBeCloseTo(drawn.strokes[0].at(-2) ?? 0, 0);
  await expect.poll(() => isEdited(app, page)).toBe(true);

  const strokeCounts = async () => (await inkDrawings(page)).map((drawing) => drawing.strokes.length);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(strokeCounts).toEqual([1]);
  // The step before is the stroke drawn: erasing added only its own.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(strokeCounts).toEqual([]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(strokeCounts).toEqual([1]);
  await clickMenu(app, page, "redo");
  await expect.poll(strokeCounts).toEqual([2]);

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  await app.close();

  ({ page } = await pdflion([file]));
  expect(await annotations(page)).toEqual([{ subtype: "Ink", strokes: 2 }]);
});

test("Line erasing removes a drawing it leaves nothing of, which Undo brings back", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { page } = await pdflion([file]);
  await page.locator("#editorInkButton").click();
  await drag(page, [[190, 650], [210, 650]]);
  await page.keyboard.press("Escape");
  await eraseLines(page);
  await page.locator("#pdflionEraserSize").fill("50");

  await drag(page, [[200, 700], [200, 600]]);
  await expect.poll(() => drawings(page)).toEqual([]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => drawings(page)).toEqual(["ink of 1"]);
});

test("Line erasing cuts an ink annotation from the file, which Save replaces", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "ink.pdf");
  await writeInk(file);
  let { app, page } = await pdflion([file]);
  await eraseLines(page);
  await expect.poll(() => drawings(page)).toEqual(["ink of 2"]);
  // Across the first stroke, away from the second.
  await drag(page, [[200, 630], [200, 570]]);
  await expect.poll(() => drawings(page)).toEqual(["ink of 3"]);
  const [cut] = await inkDrawings(page);
  expect(cut).toMatchObject({ color: [255, 0, 0], thickness: 4 });

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  await app.close();

  ({ page } = await pdflion([file]));
  expect(await annotations(page)).toEqual([{ subtype: "Ink", strokes: 3 }]);
});
