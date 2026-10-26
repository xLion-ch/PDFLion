/**
 * Where a new document window opens: where the user last left one, moved onto
 * a display if that one is gone, and stepped down and to the right of any
 * window already there, the way macOS and Windows cascade windows.
 * Kept free of Electron imports so the unit tests can run it under plain Node.
 */

/** @typedef {{ x: number, y: number, width: number, height: number }} Rectangle */

/**
 * @typedef {object} Placement
 * @property {Rectangle} bounds the window's normal (unmaximized) bounds
 * @property {boolean} maximized
 */

/** How far each cascaded window sits from the one before: about a title bar. */
export const CASCADE_STEP = 28;

/**
 * Reads a placement as state.json stores it, rejecting anything malformed.
 *
 * @param {unknown} value
 * @returns {Placement | null}
 */
export function parsePlacement(value) {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height, maximized } = /** @type {Record<string, unknown>} */ (value);
  if (![x, y, width, height].every(Number.isSafeInteger)) return null;
  const bounds = /** @type {Rectangle} */ ({ x, y, width, height });
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return { bounds, maximized: maximized === true };
}

/**
 * The bounds for a new window. It goes where `remembered` was, on the display
 * that showed most of it, moved and shrunk to fit that display's work area.
 * With nothing remembered, or no display left there, it's centered on the
 * primary display.
 *
 * @param {Rectangle | null} remembered
 * @param {{ width: number, height: number }} defaultSize when nothing is remembered
 * @param {Rectangle[]} workAreas the displays' work areas, primary first
 * @param {Rectangle[]} occupied the bounds of the windows already open
 * @returns {Rectangle}
 */
export function placeWindow(remembered, defaultSize, workAreas, occupied) {
  const display = remembered && largestOverlap(remembered, workAreas);
  const area = display ?? workAreas[0];
  const bounds = display
    ? fitInside(/** @type {Rectangle} */ (remembered), area)
    : fitInside(centerIn(remembered ?? defaultSize, area), area);
  return cascade(bounds, area, occupied);
}

/**
 * @param {Rectangle} bounds
 * @param {Rectangle[]} areas
 * @returns {Rectangle | undefined} the area that overlaps most of `bounds`
 */
function largestOverlap(bounds, areas) {
  let best;
  let bestOverlap = 0;
  for (const area of areas) {
    const overlap = intersection(bounds, area);
    if (overlap > bestOverlap) {
      best = area;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * @param {Rectangle} a
 * @param {Rectangle} b
 * @returns {number} the area of their intersection
 */
function intersection(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * @param {{ width: number, height: number }} size
 * @param {Rectangle} area
 * @returns {Rectangle}
 */
function centerIn({ width, height }, area) {
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/**
 * @param {Rectangle} bounds
 * @param {Rectangle} area
 * @returns {Rectangle} `bounds`, shrunk and moved as little as needed to lie
 *   within `area`
 */
function fitInside(bounds, area) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: clamp(bounds.x, area.x, area.x + area.width - width),
    y: clamp(bounds.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

/**
 * Steps `bounds` down and to the right while another window has the same
 * top-left corner. Past the bottom or right of `area`, it starts again from
 * the area's top-left corner.
 *
 * @param {Rectangle} bounds within `area`
 * @param {Rectangle} area
 * @param {Rectangle[]} occupied
 * @returns {Rectangle}
 */
function cascade(bounds, area, occupied) {
  let { x, y } = bounds;
  const taken = (/** @type {Rectangle} */ other) => other.x === x && other.y === y;
  // At most one step per open window, so starting over can't loop forever.
  for (let steps = 0; steps <= occupied.length && occupied.some(taken); steps++) {
    x += CASCADE_STEP;
    y += CASCADE_STEP;
    if (x + bounds.width > area.x + area.width || y + bounds.height > area.y + area.height) {
      ({ x, y } = area);
    }
  }
  return { ...bounds, x, y };
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}
