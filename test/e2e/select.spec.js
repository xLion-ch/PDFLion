/**
 * The select and screenshot tools, and the pages' context menu, whose Paste
 * puts an image or copied drawings where it opened.
 *
 * These tests write the system's clipboard, and put back its text after.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, isEdited, tempDir, test } from "./pdflion.js";
import { writeLabelled } from "./pdfs.js";

/** @typedef {import("./pdflion.js").ElectronApplication} ElectronApplication */
/** @typedef {import("./pdflion.js").Page} Page */

/**
 * @param {Page} page
 * @param {number} x
 * @param {number} y
 * @returns {Promise<[number, number]>} where a point of the first page, in
 *   PDF coordinates, is in the window
 */
async function toWindow(page, x, y) {
  return page.evaluate(([x, y]) => {
    const view = PDFViewerApplication.pdfViewer.getPageView(0);
    const { left, top } = view.div.getBoundingClientRect();
    const [vx, vy] = view.viewport.convertToViewportPoint(x, y);
    return /** @type {[number, number]} */ ([
      left + view.div.clientLeft + vx,
      top + view.div.clientTop + vy,
    ]);
  }, [x, y]);
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
 * Draws a stroke with Pencil, which Esc ends as a drawing of its own.
 *
 * @param {Page} page
 * @param {number[][]} points
 */
async function drawStroke(page, points) {
  const pencil = page.locator("#editorInkButton");
  if ((await pencil.getAttribute("aria-expanded")) !== "true") await pencil.click();
  await drag(page, points);
  await page.keyboard.press("Escape");
}

/**
 * @param {Page} page
 * @returns {Promise<{ type: string, selected: boolean, box: number[] }[]>}
 *   the first page's editors: their type, whether they're selected, and
 *   their box in PDF coordinates, rounded
 */
const editors = (page) =>
  page.evaluate(() =>
    [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].map(
      (editor) => ({
        type: editor.editorType,
        selected: editor.isSelected,
        box: editor.getPDFRect().map((/** @type {number} */ value) => Math.round(value)),
      }),
    ),
  );

/**
 * @param {number[]} box
 * @returns {number[]} its middle
 */
const middle = ([x1, y1, x2, y2]) => [(x1 + x2) / 2, (y1 + y2) / 2];

/**
 * @param {number[]} box
 * @param {number[]} point
 * @returns {boolean} whether the box's middle is the point, give or take the
 *   2 points a mouse's whole pixels and the boxes' rounding make
 */
const centredOn = (box, point) => {
  const [x, y] = middle(box);
  return Math.abs(x - point[0]) <= 2 && Math.abs(y - point[1]) <= 2;
};

/** @param {Page} page @param {string} name */
const hasClass = (page, name) =>
  page.evaluate(
    (name) =>
      /** @type {HTMLElement} */ (document.getElementById("outerContainer")).classList.contains(name),
    name,
  );

/**
 * Has main record the context menus it shows, rather than show them.
 *
 * @param {ElectronApplication} app
 */
const recordContextMenus = (app) =>
  app.evaluate(({ Menu }) => {
    /** @type {any} */ (globalThis).contextMenu = null;
    Menu.prototype.popup = function () {
      /** @type {any} */ (globalThis).contextMenu = this;
    };
  });

/**
 * Right-clicks a point of the first page, and waits for main's menu.
 *
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {number} x
 * @param {number} y
 * @returns {Promise<Record<string, boolean>>} its items, and whether each is enabled
 */
async function openPageMenu(app, page, x, y) {
  await app.evaluate(() => {
    /** @type {any} */ (globalThis).contextMenu = null;
  });
  await page.mouse.click(...(await toWindow(page, x, y)), { button: "right" });
  await expect.poll(() => app.evaluate(() => !!(/** @type {any} */ (globalThis).contextMenu))).toBe(true);
  return app.evaluate(() =>
    Object.fromEntries(
      /** @type {any} */ (globalThis).contextMenu.items
        .filter((/** @type {any} */ item) => item.type !== "separator")
        // Without the access keys' &, which macOS drops.
        .map((/** @type {any} */ item) => [item.label.replace("&", ""), item.enabled]),
    ),
  );
}

/**
 * @param {ElectronApplication} app
 * @param {string} label
 */
const clickContextMenu = (app, label) =>
  app.evaluate((_electron, label) => {
    /** @type {any} */ (globalThis).contextMenu.items
      .find((/** @type {any} */ item) => item.label.replace("&", "") === label)
      .click();
  }, label);

/**
 * Keeps the clipboard's text for the test, and puts it back after.
 *
 * @param {ElectronApplication} app
 * @returns {Promise<() => Promise<void>>} what puts it back
 */
async function keepClipboard(app) {
  const text = await app.evaluate(({ clipboard }) => clipboard.readText());
  return () => app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text);
}

