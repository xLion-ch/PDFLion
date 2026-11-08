/**
 * The Apple Pencil in the web app: drawing, the eraser, hovering, pen-only
 * drawing and resting palms. The pen's and fingers' events are the page's
 * own (input.js), which Chromium's trusted touches add to where scrolling
 * matters.
 */
import {
  TRACEMONKEY,
  documentFrame,
  expect,
  openAppExplained,
  openFromHome,
  readLibrary,
  storedBytes,
  test,
} from "./pdflion.js";
import {
  FIRST_PAGE,
  dispatch,
  fingerDrag,
  inViewer,
  line,
  pencilHover,
  pencilStroke,
  strokeSteps,
  touchscreen,
} from "./input.js";

/** @typedef {import("./pdflion.js").Frame} Frame */
/** @typedef {import("./pdflion.js").Page} Page */

const NAME = "compressed.tracemonkey-pldi-09.pdf";

/**
 * @param {Page} page
 * @returns {Promise<Frame>} the paper's viewer, opened from Home
 */
async function openPaper(page) {
  await openAppExplained(page);
  await openFromHome(page, [TRACEMONKEY]);
  return documentFrame(page, NAME);
}

/**
 * @param {Frame} frame
 * @returns {Promise<{ type: string, strokes: number, color?: number[], thickness?: number }[]>}
 *   the first page's drawings and highlights, as pdf.js's editors
 */
const drawings = (frame) =>
  frame.evaluate(() =>
    [
      ...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0),
    ].map((/** @type {any} */ editor) => {
      const data = editor.editorType === "ink" ? editor.serialize(true) : null;
      return data
        ? {
            type: "ink",
            strokes: data.paths.points.length,
            color: data.color,
            thickness: data.thickness,
          }
        : { type: editor.editorType, strokes: 0 };
    }),
  );

/** @param {Frame} frame */
const types = async (frame) => (await drawings(frame)).map(({ type }) => type);

/**
 * Ends Pencil's open drawing, as Esc does. Its strokes become one drawing
 * only then, and pdf.js has no editor for it before.
 *
 * @param {Frame} frame
 */
const endDrawing = (frame) =>
  frame.evaluate(() => {
    const ui = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
    ui.unselectAll();
    ui.unselectAll();
  });

/**
 * @param {Frame} frame
 * @returns {Promise<string | null>} whether pen-only drawing's ⋮ menu item shows it on
 */
const penOnlyShown = (frame) =>
  frame.locator("#pdflionSecondaryPenOnly").getAttribute("aria-checked");

/**
 * @param {Page} page
 * @returns {Promise<any>} the tool settings the library keeps
 */
const storedToolSettings = (page) =>
  page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open("pdflion");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const settings = await new Promise((resolve) => {
      const get = database.transaction("settings").objectStore("settings").get("toolSettings");
      get.onsuccess = () => resolve(get.result);
    });
    database.close();
    return settings;
  });

/**
 * Counts the presses that reach pdf.js's editing layer of the first page.
 *
 * @param {Frame} frame
 */
const countLayerPresses = (frame) =>
  frame.evaluate(() => {
    /** @type {any} */ (window).layerPresses = 0;
    document
      .querySelector(`.page[data-page-number="1"] .annotationEditorLayer`)
      ?.addEventListener("pointerdown", () => /** @type {any} */ ((window).layerPresses += 1));
  });

/** @param {Frame} frame @returns {Promise<number>} */
const layerPresses = (frame) => frame.evaluate(() => /** @type {any} */ (window).layerPresses);

