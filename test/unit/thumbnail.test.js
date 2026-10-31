import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isThumbnail,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_MAX_PIXELS,
} from "../../src/shared/thumbnail.js";

/**
 * The start of a PNG: its signature and IHDR chunk, followed by `rest` bytes.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [rest]
 * @returns {Uint8Array}
 */
function png(width, height, rest = 100) {
  const bytes = new Uint8Array(33 + rest);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

describe("isThumbnail", () => {
  it("takes a PNG of up to 512 pixels each way", () => {
    assert.ok(isThumbnail(png(360, 480)));
    assert.ok(isThumbnail(png(THUMBNAIL_MAX_PIXELS, THUMBNAIL_MAX_PIXELS)));
    assert.ok(isThumbnail(png(1, 1)));
  });

  it("takes one in a part of a larger buffer, as IPC may hand it over", () => {
    const buffer = new Uint8Array(500);
    buffer.set(png(100, 120), 50);
    assert.ok(isThumbnail(buffer.subarray(50, 50 + 133)));
  });

  for (const [description, bytes] of [
    ["a wider PNG", png(THUMBNAIL_MAX_PIXELS + 1, 100)],
    ["a taller PNG", png(100, THUMBNAIL_MAX_PIXELS + 1)],
    ["a PNG without pixels", png(0, 100)],
    ["a PNG of more than 256 KiB", png(100, 100, THUMBNAIL_MAX_BYTES)],
    ["a truncated PNG", png(100, 100).subarray(0, 28)],
    ["a JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)])],
    ["a PNG whose first chunk isn't IHDR", (() => {
      const bytes = png(100, 100);
      bytes.set([0x74, 0x45, 0x58, 0x74], 12); // tEXt
      return bytes;
    })()],
    ["no bytes", new Uint8Array(0)],
    ["an array", [...png(100, 100)]],
    ["a string", "\x89PNG"],
  ]) {
    it(`refuses ${description}`, () => {
      assert.ok(!isThumbnail(bytes));
    });
  }
});