/**
 * Puts a 40 × 20 pixel red PNG on the clipboard, as another app would.
 *
 * @param {ElectronApplication} app
 */
const copyRedImage = (app) =>
  app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const [width, height] = [40, 20];
    const bitmap = Buffer.alloc(width * height * 4);
    // BGRA: red, opaque.
    for (let i = 0; i < bitmap.length; i += 4) bitmap.set([0, 0, 255, 255], i);
    const png = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]);
  });

test("the select tool's rectangle selects drawings, which a drag moves and Delete deletes", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { app, page } = await pdflion([file]);
  await drawStroke(page, [[100, 650], [300, 660]]);
  await drawStroke(page, [[100, 550], [300, 560]]);
  await drawStroke(page, [[100, 450], [300, 460]]);
  expect((await editors(page)).map(({ type }) => type)).toEqual(["ink", "ink", "ink"]);

  const select = page.locator("#pdflionEditorSelectButton");
  await select.click();
  await expect(select).toHaveAttribute("aria-pressed", "true");
  expect(await hasClass(page, "pdflionSelecting")).toBe(true);
  // pdf.js's ink mode shows Pencil on, which the select tool shows off.
  await expect(page.locator("#editorInkParamsToolbar")).toBeHidden();

  // Around the first two, which the third isn't in.
  await drag(page, [[80, 700], [320, 520]]);
  expect((await editors(page)).map(({ selected }) => selected)).toEqual([true, true, false]);
  const before = await editors(page);

  // A drag on one of them moves both, down 100 points.
  await drag(page, [[200, 655], [200, 605], [200, 555]]);
  await expect
    .poll(async () => (await editors(page)).map(({ box }) => Math.round(middle(box)[1])))
    .toEqual([middle(before[0].box)[1] - 100, middle(before[1].box)[1] - 100, middle(before[2].box)[1]].map(Math.round));
  await expect.poll(() => isEdited(app, page)).toBe(true);
  // One step to undo.
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await editors(page)).map(({ box }) => box))
    .toEqual(before.map(({ box }) => box));

  // A click beside them clears the selection, and Shift adds to it.
  await page.mouse.click(...(await toWindow(page, 450, 450)));
  expect((await editors(page)).map(({ selected }) => selected)).toEqual([false, false, false]);
  await page.mouse.click(...(await toWindow(page, 200, 455)));
  await page.keyboard.down("Shift");
  await page.mouse.click(...(await toWindow(page, 200, 655)));
  await page.keyboard.up("Shift");
  expect((await editors(page)).map(({ selected }) => selected)).toEqual([true, false, true]);

  await page.keyboard.press("Delete");
  await expect.poll(async () => (await editors(page)).length).toBe(1);
  // Still selecting, until Esc, which clears the selection first.
  expect(await hasClass(page, "pdflionSelecting")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(select).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode)).toBe(0);
});