test("a pen draws with Pencil, turns pen-only drawing on the first time, and the drawing is stored", async ({
  page,
}) => {
  const frame = await openPaper(page);
  expect(await penOnlyShown(frame)).toBe("false");
  await frame.locator("#editorInkButton").tap();
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.4]), { pressure: 0.8, tiltX: 30, tiltY: -10 });
  expect(await penOnlyShown(frame)).toBe("true");
  // Each stroke is a drawing of its own, which ends a task after its lift,
  // so the next stroke waits for it, as a person's would.
  await expect.poll(() => drawings(frame)).toMatchObject([{ type: "ink", strokes: 1 }]);
  await pencilStroke(frame, line([0.2, 0.5], [0.6, 0.6]));
  await expect
    .poll(() => drawings(frame))
    .toMatchObject([
      { type: "ink", strokes: 1 },
      { type: "ink", strokes: 1 },
    ]);
  await expect
    .poll(() => storedToolSettings(page))
    .toMatchObject({ penOnly: true, penOnlyChosen: true });

  // Autosave ends the drawing, and keeps it in the library.
  await expect
    .poll(async () => (await readLibrary(page))[0]?.revision, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const [{ id }] = await readLibrary(page);
  expect((await storedBytes(page, id)).toString("latin1")).toMatch(/\/Subtype\s*\/Ink/);
});

test("a favourite picked with a tap draws in its colour and thickness with the pen", async ({
  page,
}) => {
  const frame = await openPaper(page);
  const blue = { tool: "ink", color: "#1e66f5", thickness: 7, opacity: 1 };
  await frame.evaluate((blue) => window.pdflion.setToolSettings({ favourites: [blue] }), blue);
  const favourite = frame.locator("#pdflionFavourites > .pdflionFavourite");
  await expect(favourite).toHaveCount(1);

  await favourite.tap();
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.4]));
  await endDrawing(frame);
  expect(await drawings(frame)).toEqual([
    { type: "ink", strokes: 1, color: [0x1e, 0x66, 0xf5], thickness: 7 },
  ]);
});

test("Highlight draws free highlights with the pen", async ({ page }) => {
  const frame = await openPaper(page);
  await frame.locator("#editorHighlightButton").tap();
  // Across the margin, where there's no text to highlight.
  await pencilStroke(frame, line([0.03, 0.3], [0.03, 0.6]));
  await expect.poll(() => types(frame)).toEqual(["highlight"]);
});

test("the eraser erases with the pen, whole drawings or parts of them, and Undo and Redo take it back", async ({
  page,
}) => {
  const frame = await openPaper(page);
  await frame.locator("#editorInkButton").tap();
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.3]));
  await endDrawing(frame);
  await pencilStroke(frame, line([0.2, 0.6], [0.6, 0.6]));
  await endDrawing(frame);
  expect(await types(frame)).toEqual(["ink", "ink"]);

  await frame.locator("#pdflionEditorEraserButton").tap();
  await expect(frame.locator("#outerContainer")).toHaveClass(/pdflionErasing/);
  // Object mode: across the first drawing.
  await pencilStroke(frame, line([0.4, 0.2], [0.4, 0.4]));
  await expect.poll(() => drawings(frame)).toMatchObject([{ type: "ink", strokes: 1 }]);
  const undo = frame.locator("#pdflionUndo");
  await undo.tap();
  await expect.poll(() => types(frame)).toEqual(["ink", "ink"]);
  await frame.locator("#pdflionRedo").tap();
  await expect.poll(() => types(frame)).toEqual(["ink"]);

  // Line mode cuts the second drawing into two.
  await frame.locator('input[name="pdflionEraserMode"][value="line"]').tap();
  await pencilStroke(frame, line([0.4, 0.5], [0.4, 0.7]));
  await expect
    .poll(() => drawings(frame))
    .toMatchObject([
      { type: "ink", strokes: 1 },
      { type: "ink", strokes: 1 },
    ]);
  await undo.tap();
  await expect.poll(() => drawings(frame)).toMatchObject([{ type: "ink", strokes: 1 }]);
});

test("a hovering pen moves the eraser's circle, and erases nothing", async ({ page }) => {
  const frame = await openPaper(page);
  await frame.locator("#editorInkButton").tap();
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.3]));
  await endDrawing(frame);
  await frame.locator("#pdflionEditorEraserButton").tap();

  const cursor = frame.locator("#pdflionEraserCursor");
  await expect(cursor).toBeHidden();
  await pencilHover(frame, line([0.4, 0.2], [0.4, 0.4]));
  await expect(cursor).toBeVisible();
  const where = await cursor.evaluate((element) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2 };
  });
  const expected = await frame.evaluate((selector) => {
    // The hover's last place: 0.4 across and 0.4 down the page's part in view.
    const page = /** @type {Element} */ (document.querySelector(selector)).getBoundingClientRect();
    const view = /** @type {Element} */ (
      document.getElementById("viewerContainer")
    ).getBoundingClientRect();
    const top = Math.max(page.top, view.top, 0);
    const bottom = Math.min(page.bottom, view.bottom, innerHeight);
    return { x: page.left + page.width * 0.4, y: top + (bottom - top) * 0.4 };
  }, FIRST_PAGE);
  expect(where.x).toBeCloseTo(expected.x, 0);
  expect(where.y).toBeCloseTo(expected.y, 0);
  expect(await types(frame)).toEqual(["ink"]);
});

