import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "src");
const GEOMETRY = fs.readFileSync(path.join(SRC, "viewer", "geometry.js"), "utf8");

/** Runs geometry.js the way viewer.html does, as a classic script in a page. */
function loadGeometry() {
  /** @type {any} */
  const page = {};
  page.window = page;
  vm.runInNewContext(GEOMETRY, page, { filename: "geometry.js" });
  return page.PDFLionGeometry;
}

const { resample, distanceToPolyline, hitsStroke, cutStroke } = loadGeometry();

/**
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} steps
 * @returns {number[]} a straight stroke from (x0, y0) to (x1, y1), in `steps` equal steps
 */
function line(x0, y0, x1, y1, steps) {
  return Array.from({ length: steps + 1 }, (_, i) => [
    x0 + ((x1 - x0) * i) / steps,
    y0 + ((y1 - y0) * i) / steps,
  ]).flat();
}

/**
 * Compares points from geometry.js, which are Float32Arrays from another
 * realm, with the expected ones, as float32 rounds them.
 *
 * @param {ArrayLike<number>} actual
 * @param {number[]} expected
 */
function assertPoints(actual, expected) {
  assert.equal(actual.constructor.name, "Float32Array");
  assert.equal(actual.length, expected.length, `${[...actual]} has another length than ${expected}`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-4, `${[...actual]} isn't ${expected}`);
  }
}

/**
 * @param {ArrayLike<number>[]} runs
 * @param {number[][]} expected
 */
function assertRuns(runs, expected) {
  assert.equal(runs.length, expected.length, `got ${runs.length} runs: ${runs.map((run) => `[${[...run]}]`)}`);
  runs.forEach((run, i) => assertPoints(run, expected[i]));
}

/** @param {ArrayLike<number>} points @returns {number} the longest step between two points in a row */
function longestStep(points) {
  let longest = 0;
  for (let i = 2; i < points.length; i += 2) {
    longest = Math.max(longest, Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]));
  }
  return longest;
}

describe("geometry resample", () => {
  it("adds points so that no step is longer than the given one, keeping the stroke's own", () => {
    const stroke = [0, 0, 10, 0, 10, 25];
    const points = resample(stroke, 4);
    assert.ok(longestStep(points) <= 4);
    // The 10 long segment in 3 steps, the 25 long one in 7.
    assert.equal(points.length / 2, 1 + 3 + 7);
    assertPoints(points.slice(0, 8), [0, 0, 10 / 3, 0, 20 / 3, 0, 10, 0]);
    assertPoints(points.slice(-2), [10, 25]);
  });

  it("leaves a stroke whose steps are short enough as it is", () => {
    assertPoints(resample(new Float32Array([0, 0, 3, 4, 6, 8]), 5), [0, 0, 3, 4, 6, 8]);
  });

  it("keeps repeated points", () => {
    assertPoints(resample([0, 0, 0, 0, 2, 0], 1), [0, 0, 0, 0, 1, 0, 2, 0]);
  });

  for (const step of [0, -1, Number.NaN, undefined]) {
    it(`leaves the stroke as it is for a step of ${step}`, () => {
      assertPoints(resample([0, 0, 100, 0], /** @type {number} */ (step)), [0, 0, 100, 0]);
    });
  }

  it("copies a single point, and gives nothing for no points", () => {
    assertPoints(resample([5, 6], 1), [5, 6]);
    assertPoints(resample([], 1), []);
  });
});

describe("geometry distanceToPolyline", () => {
  const stroke = [0, 0, 100, 0, 100, 100];

  it("measures to the nearest segment", () => {
    assert.equal(distanceToPolyline([50, 0], stroke), 0);
    assert.equal(distanceToPolyline([50, 10], stroke), 10);
    assert.equal(distanceToPolyline([90, 50], stroke), 10);
  });

  it("measures to the end beyond it", () => {
    assert.equal(distanceToPolyline([-3, -4], stroke), 5);
    assert.equal(distanceToPolyline([103, 104], stroke), 5);
  });

  it("measures to a single point, and to repeated ones", () => {
    assert.equal(distanceToPolyline([3, 4], [0, 0]), 5);
    assert.equal(distanceToPolyline([3, 4], new Float32Array([0, 0, 0, 0])), 5);
  });

  it("is infinite for no points", () => {
    assert.equal(distanceToPolyline([0, 0], []), Infinity);
  });
});

