/**
 * Byte-range requests (RFC 9110, section 14) for `pdflion://app/doc/`, which
 * bridge.js uses to load big documents a part at a time, and for
 * scripts/serve-web.js.
 * Free of Electron and Node, in src/shared/, so that the web app can use it
 * too, and unit tests under plain Node.
 */

/**
 * @typedef {{ status: 200 } | { status: 206, start: number, end: number } | { status: 416 }} RangeAnswer
 *   `start` and `end` are inclusive byte offsets
 */

/**
 * What to send for a request's `Range` header: the whole file (200), one part
 * of it (206), or nothing, because the range lies past the end (416). Like
 * many servers, this ignores a header with several ranges, another unit or
 * bad syntax, and sends the whole file, as RFC 9110 allows.
 *
 * @param {string | null} header
 * @param {number} size the file's size in bytes
 * @returns {RangeAnswer}
 */
export function answerRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match) return { status: 200 };
  const [, first, last] = match;

  if (first === "") {
    // A suffix: the last `last` bytes.
    if (last === "") return { status: 200 };
    const length = Number(last);
    if (length === 0 || size === 0) return { status: 416 };
    return { status: 206, start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(first);
  const end = last === "" ? Infinity : Number(last);
  if (end < start) return { status: 200 };
  if (start >= size) return { status: 416 };
  return { status: 206, start, end: Math.min(end, size - 1) };
}
