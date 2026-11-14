/**
 * The backgrounds Insert Page offers: what each draws on a new page, as a PDF
 * content stream in the page's own coordinates, light grey, to write and draw
 * over.
 *
 * protocol.js injects this classic script into viewer.html before bridge.js,
 * which finds it as `window.PDFLionBackgrounds`. It touches nothing in pdf.js.
 */
"use strict";

(() => {
  /** A millimetre, in PDF points of 1/72 inch. */
  const MM = 72 / 25.4;

  /** The backgrounds, in the order Insert Page's menus list them. */
  const BACKGROUNDS = Object.freeze([
    "blank",
    "lined",
    "grid",
    "dotted",
    "fine-dotted",
    "isometric",
  ]);

  /** The lines of Lined, Grid and Isometric, in points, and their grey. */
  const LINE = Object.freeze({ width: 0.4, gray: 0.75 });

  /** Dots: how far apart, how wide, in points, and their grey. */
  const DOTS = Object.freeze({
    dotted: Object.freeze({ step: 5 * MM, width: 0.4 * MM, gray: 0.55 }),
    "fine-dotted": Object.freeze({ step: 1 * MM, width: 0.2 * MM, gray: 0.7 }),
  });

  /** How far apart Lined's and Grid's lines are, and Isometric's triangles' sides. */
  const STEP = 5 * MM;

  /** Lines and dots closer than this to the page's edge are left out, in points. */
  const EDGE = 0.5;

  /**
   * @param {string} background one of BACKGROUNDS
   * @param {number} width the page's width, in points
   * @param {number} height the page's height, in points
   * @returns {string} the operators that draw it, "" for "blank"
   */
  function contentStream(background, width, height) {
    switch (background) {
      case "blank":
        return "";
      case "lined":
        return lines(rows(width, height));
      case "grid":
        return lines([...rows(width, height), ...columns(width, height)]);
      case "dotted":
      case "fine-dotted":
        return dots(DOTS[background], width, height);
      case "isometric":
        return isometric(width, height);
      default:
        throw new RangeError(`No background "${background}"`);
    }
  }

  /**
   * @param {number} length
   * @param {number} step
   * @returns {number[]} places `step` apart across `length`, as many as fit,
   *   with what's left over shared equally between both ends, so that the
   *   pattern sits in the middle of the page, but none at the edges
   */
  function across(length, step) {
    const count = Math.floor(length / step + 1e-9);
    const start = (length - count * step) / 2;
    const places = [];
    for (let i = 0; i <= count; i++) {
      const place = start + i * step;
      if (place >= EDGE && place <= length - EDGE) places.push(place);
    }
    return places;
  }

  /**
   * @param {number} width
   * @param {number} height
   * @returns {number[][]} Lined's lines, from one side of the page to the other
   */
  function rows(width, height) {
    return across(height, STEP).map((y) => [0, y, width, y]);
  }

  /**
   * @param {number} width
   * @param {number} height
   * @returns {number[][]} Grid's lines from the bottom to the top
   */
  function columns(width, height) {
    return across(width, STEP).map((x) => [x, 0, x, height]);
  }

  /**
   * @param {number[][]} segments each x1, y1, x2, y2
   * @param {string} [setup] operators before the lines', such as a clip
   * @returns {string} the segments stroked in the lines' width and grey
   */
  function lines(segments, setup = "") {
    if (segments.length === 0) return "";
    const path = segments
      .map(([x1, y1, x2, y2]) => `${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l`)
      .join("\n");
    return `q\n${setup}${n(LINE.gray)} G ${n(LINE.width)} w 0 J\n${path}\nS\nQ\n`;
  }

  /**
   * Each row of dots is one line, dashed into dashes too short to see, whose
   * round caps are the dots. That keeps 1 mm dots small: a row of a page,
   * rather than a path for each dot.
   *
   * @param {{ step: number, width: number, gray: number }} style
   * @param {number} width
   * @param {number} height
   * @returns {string}
   */
  function dots({ step, width: diameter, gray }, width, height) {
    const xs = across(width, step);
    const ys = across(height, step);
    if (xs.length === 0 || ys.length === 0) return "";
    const dash = 0.01;
    // Each dash's middle on a dot's place, and past the last, so that
    // rounding can't cut it off.
    const [from, to] = [xs[0] - dash / 2, xs.at(-1) + step / 2];
    const path = ys.map((y) => `${n(from)} ${n(y)} m ${n(to)} ${n(y)} l`).join("\n");
    const pattern = `[${dash} ${n(step - dash, 4)}] 0 d`;
    return `q\n${n(gray)} G ${n(diameter)} w 1 J ${pattern}\n${path}\nS\nQ\n`;
  }

  /**
   * Isometric paper: equilateral triangles with 5 mm sides, of upright lines
   * and lines at 30° either way, which meet in the middle of the page. The
   * slanting lines go from one side of the page to the other, clipped to it.
   *
   * @param {number} width
   * @param {number} height
   * @returns {string}
   */
  function isometric(width, height) {
    const apart = (STEP * Math.sqrt(3)) / 2;
    const [cx, cy] = [width / 2, height / 2];
    /** @type {number[][]} */
    const segments = [];
    // Upright lines through the middle and every `apart` from it.
    for (let i = -Math.ceil(cx / apart); i <= Math.ceil(cx / apart); i++) {
      const x = cx + i * apart;
      if (x >= EDGE && x <= width - EDGE) segments.push([x, 0, x, height]);
    }
    // Slanting lines through the middle and every STEP above and below it.
    const reach = Math.ceil((height + width) / STEP);
    for (const slope of [1 / Math.sqrt(3), -1 / Math.sqrt(3)]) {
      for (let k = -reach; k <= reach; k++) {
        const left = cy - slope * cx + k * STEP;
        const right = left + slope * width;
        if (Math.max(left, right) > 0 && Math.min(left, right) < height) {
          segments.push([0, left, width, right]);
        }
      }
    }
    return lines(segments, `0 0 ${n(width)} ${n(height)} re W n\n`);
  }

  /**
   * @param {number} value
   * @param {number} [decimals]
   * @returns {string} `value` rounded, without trailing zeros, as PDF numbers
   *   are written: no exponent, and no "-0"
   */
  function n(value, decimals = 2) {
    const factor = 10 ** decimals;
    const rounded = Math.round(value * factor) / factor;
    return String(rounded === 0 ? 0 : rounded);
  }

  window.PDFLionBackgrounds = Object.freeze({ BACKGROUNDS, contentStream });
})();
