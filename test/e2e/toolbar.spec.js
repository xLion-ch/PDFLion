import path from "node:path";
import { expect, setWidth, tempDir, test } from "./pdflion.js";
import { writeLabelled } from "./pdfs.js";

/** @typedef {import("./pdflion.js").Page} Page */
/** @typedef {import("@playwright/test").ElectronApplication} ElectronApplication */

/** Four favourites, which need the ★ button once one doesn't fit. */
const FAVOURITES = [
  { tool: "ink", color: "#1e66f5", thickness: 1, opacity: 1 },
  { tool: "freetext", color: "#e64553", size: 24 },
  { tool: "highlight", color: "#53ffbc", thickness: 16 },
  { tool: "ink", color: "#000000", thickness: 5, opacity: 1 },
];

/**
 * Narrows the window from 1400 px, or the screen's width, to 500 px in 10 px
 * steps, as far as its minimum width lets it, and reads the toolbar at each
 * width.
 *
 * @param {ElectronApplication} app
 * @param {Page} page
 * @returns {Promise<{ width: number, overflow: number, step: number, favourites: number }[]>}
 *   at each width: by how much the ⋮ button, the toolbar's last, reaches past
 *   the window, how many of its steps the toolbar took, and how many
 *   favourites it shows
 */
async function narrow(app, page) {
  const screenWidth = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize.width);
  const rows = [];
  for (let width = Math.min(1400, Math.floor(screenWidth / 10) * 10); width >= 500; width -= 10) {
    const got = await setWidth(app, page, width);
    const toolbar = await page.evaluate(() => {
      const container = /** @type {HTMLElement} */ (document.getElementById("toolbarContainer"));
      const last = /** @type {HTMLElement} */ (document.getElementById("secondaryToolbarToggleButton"));
      return {
        overflow: Math.ceil(last.getBoundingClientRect().right - innerWidth),
        step: [...container.classList].filter((name) => name.startsWith("pdflionToolbar")).length,
        favourites: [...document.querySelectorAll("#pdflionFavourites > .pdflionFavourite")].filter(
          (button) => !(/** @type {HTMLElement} */ (button).hidden),
        ).length,
      };
    });
    rows.push({ width: got, ...toolbar });
  }
  return rows;
}

// German labels are longer than English ones, and a thousand pages make the
// page count wider.
for (const lang of ["en-US", "de"]) {
  test(`the toolbar fits the window at every width, in ${lang}, with and without favourites`, async ({
    pdflion,
  }) => {
    const file = path.join(await tempDir(), "pages.pdf");
    await writeLabelled(file, 1000);
    const { app, page } = await pdflion([file], { lang });

    for (const favourites of [[], FAVOURITES]) {
      await page.evaluate((favourites) => window.pdflion.setToolSettings({ favourites }), favourites);
      await expect(page.locator("#pdflionFavourites > .pdflionFavourite")).toHaveCount(favourites.length);
      const rows = await narrow(app, page);
      const label = `${favourites.length} favourites`;

      expect(rows.filter((row) => row.overflow > 0), label).toEqual([]);
      // Wide windows keep the 40 px buttons, and show every favourite.
      for (const row of rows.filter(({ width }) => width >= 1250)) {
        expect(row, label).toMatchObject({ step: 0, favourites: favourites.length });
      }
      // As the window narrows, the toolbar only ever gives up more.
      for (const [wider, narrower] of rows.slice(0, -1).map((row, i) => [row, rows[i + 1]])) {
        expect(narrower.step, `${label}, ${narrower.width} px`).toBeGreaterThanOrEqual(wider.step);
        expect(narrower.favourites, `${label}, ${narrower.width} px`).toBeLessThanOrEqual(
          wider.favourites,
        );
      }
      // pdf.js's own steps still come at its widths, at the latest.
      for (const [width, step] of [[750, 2], [690, 3], [560, 4]]) {
        const row = rows.find((row) => row.width === width);
        if (row) expect(row.step, `${label}, ${width} px`).toBeGreaterThanOrEqual(step);
      }
    }
  });
}