test("with pen-only drawing, fingers draw and erase nothing and reach none of pdf.js's layers, until it's off", async ({
  page,
  browserName,
}) => {
  const frame = await openPaper(page);
  await frame.locator("#editorInkButton").tap();
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.3]));
  await endDrawing(frame);
  expect(await penOnlyShown(frame)).toBe("true");

  await countLayerPresses(frame);
  const moves = (await fingerDrag(frame, line([0.2, 0.5], [0.6, 0.55]))).filter(
    ({ type }) => type === "touchmove",
  );
  expect(
    moves.some(({ cancelled }) => cancelled),
    "the browser would scroll",
  ).toBe(false);
  expect(await layerPresses(frame)).toBe(0);
  expect(await types(frame)).toEqual(["ink"]);

  if (browserName === "chromium") {
    // Trusted touches really scroll, and still draw nothing.
    const scrolled = () =>
      frame.evaluate(() => document.getElementById("viewerContainer")?.scrollTop ?? 0);
    const before = await scrolled();
    const from = await inViewer(frame, [0.5, 0.7]);
    const touch = await touchscreen(page);
    await touch.swipe(Array.from({ length: 10 }, (_, i) => ({ x: from.x, y: from.y - i * 20 })));
    await expect.poll(scrolled).toBeGreaterThan(before + 50);
    expect(await types(frame)).toEqual(["ink"]);
  }

  // The eraser leaves fingers alone too.
  await frame.locator("#pdflionEditorEraserButton").tap();
  await frame.evaluate(() => document.getElementById("viewerContainer")?.scrollTo(0, 0));
  await fingerDrag(frame, line([0.4, 0.2], [0.4, 0.4]));
  expect(await types(frame)).toEqual(["ink"]);

  // Turned off in the ⋮ menu, fingers erase, and draw with Pencil.
  await frame.locator("#secondaryToolbarToggleButton").tap();
  await frame.locator("#pdflionSecondaryPenOnly").tap();
  expect(await penOnlyShown(frame)).toBe("false");
  await expect
    .poll(() => storedToolSettings(page))
    .toMatchObject({ penOnly: false, penOnlyChosen: true });
  await fingerDrag(frame, line([0.4, 0.2], [0.4, 0.4]));
  await expect.poll(() => types(frame)).toEqual([]);
  // pdf.js takes the pointer that drew first in a tool, until the user
  // chooses a tool again (CurrentPointers in src/display/editor/tools.js).
  await frame.locator("#pdflionEditorEraserButton").tap();
  await frame.locator("#editorInkButton").tap();
  await fingerDrag(frame, line([0.2, 0.5], [0.6, 0.55]));
  await endDrawing(frame);
  expect(await types(frame)).toEqual(["ink"]);

  // Chosen, it stays off for the next pen.
  await endDrawing(frame);
  await pencilStroke(frame, line([0.2, 0.7], [0.6, 0.7]));
  expect(await penOnlyShown(frame)).toBe("false");
});

