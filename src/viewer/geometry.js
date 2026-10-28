/**
 * Geometry for the eraser. A stroke is a flat list of x, y pairs in PDF
 * coordinates, as pdf.js's ink editors give them (`serialize(true).paths.points`),
 * and the eraser is a circle.
 *
 * protocol.js injects this classic script into viewer.html before bridge.js,
 * which finds it as `window.PDFLionGeometry`. It touches nothing in pdf.js.
 */
"use strict";

(() => {
  /**
   * Pieces of a stroke shorter than this, in PDF units, are dropped when the
   * eraser cuts it. Rounding leaves them where a stroke only grazes the
   * eraser, and pdf.js would draw each as a dot as wide as the stroke.
   */
  const SHORTEST_RUN = 0.01;

  /**
   * @typedef {ArrayLike<number>} Points x, y pairs, one after another. An odd
   *   number at the end is ignored.
   * @typedef {ArrayLike<number>} Point x, y
   */

  /**
   * Adds points along a stroke, so that no two in a row are further apart
   * than `step`, and keeps the stroke's own. The eraser's path between two
   * pointer events, resampled at under its radius, gives the places it
   * passed over.
   *
   * @param {Points} points
   * @param {number} step
   * @returns {Float32Array}
   */
  function resample(points, step) {
    const count = pointCount(points);
    if (count < 2 || !(step > 0)) return copy(points, count);
    const result = [points[0], points[1]];
    for (let i = 1; i < count; i++) {
      const [ax, ay, bx, by] = segment(points, i - 1);
      const pieces = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
      for (let piece = 1; piece < pieces; piece++) {
        const t = piece / pieces;
        result.push(ax + t * (bx - ax), ay + t * (by - ay));
      }
      result.push(bx, by);
    }
    return Float32Array.from(result);
  }

  /**
   * @param {Point} point
   * @param {Points} points a stroke, or a single point
   * @returns {number} the shortest distance from `point` to the stroke, or
   *   Infinity for no points
   */
  function distanceToPolyline(point, points) {
    const [x, y] = [point[0], point[1]];
    const count = pointCount(points);
    if (count === 0) return Infinity;
    if (count === 1) return Math.hypot(points[0] - x, points[1] - y);
    let shortest = Infinity;
    for (let i = 0; i < count - 1; i++) {
      shortest = Math.min(shortest, distanceToSegment(x, y, ...segment(points, i)));
    }
    return shortest;
  }

  /**
   * Whether the eraser touches a stroke's ink: whether it comes closer to the
   * stroke than its radius plus half the stroke's thickness.
   *
   * @param {Points} stroke
   * @param {Point} center the eraser's
   * @param {number} radius the eraser's
   * @param {number} thickness the stroke's
   * @returns {boolean}
   */
  function hitsStroke(stroke, center, radius, thickness) {
    return distanceToPolyline(center, stroke) < radius + thickness / 2;
  }

  /**
   * Cuts away the parts of a stroke inside a circle, exactly where its
   * segments cross the circle. To clear the ink under the eraser, pass its
   * radius plus half the stroke's thickness, since a stroke's round ends
   * reach that far past its points.
   *
   * @param {Points} points
   * @param {Point} center
   * @param {number} radius
   * @returns {Float32Array[]} what's left: the whole stroke if the circle
   *   doesn't reach it, otherwise each run of two points or more outside the
   *   circle, and none if it's all inside
   */
  function cutStroke(points, center, radius) {
    const count = pointCount(points);
    if (count === 0) return [];
    if (!(radius > 0) || distanceToPolyline(center, points) >= radius) {
      return [copy(points, count)];
    }
    const [cx, cy] = [center[0], center[1]];
    /** @type {Float32Array[]} */
    const runs = [];
    /** @type {number[] | null} the run being collected */
    let run = null;
    const endRun = () => {
      if (run && run.length >= 4 && runLength(run) >= SHORTEST_RUN) runs.push(Float32Array.from(run));
      run = null;
    };
    for (let i = 0; i < count - 1; i++) {
      const [ax, ay, bx, by] = segment(points, i);
      const inside = insideOfCircle(ax, ay, bx, by, cx, cy, radius);
      if (!inside) {
        run ??= [ax, ay];
        run.push(bx, by);
        continue;
      }
      const [enter, leave] = inside;
      if (enter > 0) {
        run ??= [ax, ay];
        run.push(ax + enter * (bx - ax), ay + enter * (by - ay));
      }
      endRun();
      if (leave < 1) run = [ax + leave * (bx - ax), ay + leave * (by - ay), bx, by];
    }
    endRun();
    return runs;
  }

  /**
   * @param {number} ax
   * @param {number} ay
   * @param {number} bx
   * @param {number} by
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @returns {[number, number] | null} where the segment from a to b is
   *   inside the circle, from 0 at a to 1 at b, or null if it only touches
   *   the circle or misses it
   */
  function insideOfCircle(ax, ay, bx, by, cx, cy, radius) {
    // Where |a + t (b − a) − c| = radius: a quadratic in t.
    const [dx, dy] = [bx - ax, by - ay];
    const [fx, fy] = [ax - cx, ay - cy];
    const a = dx * dx + dy * dy;
    const c = fx * fx + fy * fy - radius * radius;
    // A repeated point.
    if (a === 0) return c < 0 ? [0, 1] : null;
    const b = 2 * (fx * dx + fy * dy);
    const discriminant = b * b - 4 * a * c;
    if (discriminant <= 0) return null;
    const root = Math.sqrt(discriminant);
    const enter = Math.max((-b - root) / (2 * a), 0);
    const leave = Math.min((-b + root) / (2 * a), 1);
    return enter < leave ? [enter, leave] : null;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} ax
   * @param {number} ay
   * @param {number} bx
   * @param {number} by
   * @returns {number} the distance from (x, y) to the segment from a to b
   */
  function distanceToSegment(x, y, ax, ay, bx, by) {
    const [dx, dy] = [bx - ax, by - ay];
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / lengthSquared, 0), 1);
    return Math.hypot(ax + t * dx - x, ay + t * dy - y);
  }

  /**
   * @param {Points} points
   * @param {number} index
   * @returns {[number, number, number, number]} the segment from point
   *   `index` to the next
   */
  function segment(points, index) {
    const i = 2 * index;
    return [points[i], points[i + 1], points[i + 2], points[i + 3]];
  }

  /**
   * @param {number[]} run
   * @returns {number} how long the run is, along its segments
   */
  function runLength(run) {
    let length = 0;
    for (let i = 2; i < run.length; i += 2) {
      length += Math.hypot(run[i] - run[i - 2], run[i + 1] - run[i - 1]);
    }
    return length;
  }

  /** @param {Points} points */
  function pointCount(points) {
    return Math.floor(points.length / 2);
  }

  /**
   * @param {Points} points
   * @param {number} count
   * @returns {Float32Array} the first `count` points
   */
  function copy(points, count) {
    return Float32Array.from({ length: 2 * count }, (_, i) => points[i]);
  }

  window.PDFLionGeometry = Object.freeze({
    resample,
    distanceToPolyline,
    hitsStroke,
    cutStroke,
  });
})();
