/**
 * The thumbnails Home shows: the first page of each recent document, which
 * the viewer renders as a PNG. Main stores what the viewer sends without
 * decoding it, so this checks it first, from its header alone: a PNG, small
 * enough to show on a card and to keep.
 * Free of Electron and Node, in src/shared/, so that the web app can use it
 * too, and unit tests under plain Node.
 */

/** The most pixels a thumbnail has across or down. bridge.js renders to fit. */
export const THUMBNAIL_MAX_PIXELS = 512;

/** The most bytes a thumbnail has. bridge.js renders smaller until it fits. */
export const THUMBNAIL_MAX_BYTES = 256 * 1024;

/** What every PNG starts with, then its IHDR chunk's length and type. */
const PNG_START = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
];

/**
 * @param {unknown} bytes
 * @returns {bytes is Uint8Array} whether `bytes` is a PNG, by its signature
 *   and header, of at most THUMBNAIL_MAX_PIXELS each way and
 *   THUMBNAIL_MAX_BYTES in all
 */
export function isThumbnail(bytes) {
  if (!(bytes instanceof Uint8Array)) return false;
  // The signature, the IHDR chunk's 8-byte head and its 13 bytes of data.
  if (bytes.length < 29 || bytes.length > THUMBNAIL_MAX_BYTES) return false;
  if (PNG_START.some((byte, index) => bytes[index] !== byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return (
    width > 0 &&
    height > 0 &&
    width <= THUMBNAIL_MAX_PIXELS &&
    height <= THUMBNAIL_MAX_PIXELS
  );
}