test("a palm resting on the page while the pen draws scrolls nothing, nor does it end the stroke", async ({
  page,
}) => {
  const frame = await openPaper(page);
  await frame.locator("#editorInkButton").tap();
  // pdf.js's pinching listens on window, after everything else.
  await frame.evaluate(() => {
    /** @type {any} */ (window).touchStarts = 0;
    window.addEventListener("touchstart", () => /** @type {any} */ ((window).touchStarts += 1));
  });

  const pen = { pointerType: /** @type {const} */ ("pen"), pointerId: 2 };
  const palm = { pointerType: /** @type {const} */ ("touch"), pointerId: 12, identifier: 12 };
  const events = await dispatch(frame, FIRST_PAGE, [
    { ...pen, type: "pointerdown", at: [0.2, 0.3] },
    { ...pen, type: "pointermove", at: [0.3, 0.32] },
    { ...palm, type: "pointerdown", at: [0.8, 0.8] },
    { ...palm, type: "touchstart", at: [0.8, 0.8] },
    { ...pen, type: "pointermove", at: [0.4, 0.34] },
    { ...palm, type: "pointermove", at: [0.8, 0.75] },
    { ...palm, type: "touchmove", at: [0.8, 0.75] },
    { ...pen, type: "pointermove", at: [0.5, 0.36] },
    { ...palm, type: "touchmove", at: [0.8, 0.7] },
    { ...pen, type: "pointermove", at: [0.6, 0.38] },
    { ...pen, type: "pointerup", at: [0.6, 0.38] },
    { ...palm, type: "pointerup", at: [0.8, 0.7] },
    { ...palm, type: "touchend", at: [0.8, 0.7] },
  ]);

  expect(
    events.filter(({ type }) => type === "touchmove").map(({ cancelled }) => cancelled),
  ).toEqual([true, true]);
  expect(await frame.evaluate(() => /** @type {any} */ (window).touchStarts)).toBe(0);
  await endDrawing(frame);
  const [drawing, ...more] = await frame.evaluate(() =>
    [
      ...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0),
    ].map((/** @type {any} */ editor) =>
      editor.serialize(true).paths.points.map((/** @type {any} */ points) => points.length),
    ),
  );
  expect(more).toEqual([]);
  // One stroke, along the pen's five places, as x and y pairs at least.
  expect(drawing).toHaveLength(1);
  expect(drawing[0]).toBeGreaterThanOrEqual(10);

  // Once the pen is up, a finger's touchmoves are left alone again.
  const after = await fingerDrag(frame, line([0.2, 0.5], [0.3, 0.5], 2));
  expect(after.some(({ type, cancelled }) => type === "touchmove" && cancelled)).toBe(false);
});

test("a pen draws nothing with no tool on", async ({ page }) => {
  const frame = await openPaper(page);
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.4]));
  expect(await types(frame)).toEqual([]);
  // A pen on a page turns pen-only drawing on all the same.
  expect(await penOnlyShown(frame)).toBe("true");
});

test("Pencil saves as a favourite, also where its colour takes an alpha channel", async ({ page }) => {
  const frame = await openPaper(page);
  await frame.locator("#editorInkButton").tap();
  await frame.locator("#pdflionSaveInkFavourite").tap();
  await expect(frame.locator("#pdflionSaveInkFavourite")).toHaveText("Saved");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const database = await new Promise((resolve, reject) => {
          const open = indexedDB.open("pdflion");
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const favourites = await new Promise((resolve) => {
          const get = database.transaction("settings").objectStore("settings").get("favourites");
          get.onsuccess = () => resolve(get.result);
        });
        database.close();
        return favourites;
      }),
    )
    .toEqual([{ tool: "ink", color: "#000000", thickness: 1, opacity: 1 }]);
  // Picked with a tap, it draws in its colour.
  await frame.locator("#editorInkButton").tap();
  const favourite = frame.locator("#pdflionFavourites > .pdflionFavourite");
  await favourite.tap();
  await expect(favourite).toHaveAttribute("aria-pressed", "true");
});

test("the eraser erases a free highlight with the pen, in either mode", async ({ page }) => {
  const frame = await openPaper(page);
  await frame.locator("#editorHighlightButton").tap();
  // Across the margin, where there's no text to highlight.
  await pencilStroke(frame, line([0.03, 0.3], [0.03, 0.6]));
  await expect.poll(() => types(frame)).toEqual(["highlight"]);

  await frame.locator("#pdflionEditorEraserButton").tap();
  await frame.locator('input[name="pdflionEraserMode"][value="line"]').tap();
  await pencilStroke(frame, line([0.01, 0.45], [0.06, 0.45]));
  await expect.poll(() => types(frame)).toEqual([]);
  await frame.locator("#pdflionUndo").tap();
  await expect.poll(() => types(frame)).toEqual(["highlight"]);
});

