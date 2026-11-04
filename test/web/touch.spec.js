/**
 * Fingers in the web app: taps on PDFLion's buttons, pinching, long presses,
 * and no zooming of the app itself.
 */
import {
  TRACEMONKEY,
  documentFrame,
  expect,
  homeFrame,
  openAppExplained,
  openFromHome,
  stripTabs,
  test,
} from "./pdflion.js";
import { dispatch, inViewer, line, longPress, pencilStroke, touchscreen } from "./input.js";

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
 * @param {Page} page
 * @returns {Promise<string[]>} the items of the menu the shell shows
 */
const menuItems = (page) => page.locator(".menu:popover-open .item").allTextContents();

test("a tap on PDFLion's buttons does what a click does", async ({ page }) => {
  const frame = await openPaper(page);
  const outer = frame.locator("#outerContainer");

  await frame.locator("#pdflionPageOverview").tap();
  await expect(outer).toHaveClass(/pdflionPageOverview/);
  await frame.locator("#pdflionPageOverview").tap();
  await expect(outer).not.toHaveClass(/pdflionPageOverview/);

  const eraser = frame.locator("#pdflionEditorEraserButton");
  await eraser.tap();
  await expect(eraser).toHaveAttribute("aria-expanded", "true");
  await eraser.tap();
  await expect(eraser).toHaveAttribute("aria-expanded", "false");

  await frame.locator("#pdflionInsertBlankPage").tap();
  await expect.poll(() => frame.evaluate(() => PDFViewerApplication.pagesCount)).toBe(15);

  // Home, and the strip's tabs and close buttons.
  await frame.locator("#pdflionHomeButton").tap();
  await homeFrame(page);
  // Home's frame is there from the start, so the strip says when it shows.
  await expect.poll(() => stripTabs(page)).toMatchObject([
    { home: true, active: true },
    { name: NAME, active: false },
  ]);
  await page.locator("#tabs .tab:not(.home)").tap();
  await expect.poll(() => stripTabs(page)).toMatchObject([{ active: false }, { active: true }]);
  await page.locator("#tabs .tab.home").tap();
  await expect.poll(() => stripTabs(page)).toMatchObject([{ active: true }, { active: false }]);
  await page.locator("#tabs .tab:not(.home) .close").tap();
  await expect.poll(() => stripTabs(page)).toMatchObject([{ home: true, active: true }]);
});

test("a pinch on the pages zooms the document, not the app, also with Pencil on", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Only Chromium has trusted touches");
  const frame = await openPaper(page);
  await frame.locator("#editorInkButton").tap();
  // A pen turns pen-only drawing on, for fingers to pinch with Pencil on.
  await pencilStroke(frame, line([0.2, 0.3], [0.6, 0.3]));
  const scale = () => frame.evaluate(() => PDFViewerApplication.pdfViewer.currentScale);
  const before = await scale();
  const toolbar = await frame.locator("#toolbarContainer").boundingBox();

  const touch = await touchscreen(page);
  await touch.pinch(await inViewer(frame, [0.5, 0.6]), 100, 300);
  await expect.poll(scale).toBeGreaterThan(before * 1.5);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  expect(await frame.evaluate(() => visualViewport?.scale)).toBe(1);
  expect(await frame.locator("#toolbarContainer").boundingBox()).toEqual(toolbar);
});

test("a long press on a favourite opens its menu without using it, and a drag after it closes it", async ({
  page,
}) => {
  const frame = await openPaper(page);
  const blue = { tool: "ink", color: "#1e66f5", thickness: 7, opacity: 1 };
  await frame.evaluate((blue) => window.pdflion.setToolSettings({ favourites: [blue] }), blue);
  const favourite = "#pdflionFavourites > .pdflionFavourite";
  await expect(frame.locator(favourite)).toHaveCount(1);
  const mode = () => frame.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode);

  // A short press is a tap, which opens nothing.
  await longPress(frame, favourite, 100);
  await expect(page.locator(".menu")).toHaveCount(0);

  await longPress(frame, favourite);
  await expect.poll(() => menuItems(page)).toEqual(["Remove Favourite"]);
  // The click that may follow the lift doesn't use the favourite.
  await frame.locator(favourite).dispatchEvent("click");
  expect(await mode()).toBe(0);
  // A tap elsewhere closes the menu.
  await frame.locator("#viewerContainer").tap({ position: { x: 20, y: 200 } });
  await expect(page.locator(".menu")).toHaveCount(0);

  await longPress(frame, favourite);
  await expect.poll(() => menuItems(page)).toEqual(["Remove Favourite"]);
  await frame.locator(favourite).dispatchEvent("dragstart");
  await expect(page.locator(".menu")).toHaveCount(0);

  // A press that moves is no long press.
  await dispatch(frame, favourite, [
    { type: "pointerdown", at: [0.5, 0.5], pointerType: "touch", pointerId: 30 },
    { type: "pointermove", at: [0.5, 3], pointerType: "touch", pointerId: 30, wait: 100 },
    { type: "pointerup", at: [0.5, 3], pointerType: "touch", pointerId: 30, wait: 600 },
  ]);
  await expect(page.locator(".menu")).toHaveCount(0);

  // Then a tap uses it.
  await frame.locator(favourite).tap();
  await expect.poll(mode).toBe(15);
});

test("a long press on a Home card or a tab opens its menu", async ({ page }) => {
  await openPaper(page);
  const frame = await documentFrame(page, NAME);
  await frame.locator("#pdflionHomeButton").tap();
  const home = await homeFrame(page);

  await longPress(home, ".card");
  await expect.poll(() => menuItems(page)).toEqual(["Open", "Share…", "Rename…", "Delete…"]);
  // Its tab stays Home.
  expect((await stripTabs(page)).find(({ active }) => active)?.home).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".menu")).toHaveCount(0);

  await longPress(page.mainFrame(), "#tabs .tab:not(.home)");
  await expect.poll(() => menuItems(page)).toEqual(["Close Tab", "Close Other Tabs", "Share…"]);
});

test("a pinch or a double tap on the toolbar, the strip or Home zooms nothing", async ({
  page,
}) => {
  const frame = await openPaper(page);
  await frame.locator("#pdflionHomeButton").tap();
  const home = await homeFrame(page);

  /**
   * @param {Frame} where
   * @param {string} selector
   * @param {string} container where its touch-action is set, which browsers
   *   combine with its elements' own
   * @returns {Promise<{ touchAction: string, pinchStopped: boolean }>}
   *   whether a double tap would zoom there, and whether a pinch's start was
   *   stopped, which in Safari would zoom the app
   */
  const zooming = (where, selector, container) =>
    where
      .locator(selector)
      .first()
      .evaluate((element, container) => {
        const gesture = new Event("gesturestart", { bubbles: true, cancelable: true });
        element.dispatchEvent(gesture);
        const { touchAction } = getComputedStyle(
          /** @type {Element} */ (element.closest(container)),
        );
        return { touchAction, pinchStopped: gesture.defaultPrevented };
      }, container);

  const neither = { touchAction: "manipulation", pinchStopped: true };
  expect(await zooming(frame, "#pdflionPageOverview", "#toolbarContainer")).toEqual(neither);
  expect(await zooming(page.mainFrame(), "#tabs .tab", "body")).toEqual(neither);
  expect(await zooming(home, ".card", "html")).toEqual(neither);
  // On the pages, pdf.js zooms the document.
  expect((await zooming(frame, "#viewerContainer .page", "html")).pinchStopped).toBe(false);
});
