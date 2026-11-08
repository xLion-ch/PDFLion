/**
 * The web app's layout on a tablet: touch targets, and a toolbar that fits
 * every window an iPad has, from a full screen to Slide Over.
 */
import path from "node:path";
import {
  TRACEMONKEY,
  documentFrame,
  expect,
  homeFrame,
  openAppExplained,
  openFromHome,
  test,
} from "./pdflion.js";
import { longPress } from "./input.js";
import { writeLabelled } from "../e2e/pdfs.js";

/** @typedef {import("./pdflion.js").Frame} Frame */
/** @typedef {import("./pdflion.js").Page} Page */

/**
 * @param {import("@playwright/test").Locator} locator
 * @returns {Promise<{ width: number, height: number }[]>} the sizes of what
 *   it finds that shows, rounded
 */
const sizes = (locator) =>
  locator.evaluateAll((elements) =>
    elements
      .map((element) => element.getBoundingClientRect())
      .filter(({ width, height }) => width > 0 && height > 0)
      .map(({ width, height }) => ({ width: Math.round(width), height: Math.round(height) })),
  );

/**
 * @param {{ width: number, height: number }[]} found
 * @param {number} width the least
 * @param {number} height the least
 */
function expectAtLeast(found, width, height) {
  expect(found.length).toBeGreaterThan(0);
  for (const size of found) {
    expect(size.width, JSON.stringify(found)).toBeGreaterThanOrEqual(width);
    expect(size.height, JSON.stringify(found)).toBeGreaterThanOrEqual(height);
  }
}

test("a Home Screen app on iPadOS leaves room for the window's controls", async ({ page }) => {
  await openAppExplained(page);
  const top = () => page.locator("#tabs").evaluate((tabs) => tabs.getBoundingClientRect().top);
  const left = () =>
    page.locator(".tab.home").evaluate((home) => home.getBoundingClientRect().left);
  expect(await top()).toBe(0);
  expect(await left()).toBe(4);

  // iPadOS 26 draws the window's controls and its blur there.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "standalone", { get: () => true });
  });
  await page.reload();
  await homeFrame(page);
  expect(await top()).toBe(8);
  expect(await left()).toBe(72);
  const colour = (selector) =>
    page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await colour("body")).toBe(await colour("#tabs"));
});

test("touch targets are 44 px, and the toolbar's buttons 40 px", async ({ page }) => {
  await openAppExplained(page);
  await openFromHome(page, [TRACEMONKEY]);
  const viewer = await documentFrame(page, "compressed.tracemonkey-pldi-09.pdf");

  // The toolbar's buttons, also once it gives up room, and the menus' items.
  for (const width of [1366, 1024, 375]) {
    await page.setViewportSize({ width, height: 820 });
    await viewer.waitForFunction((width) => innerWidth === width, width);
    expectAtLeast(await sizes(viewer.locator("#toolbarViewer .toolbarButton:visible")), 40, 40);
  }
  await page.setViewportSize({ width: 1366, height: 820 });
  await viewer.locator("#secondaryToolbarToggleButton").tap();
  expectAtLeast(
    await sizes(viewer.locator("#secondaryToolbarButtonContainer .toolbarButton:visible")),
    100,
    44,
  );
  await viewer.locator("#secondaryToolbarToggleButton").tap();
  await viewer.locator("#pdflionEditorEraserButton").tap();
  expectAtLeast(
    await sizes(
      viewer.locator("#pdflionEditorEraserParamsToolbar :is(.pdflionEraserMode, .toggler)"),
    ),
    0,
    44,
  );

  // The strip, with two tabs.
  await page.locator("#tabs .tab.home").tap();
  const home = await homeFrame(page);
  expectAtLeast(await sizes(page.locator("#tabs .tab")), 44, 44);
  expectAtLeast(await sizes(page.locator("#tabs .tab:not(.home) .close")), 44, 44);

  // Home's buttons and cards.
  expectAtLeast(await sizes(home.locator(".button:visible, .icon:visible")), 44, 44);
  expectAtLeast(await sizes(home.locator(".card")), 44, 44);

  // The shell's menus and dialogs.
  await longPress(home, ".card");
  await expect(page.locator(".menu:popover-open .item").first()).toBeVisible();
  expectAtLeast(await sizes(page.locator(".menu:popover-open .item")), 44, 44);
  await page.locator(".menu .item", { hasText: "Rename…" }).tap();
  await expect(page.locator("dialog .button").first()).toBeVisible();
  expectAtLeast(await sizes(page.locator("dialog .button")), 44, 44);
  await page.keyboard.press("Escape");
});

