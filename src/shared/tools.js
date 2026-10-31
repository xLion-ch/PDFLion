/**
 * The tool settings PDFLion remembers, which every tab shares: the eraser's
 * mode and size, whether only a pen draws, and the favourites, each a drawing
 * tool with its settings.
 * They come from the viewer, whose messages main checks, and from
 * state.json, which an earlier version or a hand edit may have left, so this
 * module checks them, and rebuilds each from its known fields.
 * Free of Electron and Node, in src/shared/, so that the web app can use it
 * too, and unit tests under plain Node.
 */

/** The eraser's modes: erasing the parts of strokes under it, or whole drawings. */
const ERASER_MODES = ["line", "object"];

/** The eraser's size, in points, as its slider allows. */
const ERASER_SIZE = { min: 2, max: 50 };

/**
 * @typedef {object} EraserSettings
 * @property {"line" | "object"} mode
 * @property {number} size in points
 */

/** @type {Readonly<EraserSettings>} */
export const DEFAULT_ERASER = Object.freeze({ mode: "object", size: 10 });

/**
 * The settings a favourite has besides its colour, for each drawing tool,
 * with the ranges of pdf.js's inputs for them in web/viewer.html:
 * #editorInkThickness and #editorInkOpacity for Pencil, #editorFreeTextFontSize
 * for Text, and #editorFreeHighlightThickness for Highlight.
 * @type {Record<string, Record<string, [number, number]>>}
 */
const TOOLS = {
  ink: { thickness: [1, 20], opacity: [0.05, 1] },
  freetext: { size: [5, 100] },
  highlight: { thickness: [8, 24] },
};

/** What the viewer may change, any of them at once. */
const SETTINGS = ["eraser", "penOnly", "favourites"];

/**
 * Far more than anyone saves. It only keeps the messages and state.json
 * small.
 */
export const MAX_FAVOURITES = 500;

/**
 * @typedef {object} Favourite
 * @property {"ink" | "freetext" | "highlight"} tool pdf.js's name for it
 * @property {string} color `#rrggbb`, in lower case
 * @property {number} [thickness] for ink and highlight
 * @property {number} [opacity] for ink
 * @property {number} [size] for freetext
 */

/**
 * @typedef {object} ToolSettings
 * @property {EraserSettings} eraser
 * @property {boolean} penOnly whether only a pen draws in the drawing tools,
 *   while fingers scroll and zoom, as iPadOS's "Only Draw with Apple Pencil"
 * @property {Favourite[]} favourites
 */

/**
 * @param {unknown} value
 * @returns {EraserSettings | null}
 */
export function parseEraser(value) {
  if (!isRecord(value)) return null;
  const { mode, size } = value;
  if (typeof mode !== "string" || !ERASER_MODES.includes(mode)) return null;
  if (!isInRange(size, ERASER_SIZE.min, ERASER_SIZE.max)) return null;
  return { mode: /** @type {EraserSettings["mode"]} */ (mode), size };
}

/**
 * @param {unknown} value
 * @returns {Favourite | null} the favourite, with only the settings its tool
 *   has, or null if it's no favourite
 */
export function parseFavourite(value) {
  if (!isRecord(value)) return null;
  const { tool, color } = value;
  if (typeof tool !== "string" || !Object.hasOwn(TOOLS, tool)) return null;
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  /** @type {Record<string, unknown>} */
  const favourite = { tool, color: color.toLowerCase() };
  for (const [name, [min, max]] of Object.entries(TOOLS[tool])) {
    if (!isInRange(value[name], min, max)) return null;
    favourite[name] = value[name];
  }
  return /** @type {Favourite} */ (favourite);
}

/**
 * @param {unknown} value
 * @returns {Favourite[] | null} the favourites, without repeats, or null
 *   unless every one is a favourite and there are at most MAX_FAVOURITES
 */
export function parseFavourites(value) {
  if (!Array.isArray(value) || value.length > MAX_FAVOURITES) return null;
  const favourites = value.map(parseFavourite);
  if (favourites.includes(null)) return null;
  return withoutRepeats(/** @type {Favourite[]} */ (favourites));
}

/**
 * Checks what the viewer sends to change: the eraser's settings, whether
 * only a pen draws, the favourites, or several of them.
 *
 * @param {unknown} value
 * @returns {Partial<ToolSettings> | null} the changes, or null if anything in
 *   them is wrong
 */
export function parseToolSettings(value) {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !SETTINGS.includes(key))) return null;
  /** @type {Partial<ToolSettings>} */
  const settings = {};
  if (Object.hasOwn(value, "eraser")) {
    const eraser = parseEraser(value.eraser);
    if (!eraser) return null;
    settings.eraser = eraser;
  }
  if (Object.hasOwn(value, "penOnly")) {
    if (typeof value.penOnly !== "boolean") return null;
    settings.penOnly = value.penOnly;
  }
  if (Object.hasOwn(value, "favourites")) {
    const favourites = parseFavourites(value.favourites);
    if (!favourites) return null;
    settings.favourites = favourites;
  }
  return settings;
}

/**
 * Reads the tool settings as state.json stores them. Whatever's wrong is
 * left out: the eraser's settings fall back to the defaults, pen-only drawing
 * is off unless it's on, and favourites that aren't are dropped.
 *
 * @param {unknown} toolSettings the `toolSettings` key: `{ eraser, penOnly }`
 * @param {unknown} favourites the `favourites` key
 * @returns {ToolSettings}
 */
export function readToolSettings(toolSettings, favourites) {
  const eraser = isRecord(toolSettings) ? parseEraser(toolSettings.eraser) : null;
  const list = Array.isArray(favourites) ? favourites.map(parseFavourite) : [];
  return {
    eraser: eraser ?? { ...DEFAULT_ERASER },
    penOnly: isRecord(toolSettings) && toolSettings.penOnly === true,
    favourites: withoutRepeats(list.filter((favourite) => favourite !== null)).slice(
      0,
      MAX_FAVOURITES,
    ),
  };
}

/**
 * @param {Favourite[]} favourites
 * @param {Favourite} favourite
 * @returns {Favourite[]} the favourites without `favourite`
 */
export function removeFavourite(favourites, favourite) {
  const key = favouriteKey(favourite);
  return favourites.filter((other) => favouriteKey(other) !== key);
}

/**
 * @param {Favourite[]} favourites
 * @returns {Favourite[]} the first of each set of equal favourites
 */
function withoutRepeats(favourites) {
  const seen = new Set();
  return favourites.filter((favourite) => {
    const key = favouriteKey(favourite);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {Favourite} favourite as parseFavourite() makes it, with its fields
 *   in a fixed order
 * @returns {string} the same for equal favourites only
 */
function favouriteKey(favourite) {
  return JSON.stringify(favourite);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>} whether it's a plain object
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {value is number}
 */
function isInRange(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