test("the select tool's rectangle takes text boxes, and leaves what it doesn't reach", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { page } = await pdflion([file]);
  await page.locator("#editorFreeTextButton").click();
  await page.mouse.click(...(await toWindow(page, 400, 650)));
  await page.keyboard.type("Hello");
  await page.keyboard.press("Escape");
  await drawStroke(page, [[100, 500], [200, 510]]);
  await expect.poll(async () => (await editors(page)).map(({ type }) => type)).toEqual(["freetext", "ink"]);

  await page.locator("#pdflionEditorSelectButton").click();
  // Across the text box's corner only.
  const [{ box }] = await editors(page);
  await drag(page, [[box[0] - 30, box[3] + 30], [box[0] + 5, box[3] - 5]]);
  expect((await editors(page)).map(({ selected }) => selected)).toEqual([true, false]);
  // A drag on it moves it, without switching to Text.
  await drag(page, [[(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], [(box[0] + box[2]) / 2 - 50, (box[1] + box[3]) / 2]]);
  await expect.poll(async () => (await editors(page))[0].box[0]).toBeLessThan(box[0] - 40);
  await expect(page.locator("#pdflionEditorSelectButton")).toHaveAttribute("aria-pressed", "true");
});

test("Pencil, the eraser and the screenshot tool each turn the select tool off", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { page } = await pdflion([file]);
  const select = page.locator("#pdflionEditorSelectButton");
  const screenshot = page.locator("#pdflionEditorScreenshotButton");
  const pencil = page.locator("#editorInkButton");

  await select.click();
  await screenshot.click();
  await expect(select).toHaveAttribute("aria-pressed", "false");
  await expect(screenshot).toHaveAttribute("aria-pressed", "true");
  expect(await hasClass(page, "pdflionCapturing")).toBe(true);

  await page.locator("#pdflionEditorEraserButton").click();
  await expect(screenshot).toHaveAttribute("aria-pressed", "false");
  expect(await hasClass(page, "pdflionErasing")).toBe(true);

  await select.click();
  expect(await hasClass(page, "pdflionErasing")).toBe(false);
  await pencil.click();
  await expect(select).toHaveAttribute("aria-pressed", "false");
  // Pencil is on, in the ink mode it was in, and draws.
  await expect(pencil).toHaveAttribute("aria-expanded", "true");
  await drag(page, [[100, 650], [300, 660]]);
  await page.keyboard.press("Escape");
  expect((await editors(page)).map(({ type }) => type)).toEqual(["ink"]);

  await page.locator("#editorFreeTextButton").click();
  await select.click();
  await page.locator("#editorHighlightButton").click();
  await expect(select).toHaveAttribute("aria-pressed", "false");
});

/**
 * Takes a screenshot of a rectangle of the first page, in PDF coordinates.
 *
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {number[]} from a corner
 * @param {number[]} to the other
 * @returns {Promise<{ width: number, height: number, dark: number }>} the
 *   image's size, and how many of its pixels are dark
 */
async function screenshot(app, page, from, to) {
  await app.evaluate(({ clipboard }) => clipboard.writeText("before"));
  await page.evaluate(() => {
    /** @type {HTMLElement} */ (document.getElementById("viewer-alert")).textContent = "";
  });
  const [x1, y1] = await toWindow(page, from[0], from[1]);
  const [x2, y2] = await toWindow(page, to[0], to[1]);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator("#viewer-alert")).toHaveText("Screenshot copied to the clipboard");
  return app.evaluate(async ({ clipboard, nativeImage }) => {
    const [item] = await clipboard.read();
    const png = await /** @type {Blob} */ (await item.getType("image/png")).arrayBuffer();
    const copied = nativeImage.createFromBuffer(Buffer.from(png));
    const bitmap = copied.toBitmap();
    let dark = 0;
    for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i] < 128) dark++;
    return { ...copied.getSize(), dark };
  });
}