describe("geometry hitsStroke", () => {
  const stroke = line(0, 0, 100, 0, 10);

  it("counts the stroke's thickness", () => {
    assert.equal(hitsStroke(stroke, [50, 11], 10, 4), true);
    assert.equal(hitsStroke(stroke, [50, 13], 10, 4), false);
  });

  it("doesn't count a stroke its edge only touches", () => {
    assert.equal(hitsStroke(stroke, [50, 12], 10, 4), false);
  });

  it("hits a dot, a stroke of a single point", () => {
    assert.equal(hitsStroke([50, 50], [50, 60], 10, 1), true);
    assert.equal(hitsStroke([], [50, 60], 10, 1), false);
  });
});

describe("geometry cutStroke", () => {
  const stroke = line(0, 0, 100, 0, 10);

  it("cuts a stroke in two, where its segments cross the circle", () => {
    assertRuns(cutStroke(stroke, [55, 0], 10), [
      [0, 0, 10, 0, 20, 0, 30, 0, 40, 0, 45, 0],
      [65, 0, 70, 0, 80, 0, 90, 0, 100, 0],
    ]);
  });

  it("cuts between points further apart than the circle is wide", () => {
    const half = 10 / Math.SQRT2;
    assertRuns(cutStroke([0, 0, 100, 100], [50, 50], 10), [
      [0, 0, 50 - half, 50 - half],
      [50 + half, 50 + half, 100, 100],
    ]);
  });

  it("cuts a stroke at one end", () => {
    assertRuns(cutStroke(stroke, [0, 0], 15), [[15, 0, 20, 0, 30, 0, 40, 0, 50, 0, 60, 0, 70, 0, 80, 0, 90, 0, 100, 0]]);
    assertRuns(cutStroke(stroke, [100, 0], 15), [[0, 0, 10, 0, 20, 0, 30, 0, 40, 0, 50, 0, 60, 0, 70, 0, 80, 0, 85, 0]]);
  });

  it("cuts a stroke into three where it passes through the circle twice", () => {
    const across = Math.sqrt(15 ** 2 - 10 ** 2);
    assertRuns(cutStroke([0, 0, 100, 0, 100, 20, 0, 20], [50, 10], 15), [
      [0, 0, 50 - across, 0],
      [50 + across, 0, 100, 0, 100, 20, 50 + across, 20],
      [50 - across, 20, 0, 20],
    ]);
  });

  it("keeps points on the circle, which isn't inside it", () => {
    assertRuns(cutStroke(stroke, [50, 0], 10), [
      [0, 0, 10, 0, 20, 0, 30, 0, 40, 0],
      [60, 0, 70, 0, 80, 0, 90, 0, 100, 0],
    ]);
  });

  it("erases a stroke whole", () => {
    assertRuns(cutStroke(stroke, [50, 0], 51), []);
  });

  it("erases a drawing smaller than the circle, wherever in the circle it is", () => {
    assertRuns(cutStroke(stroke, [500, 500], 1000), []);
  });

  it("leaves a stroke the circle doesn't reach whole, as a copy", () => {
    const points = new Float32Array(stroke);
    const runs = cutStroke(points, [50, 20], 10);
    assertRuns(runs, [stroke]);
    assert.notEqual(runs[0], points);
  });

  it("leaves a stroke the circle only touches whole", () => {
    assertRuns(cutStroke(stroke, [50, 10], 10), [stroke]);
  });

  it("drops a piece too short to see, and keeps a short one", () => {
    assertRuns(cutStroke([0, 0, 20, 0], [0, 0], 19.995), []);
    assertRuns(cutStroke([0, 0, 20, 0], [0, 0], 19.9), [[19.9, 0, 20, 0]]);
  });

  it("erases a single point inside the circle, and leaves one outside", () => {
    assertRuns(cutStroke([50, 0], [52, 0], 5), []);
    assertRuns(cutStroke([50, 0], [60, 0], 5), [[50, 0]]);
  });

  it("erases repeated points inside the circle, and keeps them outside", () => {
    assertRuns(cutStroke([50, 0, 50, 0], [50, 0], 5), []);
    assertRuns(cutStroke([0, 0, 0, 0, 30, 0, 30, 0], [15, 0], 5), [
      [0, 0, 0, 0, 10, 0],
      [20, 0, 30, 0, 30, 0],
    ]);
  });

  it("gives nothing for no points, and ignores an odd number at the end", () => {
    assertRuns(cutStroke([], [0, 0], 5), []);
    assertRuns(cutStroke([0, 0, 30, 0, 99], [100, 100], 5), [[0, 0, 30, 0]]);
  });

  for (const radius of [0, -5, Number.NaN]) {
    it(`erases nothing with a radius of ${radius}`, () => {
      assertRuns(cutStroke(stroke, [50, 0], radius), [stroke]);
    });
  }
});