/**
 * A pen's press that the browser takes over, as Safari does when it starts to
 * pan: a press and moves, and pointercancel rather than a lift.
 *
 * @param {Frame} frame
 * @param {[number, number][]} points on the first page
 */
const cancelledStroke = (frame, points) =>
  dispatch(frame, FIRST_PAGE, [
    ...strokeSteps(points, { pointerType: "pen", pointerId: 2 }).slice(0, -1),
    { type: "pointercancel", at: /** @type {[number, number]} */ (points.at(-1)), pointerType: "pen", pointerId: 2, button: -1 },
  ]);

test("after a cancelled Highlight stroke the pen still draws, in that tool and the next", async ({
  page,
}) => {
  const frame = await openPaper(page);
  await frame.locator("#editorHighlightButton").tap();
  await cancelledStroke(frame, line([0.03, 0.2], [0.03, 0.4]));
  await expect.poll(() => types(frame)).toEqual(["highlight"]);
  await expect(frame.locator(".annotationEditorLayer.drawing")).toHaveCount(0);

  await pencilStroke(frame, line([0.03, 0.5], [0.03, 0.7]), { pointerId: 3 });
  await expect.poll(() => types(frame)).toEqual(["highlight", "highlight"]);

  await cancelledStroke(frame, line([0.97, 0.2], [0.97, 0.4]));
  await frame.locator("#editorInkButton").tap();
  await expect(frame.locator("#editorInkButton")).toHaveClass(/toggled/);
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.4]), { pointerId: 4 });
  await expect.poll(() => types(frame)).toEqual(["highlight", "highlight", "highlight", "ink"]);
});

test("after a cancelled press the pen's next one counts, with Pencil and Text", async ({ page }) => {
  const frame = await openPaper(page);
  await frame.locator("#editorInkButton").tap();
  await cancelledStroke(frame, line([0.2, 0.2], [0.6, 0.2]));
  await expect.poll(() => types(frame)).toEqual(["ink"]);
  await pencilStroke(frame, line([0.2, 0.4], [0.6, 0.4]), { pointerId: 3 });
  await expect.poll(() => types(frame)).toEqual(["ink", "ink"]);

  await frame.locator("#editorFreeTextButton").tap();
  await expect(frame.locator("#editorFreeTextButton")).toHaveClass(/toggled/);
  await cancelledStroke(frame, [[0.2, 0.6]]);
  await pencilStroke(frame, [[0.2, 0.7]], { pointerId: 4 });
  await expect.poll(() => types(frame)).toEqual(["ink", "ink", "freetext"]);
});

test("a pen's press ends a stroke whose lift never came", async ({ page }) => {
  const frame = await openPaper(page);
  await frame.locator("#editorHighlightButton").tap();
  await dispatch(
    frame,
    FIRST_PAGE,
    strokeSteps(line([0.03, 0.2], [0.03, 0.4]), { pointerType: "pen", pointerId: 2 }).slice(0, -1),
  );
  await frame.locator("#editorInkButton").tap();
  await expect(frame.locator("#editorInkButton")).toHaveClass(/toggled/);
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.4]), { pointerId: 3 });
  await expect.poll(() => types(frame)).toEqual(["highlight", "ink"]);

  await dispatch(
    frame,
    FIRST_PAGE,
    strokeSteps(line([0.2, 0.5], [0.6, 0.5]), { pointerType: "pen", pointerId: 5 }).slice(0, -1),
  );
  await pencilStroke(frame, line([0.2, 0.7], [0.6, 0.7]), { pointerId: 6 });
  // Both strokes are there, in one drawing, since the second came at once.
  await expect
    .poll(async () => (await drawings(frame)).reduce((sum, { strokes }) => sum + strokes, 0))
    .toBe(3);
});

