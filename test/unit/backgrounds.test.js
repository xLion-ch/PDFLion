import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "src");
const SCRIPT = fs.readFileSync(path.join(SRC, "viewer", "backgrounds.js"), "utf8");

/** Runs backgrounds.js the way viewer.html does, as a classic script in a page. */
function loadBackgrounds() {
  /** @type {any} */
  const page = {};
  page.window = page;
  vm.runInNewContext(SCRIPT, page, { filename: "backgrounds.js" });
  return page.PDFLionBackgrounds;
}

const { BACKGROUNDS, contentStream } = loadBackgrounds();

const MM = 72 / 25.4;
const A4 = [595.28, 841.89];
const LETTER = [612, 792];

/**
 * @param {string} content
 * @returns {number[][]} each `x y m x y l` segment's numbers
 */
function segments(content) {
  return [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) m (-?[\d.]+) (-?[\d.]+) l/g)].map((match) =>
    match.slice(1).map(Number),
  );
}

/**
 * @param {number[]} values
 * @returns {number[]} the gaps between neighbours, in order
 */
function gaps(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.slice(1).map((value, i) => value - sorted[i]);
}

/**
 * @param {number} actual
 * @param {number} expected
 * @param {number} [tolerance] for the 2 decimals the numbers are rounded to
 */
function near(actual, expected, tolerance = 0.011) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} isn't ${expected}`);
}