test("the screenshot tool copies a rectangle of the page as an image, drawings too", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { app, page } = await pdflion([file]);
  const restore = await keepClipboard(app);
  try {
    // A drawing where the page has nothing.
    await drawStroke(page, [[350, 600], [550, 610]]);
    await page.locator("#pdflionEditorScreenshotButton").click();
    // Around "Page 1", which writeLabelled() writes at the top left.
    const [x1, y1] = await toWindow(page, 40, 760);
    const [x2, y2] = await toWindow(page, 240, 680);
    const image = await screenshot(app, page, [40, 760], [240, 680]);
    // At least twice the CSS pixels, with the text's dark pixels.
    expect(image.width).toBeGreaterThanOrEqual(Math.round((x2 - x1) * 2) - 1);
    expect(image.height).toBeGreaterThanOrEqual(Math.round((y2 - y1) * 2) - 1);
    expect(image.dark).toBeGreaterThan(100);
    // The drawing shows too, and the tool stays on.
    expect((await screenshot(app, page, [330, 640], [570, 570])).dark).toBeGreaterThan(100);
    expect((await screenshot(app, page, [330, 540], [570, 500])).dark).toBe(0);
    await expect(page.locator("#pdflionEditorScreenshotButton")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await restore();
  }
});

/**
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {number[]} point where it should be centred, in PDF coordinates
 */
async function expectSelectedImageAt(app, page, point) {
  await expect.poll(async () => (await editors(page)).map(({ type }) => type)).toEqual(["stamp"]);
  await expect.poll(async () => centredOn((await editors(page))[0].box, point)).toBe(true);
  // Selected in the select tool, once loaded, rather than in pdf.js's Stamp mode.
  await expect.poll(async () => (await editors(page))[0].selected).toBe(true);
  await expect(page.locator("#pdflionEditorSelectButton")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode)).toBe(15);
  await expect.poll(() => isEdited(app, page)).toBe(true);
}

test("Paste in the pages' menu puts an image where it opened, and the select tool resizes it", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { app, page } = await pdflion([file]);
  const restore = await keepClipboard(app);
  try {
    await recordContextMenus(app);
    await app.evaluate(({ clipboard }) => clipboard.writeText("text only"));
    expect(await openPageMenu(app, page, 300, 500)).toEqual({
      "Cut": false,
      "Copy": false,
      "Paste": false,
      "Delete": false,
      "Add Image from File…": true,
    });

    await copyRedImage(app);
    expect((await openPageMenu(app, page, 300, 500)).Paste).toBe(true);
    await clickContextMenu(app, "Paste");
    await expectSelectedImageAt(app, page, [300, 500]);

    // Its handle resizes it.
    const [{ box }] = await editors(page);
    const handle = page.locator(".stampEditor .resizer.bottomRight");
    await expect(handle).toBeVisible();
    const corner = await handle.boundingBox();
    if (!corner) throw new Error("No handle");
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + 60, corner.y + 30, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await editors(page))[0].box[2] - (await editors(page))[0].box[0]).toBeGreaterThan(box[2] - box[0] + 20);
    // Still selecting.
    await expect(page.locator("#pdflionEditorSelectButton")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await restore();
  }
});

test("the pages' menu copies selected drawings, pastes them where it opens, and deletes", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { app, page } = await pdflion([file]);
  const restore = await keepClipboard(app);
  try {
    await recordContextMenus(app);
    await drawStroke(page, [[100, 650], [200, 660]]);
    await page.locator("#pdflionEditorSelectButton").click();

    // A right click on a drawing selects it.
    expect(await openPageMenu(app, page, 150, 655)).toEqual({
      "Cut": true,
      "Copy": true,
      "Paste": false,
      "Delete": true,
      "Add Image from File…": true,
    });
    expect((await editors(page))[0].selected).toBe(true);
    await clickContextMenu(app, "Copy");

    expect((await openPageMenu(app, page, 400, 480)).Paste).toBe(true);
    await clickContextMenu(app, "Paste");
    await expect.poll(async () => (await editors(page)).length).toBe(2);
    const [original, pasted] = await editors(page);
    expect(pasted.selected).toBe(true);
    expect(centredOn(pasted.box, [400, 480])).toBe(true);
    expect(original.box).toEqual((await editors(page))[0].box);

    // One step to undo.
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await editors(page)).length).toBe(1);

    await openPageMenu(app, page, 150, 655);
    await clickContextMenu(app, "Delete");
    await expect.poll(async () => (await editors(page)).length).toBe(0);
  } finally {
    await restore();
  }
});