/** The widths of iPads' windows, in landscape and portrait, Split View and Slide Over. */
const WIDTHS = [1366, 1180, 1024, 820, 744, 694, 600, 507, 420, 375, 320];

/** Four favourites, which need the ★ button once one doesn't fit. */
const FAVOURITES = [
  { tool: "ink", color: "#1e66f5", thickness: 1, opacity: 1 },
  { tool: "freetext", color: "#e64553", size: 24 },
  { tool: "highlight", color: "#53ffbc", thickness: 16 },
  { tool: "ink", color: "#000000", thickness: 5, opacity: 1 },
];

/**
 * Narrows the window through WIDTHS, and reads the toolbar at each.
 *
 * @param {Page} page
 * @param {Frame} frame the viewer's
 * @returns {Promise<{ width: number, overflow: number, step: number, favourites: number }[]>}
 *   at each width: by how much the ⋮ button, the toolbar's last, reaches past
 *   the window, how many of its steps the toolbar took, and how many
 *   favourites it shows
 */
async function narrow(page, frame) {
  const rows = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await frame.waitForFunction((width) => innerWidth === width, width);
    // The toolbar lays itself out as it resizes, a frame later.
    await frame.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const toolbar = await frame.evaluate(() => {
      const container = /** @type {HTMLElement} */ (document.getElementById("toolbarContainer"));
      const last = /** @type {HTMLElement} */ (
        document.getElementById("secondaryToolbarToggleButton")
      );
      return {
        overflow: Math.ceil(last.getBoundingClientRect().right - innerWidth),
        step: [...container.classList].filter((name) => name.startsWith("pdflionToolbar")).length,
        favourites: [...document.querySelectorAll("#pdflionFavourites > .pdflionFavourite")].filter(
          (button) => button.getBoundingClientRect().width > 0,
        ).length,
      };
    });
    rows.push({ width, ...toolbar });
  }
  return rows;
}

// German labels are longer than English ones, and a thousand pages make the
// page count wider.
for (const locale of ["en-US", "de-DE"]) {
  test.describe(locale, () => {
    test.use({ locale });

    test(`the toolbar fits from 1366 to 320 px, and only ever gives up more, in ${locale}`, async ({
      page,
      dir,
    }) => {
      test.setTimeout(120_000);
      const file = path.join(dir, "Pages.pdf");
      await writeLabelled(file, 1000);
      await openAppExplained(page);
      await openFromHome(page, [file]);
      const frame = await documentFrame(page, "Pages.pdf");

      for (const [label, favourites, tool] of /** @type {const} */ ([
        ["no favourites", [], false],
        ["4 favourites", FAVOURITES, false],
        ["4 favourites and Pencil", FAVOURITES, true],
      ])) {
        await page.setViewportSize({ width: 1366, height: 800 });
        await frame.evaluate(
          (favourites) => window.pdflion.setToolSettings({ favourites }),
          favourites,
        );
        await expect(frame.locator("#pdflionFavourites > .pdflionFavourite")).toHaveCount(
          favourites.length,
        );
        if (tool) await frame.locator("#editorInkButton").click();
        const rows = await narrow(page, frame);

        expect(
          rows.filter((row) => row.overflow > 0),
          label,
        ).toEqual([]);
        // As the window narrows, the toolbar only ever gives up more.
        for (const [wider, narrower] of rows.slice(0, -1).map((row, i) => [row, rows[i + 1]])) {
          expect(narrower.step, `${label}, ${narrower.width} px`).toBeGreaterThanOrEqual(
            wider.step,
          );
          expect(narrower.favourites, `${label}, ${narrower.width} px`).toBeLessThanOrEqual(
            wider.favourites,
          );
        }
        // pdf.js's own steps still come at its widths, at the latest.
        for (const [width, step] of [
          [744, 2],
          [600, 3],
          [507, 4],
        ]) {
          expect(
            rows.find((row) => row.width === width)?.step,
            `${label}, ${width} px`,
          ).toBeGreaterThanOrEqual(step);
        }
      }
    });
  });
}
