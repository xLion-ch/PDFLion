/**
 * Pens and touchscreens on the desktop, such as a Surface's: pen-only
 * drawing and long presses, with trusted input through the DevTools
 * protocol, as Chromium has it from a pen and a finger.
 */
import { expect, tempDir, test, tracemonkey } from "./pdflion.js";

/** @typedef {import("./pdflion.js").Page} Page */

/**
 * Trusted input in a tab: a pen, as `Input.dispatchMouseEvent` with
 * `pointerType: "pen"`, and fingers, as `Input.dispatchTouchEvent`, which
 * need touch events on.
 *
 * @param {Page} page
 */
async function inputOf(page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  return {
    /**
     * Draws with a pen along points, in the page's CSS pixels.
     *
     * @param {{ x: number, y: number }[]} points
     */
    async pen(points) {
      const pen = { pointerType: "pen", force: 0.5 };
      const last = /** @type {{ x: number, y: number }} */ (points.at(-1));
      await session.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...points[0],
        ...pen,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      for (const point of points.slice(1)) {
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
          ...pen,
          buttons: 1,
        });
      }
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...last,
        ...pen,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    },
    /**
     * Drags a finger along points, in the page's CSS pixels.
     *
     * @param {{ x: number, y: number }[]} points
     * @param {number} [hold] ms to keep it down before it moves
     */
    async finger(points, hold = 0) {
      const send = (/** @type {string} */ type, /** @type {object[]} */ touchPoints) =>
        session.send("Input.dispatchTouchEvent", { type, touchPoints });
      await send("touchStart", [{ ...points[0], id: 1 }]);
      if (hold) await new Promise((resolve) => setTimeout(resolve, hold));
      for (const point of points.slice(1)) await send("touchMove", [{ ...point, id: 1 }]);
      await send("touchEnd", []);
    },
  };
}

/**
 * @param {Page} page
 * @param {number} fromX share of the first page's width
 * @param {number} toX
 * @param {number} y share of the height of the part of it in view
 * @returns {Promise<{ x: number, y: number }[]>} points across it
 */
async function across(page, fromX, toX, y) {
  const box = await page.evaluate(() => {
    const page = /** @type {Element} */ (document.querySelector('.page[data-page-number="1"]'));
    const view = /** @type {Element} */ (
      document.getElementById("viewerContainer")
    ).getBoundingClientRect();
    const { left, width, top, bottom } = page.getBoundingClientRect();
    const visibleTop = Math.max(top, view.top);
    return { left, width, top: visibleTop, height: Math.min(bottom, view.bottom) - visibleTop };
  });
  return Array.from({ length: 11 }, (_, i) => ({
    x: box.left + box.width * (fromX + ((toX - fromX) * i) / 10),
    y: box.top + box.height * y,
  }));
}

/**
 * @param {Page} page
 * @returns {Promise<string[]>} the first page's drawings, once Pencil's open
 *   one has ended, as Esc ends it
 */
const drawings = (page) =>
  page.evaluate(() => {
    const ui = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
    ui.unselectAll();
    ui.unselectAll();
    return [...ui.getEditors(0)].map((/** @type {any} */ editor) => editor.editorType);
  });

/** @param {Page} page */
const toolSettings = (page) => page.evaluate(() => window.pdflion.getToolSettings());

/** @param {Page} page */
const scrollTop = (page) =>
  page.evaluate(() => document.getElementById("viewerContainer")?.scrollTop ?? 0);

test("a pen turns pen-only drawing on, after which fingers scroll and draw nothing, until it's off", async ({
  pdflion,
}) => {
  const { page } = await pdflion([await tracemonkey(await tempDir())]);
  const input = await inputOf(page);
  await page.locator("#editorInkButton").click();
  const penOnly = page.locator("#pdflionInkPenOnly");
  await expect(penOnly).toHaveAttribute("aria-pressed", "false");

  await input.pen(await across(page, 0.1, 0.4, 0.3));
  expect(await drawings(page)).toEqual(["ink"]);
  await expect(penOnly).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => toolSettings(page)).toMatchObject({ penOnly: true, penOnlyChosen: true });

  // A finger scrolls the page, with Pencil on.
  const before = await scrollTop(page);
  const swipe = (await across(page, 0.3, 0.3, 0.8)).map((point, i) => ({
    ...point,
    y: point.y - i * 20,
  }));
  await input.finger(swipe);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(before + 50);
  expect(await drawings(page)).toEqual(["ink"]);

  // Turned off, and with Pencil chosen again, which pdf.js needs to take
  // another kind of pointer, a finger draws.
  await penOnly.click();
  await expect
    .poll(() => toolSettings(page))
    .toMatchObject({ penOnly: false, penOnlyChosen: true });
  await page.locator("#editorInkButton").click();
  await page.locator("#editorInkButton").click();
  await input.finger(await across(page, 0.1, 0.4, 0.5));
  expect(await drawings(page)).toEqual(["ink", "ink"]);

  // Chosen by hand, it stays off for the next pen.
  await input.pen(await across(page, 0.1, 0.4, 0.6));
  await expect(penOnly).toHaveAttribute("aria-pressed", "false");
});

test("a long press of a finger on a favourite shows its menu", async ({ pdflion }) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      const main = /** @type {any} */ (globalThis);
      main.contextMenu = this;
      main.popups = (main.popups ?? 0) + 1;
    };
  });
  // Touch events on make the pointer coarse, which lays the toolbar out anew.
  const input = await inputOf(page);
  const pencil = { tool: "ink", color: "#1e66f5", thickness: 1, opacity: 1 };
  await page.evaluate((pencil) => window.pdflion.setToolSettings({ favourites: [pencil] }), pencil);
  const favourite = page.locator("#pdflionFavourites > .pdflionFavourite");
  await expect(favourite).toBeVisible();
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (
    await favourite.boundingBox()
  );
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await input.finger([center, center], 800);
  await expect
    .poll(() =>
      app.evaluate(() =>
        /** @type {any} */ (globalThis).contextMenu?.items.map(
          (/** @type {Electron.MenuItem} */ item) => item.label,
        ),
      ),
    )
    .toEqual(["Remove Favourite"]);
  // Only once, whether Chromium's own long press comes too or not, and
  // without using the favourite.
  await page.waitForTimeout(500);
  expect(await app.evaluate(() => /** @type {any} */ (globalThis).popups)).toBe(1);
  expect(await page.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode)).toBe(0);
});