describe("backgrounds.js", () => {
  it("lists the backgrounds in the menus' order", () => {
    assert.deepEqual([...BACKGROUNDS], ["blank", "lined", "grid", "dotted", "fine-dotted", "isometric"]);
  });

  it("draws nothing on a blank page", () => {
    assert.equal(contentStream("blank", ...A4), "");
  });

  it("refuses a background it doesn't know", () => {
    // A RangeError, of the script's realm.
    assert.throws(() => contentStream("wavy", ...A4), { name: "RangeError", message: /"wavy"/ });
  });

  for (const [name, size] of [
    ["A4", A4],
    ["Letter", LETTER],
  ]) {
    it(`rules ${name} 5 mm apart, across the page, in the middle`, () => {
      const [width, height] = size;
      const content = contentStream("lined", width, height);
      assert.match(content, /^q\n0\.75 G 0\.4 w 0 J\n/);
      assert.match(content, /\nS\nQ\n$/);
      const lines = segments(content);
      for (const [x1, y1, x2, y2] of lines) {
        assert.deepEqual([x1, x2], [0, width]);
        assert.equal(y1, y2);
        assert.ok(y1 > 0 && y1 < height);
      }
      for (const gap of gaps(lines.map(([, y]) => y))) near(gap, 5 * MM);
      const ys = lines.map(([, y]) => y);
      // As far from the top as from the bottom.
      near(Math.min(...ys), height - Math.max(...ys), 0.02);
      assert.ok(lines.length >= Math.floor(height / (5 * MM)) - 1);
    });
  }

  it("squares a grid 5 mm apart, both ways", () => {
    const [width, height] = A4;
    const lines = segments(contentStream("grid", width, height));
    const rows = lines.filter(([, y1, , y2]) => y1 === y2);
    const columns = lines.filter(([x1, , x2]) => x1 === x2);
    assert.equal(rows.length + columns.length, lines.length);
    for (const [, y1, , y2] of columns) assert.deepEqual([y1, y2], [0, height]);
    for (const gap of gaps(rows.map(([, y]) => y))) near(gap, 5 * MM);
    for (const gap of gaps(columns.map(([x]) => x))) near(gap, 5 * MM);
    const xs = columns.map(([x]) => x);
    near(Math.min(...xs), width - Math.max(...xs), 0.02);
  });

  for (const [background, step, diameter] of [
    ["dotted", 5, 0.4],
    ["fine-dotted", 1, 0.2],
  ]) {
    it(`dots the page every ${step} mm, a dashed row at a time`, () => {
      const [width, height] = A4;
      const content = contentStream(background, width, height);
      // Round caps, as wide as the dots, on dashes too short to see.
      const style = content.match(/^q\n[\d.]+ G ([\d.]+) w 1 J \[0\.01 ([\d.]+)\] 0 d\n/);
      assert.ok(style, content.slice(0, 80));
      const [, lineWidth, off] = style;
      near(Number(lineWidth), diameter * MM);
      near(Number(off) + 0.01, step * MM, 0.0002);
      const rows = segments(content);
      for (const gapBetween of gaps(rows.map(([, y]) => y))) near(gapBetween, step * MM);
      // Every row starts at the first dot, and goes past the last one.
      const first = rows[0][0] + 0.005;
      const last = width - first;
      for (const [x1, y1, x2, y2] of rows) {
        assert.equal(y1, y2);
        near(x1 + 0.005, first);
        assert.ok(x2 > last + (step * MM) / 4 && x2 < width + step * MM, `${x2}`);
      }
      // The first dot is within a step of the edge, or one more, where it would
      // be too close to it.
      assert.ok(first >= 0.5 && first <= step * MM + 0.5, `${first}`);
    });
  }

  it("keeps the 1 mm dots small: a row of the page for each line of dots", () => {
    const content = contentStream("fine-dotted", ...A4);
    // Every millimetre, but too close to the edges.
    assert.equal(segments(content).length, Math.floor(A4[1] / MM) - 1);
    assert.ok(content.length < 15_000, `${content.length} bytes`);
  });

  it("draws isometric triangles with 5 mm sides, clipped to the page", () => {
    const [width, height] = A4;
    const content = contentStream("isometric", width, height);
    assert.match(content, new RegExp(`^q\\n0 0 ${width} ${height} re W n\\n0\\.75 G 0\\.4 w 0 J\\n`));
    const lines = segments(content);
    const upright = lines.filter(([x1, , x2]) => x1 === x2);
    const slanting = lines.filter(([x1, , x2]) => x1 !== x2);
    assert.equal(upright.length + slanting.length, lines.length);

    // Upright lines through the middle, the triangles' height apart.
    const xs = upright.map(([x]) => x);
    for (const gap of gaps(xs)) near(gap, (5 * MM * Math.sqrt(3)) / 2);
    assert.ok(xs.some((x) => Math.abs(x - width / 2) < 0.01));

    // Slanting lines at 30° either way, across the page, 5 mm apart upright.
    const slope = 1 / Math.sqrt(3);
    for (const sign of [1, -1]) {
      const family = slanting.filter(([x1, y1, x2, y2]) => Math.sign(y2 - y1) === sign);
      assert.ok(family.length > 0);
      for (const [x1, y1, x2, y2] of family) {
        assert.deepEqual([x1, x2], [0, width]);
        near((y2 - y1) / width, sign * slope, 0.0001);
        // Each crosses the page.
        assert.ok(Math.max(y1, y2) > 0 && Math.min(y1, y2) < height);
      }
      for (const gap of gaps(family.map(([, y]) => y))) near(gap, 5 * MM);
    }

    // The lines meet: through the middle of the page goes one of each.
    const through = (/** @type {number[]} */ [x1, y1, x2, y2]) =>
      Math.abs(y1 + ((y2 - y1) * (width / 2 - x1)) / (x2 - x1) - height / 2) < 0.02;
    assert.equal(slanting.filter(through).length, 2);
  });

  it("writes plain PDF numbers", () => {
    for (const background of BACKGROUNDS) {
      const content = contentStream(background, ...A4);
      assert.doesNotMatch(content, /e[+-]|-0\b(?!\.)|NaN|Infinity/, background);
    }
  });

  it("puts one line in the middle of a page smaller than its pattern", () => {
    assert.deepEqual(segments(contentStream("lined", 3, 3)), [[0, 1.5, 3, 1.5]]);
    for (const background of BACKGROUNDS) {
      assert.equal(typeof contentStream(background, 3, 3), "string");
    }
  });
});