test("the eraser saves as a favourite, which erases with its mode and size", async ({ page }) => {
  const frame = await openPaper(page);
  await frame.locator("#editorInkButton").tap();
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.3]));
  await expect.poll(() => types(frame)).toEqual(["ink"]);

  await frame.locator("#pdflionEditorEraserButton").tap();
  await frame.locator('input[name="pdflionEraserMode"][value="line"]').tap();
  await frame.locator("#pdflionSaveEraserFavourite").tap();
  const favourite = frame.locator('#pdflionFavourites > .pdflionFavourite[data-tool="eraser"]');
  await expect(favourite).toHaveAttribute("aria-pressed", "true");
  await expect(favourite).toHaveAttribute("title", "Eraser, Line, 10 pt");
  // The option box closes with the eraser, and stays closed for the favourite.
  await frame.locator("#pdflionEditorEraserButton").tap();
  await expect(favourite).toHaveAttribute("aria-pressed", "false");

  await favourite.tap();
  await expect(frame.locator("#outerContainer")).toHaveClass(/pdflionErasing/);
  await expect(frame.locator("#pdflionEditorEraserParamsToolbar")).toBeHidden();
  // Line mode cuts the drawing in two.
  await pencilStroke(frame, line([0.4, 0.2], [0.4, 0.4]));
  await expect.poll(() => types(frame)).toEqual(["ink", "ink"]);
});

test("no drawing or highlight shows a box, or takes a press, with any tool on", async ({ page }) => {
  const frame = await openPaper(page);
  const margin = line([0.03, 0.3], [0.03, 0.6]);
  await frame.locator("#editorHighlightButton").tap();
  await pencilStroke(frame, margin);
  await expect.poll(() => types(frame)).toEqual(["highlight"]);
  await expect(frame.locator(".selectedEditor")).toHaveCount(0);
  await expect(frame.locator(".highlightEditor .editToolbar")).toBeHidden();
  await expect(frame.locator("svg.highlightOutline").first()).toBeHidden();

  // A press on the highlight draws another, rather than selecting it, also
  // within pdf.js's time for a double press.
  await pencilStroke(frame, margin);
  await expect.poll(() => types(frame)).toEqual(["highlight", "highlight"]);
  await expect(frame.locator(".selectedEditor")).toHaveCount(0);

  await frame.locator("#editorInkButton").tap();
  await expect(frame.locator("#editorInkButton")).toHaveClass(/toggled/);
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.3]));
  await expect.poll(() => types(frame)).toEqual(["highlight", "highlight", "ink"]);

  // Text: a press on the drawing opens a text box, rather than selecting it.
  await frame.locator("#editorFreeTextButton").tap();
  await expect(frame.locator("#editorFreeTextButton")).toHaveClass(/toggled/);
  await pencilStroke(frame, [[0.4, 0.3]]);
  await expect.poll(() => types(frame)).toEqual(["highlight", "highlight", "ink", "freetext"]);
  await expect(frame.locator(".inkEditor.selectedEditor, .highlightEditor.selectedEditor")).toHaveCount(0);
});

test("Highlight and Pencil mark over a text box, which stays unselected", async ({ page }) => {
  const frame = await openPaper(page);
  await frame.locator("#editorFreeTextButton").tap();
  await expect(frame.locator("#editorFreeTextButton")).toHaveClass(/toggled/);
  await pencilStroke(frame, [[0.01, 0.3]]);
  await expect.poll(() => types(frame)).toEqual(["freetext"]);
  await page.keyboard.type("A comment");

  // Starting over the text box, whose text pdf.js keeps above the highlight.
  await frame.locator("#editorHighlightButton").tap();
  await expect(frame.locator("#editorHighlightButton")).toHaveClass(/toggled/);
  const across = line([0.03, 0.29], [0.07, 0.31]);
  const box = await frame.locator(".freeTextEditor").boundingBox();
  const start = await frame.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.className,
    [/** @type {any} */ (box).x + 10, /** @type {any} */ (box).y + 5],
  );
  expect(start).toContain("textLayer");
  await pencilStroke(frame, across);
  await expect.poll(() => types(frame)).toEqual(["freetext", "highlight"]);
  await expect(frame.locator(".selectedEditor")).toHaveCount(0);

  await frame.locator("#editorInkButton").tap();
  await expect(frame.locator("#editorInkButton")).toHaveClass(/toggled/);
  await pencilStroke(frame, across);
  await expect.poll(() => types(frame)).toEqual(["freetext", "highlight", "ink"]);
  await expect(frame.locator(".selectedEditor")).toHaveCount(0);
});