test("Add Image from File… in the pages' menu puts the image chosen where it opened", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const file = path.join(dir, "pages.pdf");
  await writeLabelled(file, 1);
  const image = path.join(dir, "red.png");
  const { app, page } = await pdflion([file]);
  // A 40 × 20 red PNG, which main encodes.
  const png = await app.evaluate(({ nativeImage }) => {
    const bitmap = Buffer.alloc(40 * 20 * 4);
    for (let i = 0; i < bitmap.length; i += 4) bitmap.set([0, 0, 255, 255], i);
    return nativeImage.createFromBitmap(bitmap, { width: 40, height: 20 }).toPNG().toString("base64");
  });
  await fs.writeFile(image, Buffer.from(png, "base64"));
  await recordContextMenus(app);

  await openPageMenu(app, page, 250, 550);
  const choosing = page.waitForEvent("filechooser");
  await clickContextMenu(app, "Add Image from File…");
  const chooser = await choosing;
  await chooser.setFiles(image);
  await expectSelectedImageAt(app, page, [250, 550]);

  // Choosing none adds none.
  await openPageMenu(app, page, 400, 500);
  const cancelling = page.waitForEvent("filechooser");
  await clickContextMenu(app, "Add Image from File…");
  await (await cancelling).setFiles([]);
  await page.waitForTimeout(300);
  expect(await editors(page)).toHaveLength(1);
});

test("pdf.js's Add Image tool is gone, and ⌘V pastes an image in the middle of the page in view", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { app, page } = await pdflion([file]);
  await expect(page.locator("#editorStamp")).toBeHidden();
  const restore = await keepClipboard(app);
  try {
    await copyRedImage(app);
    const middle = await page.evaluate(() => {
      const view = PDFViewerApplication.pdfViewer.getPageView(0);
      const page = view.div.getBoundingClientRect();
      const shown = /** @type {HTMLElement} */ (document.getElementById("viewerContainer")).getBoundingClientRect();
      const x = (Math.max(page.left, shown.left) + Math.min(page.right, shown.right)) / 2;
      const y = (Math.max(page.top, shown.top) + Math.min(page.bottom, shown.bottom)) / 2;
      return view.viewport.convertToPdfPoint(x - page.left - view.div.clientLeft, y - page.top - view.div.clientTop);
    });
    // As Edit > Paste, the paste role, sends it.
    await app.evaluate(({ webContents }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.getURL().includes("/viewer/web/viewer.html")) contents.paste();
      }
    });
    await expectSelectedImageAt(app, page, middle);
  } finally {
    await restore();
  }
});

test("an image dropped on a page goes where it's dropped, selected in the select tool", async ({
  pdflion,
}) => {
  const file = path.join(await tempDir(), "pages.pdf");
  await writeLabelled(file, 1);
  const { app, page } = await pdflion([file]);
  const [x, y] = await toWindow(page, 320, 560);
  // A dragged file, as the file manager's drop brings it.
  const dropped = await page.evaluate(
    async ([x, y]) => {
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = [40, 20];
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const data = new DataTransfer();
      data.items.add(new File([png], "red.png", { type: "image/png" }));
      const target = /** @type {Element} */ (document.elementFromPoint(x, y));
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: data };
      const over = new DragEvent("dragover", init);
      target.dispatchEvent(over);
      const drop = new DragEvent("drop", init);
      target.dispatchEvent(drop);
      return over.defaultPrevented && drop.defaultPrevented;
    },
    [x, y],
  );
  expect(dropped).toBe(true);
  await expectSelectedImageAt(app, page, [320, 560]);
});
