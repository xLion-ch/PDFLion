import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerRange } from "../../src/shared/ranges.js";

describe("answerRange", () => {
  it("sends the whole file without a Range header", () => {
    assert.deepEqual(answerRange(null, 1000), { status: 200 });
  });

  it("sends the range bridge.js asks for", () => {
    assert.deepEqual(answerRange("bytes=0-65535", 200000), { status: 206, start: 0, end: 65535 });
    assert.deepEqual(answerRange("bytes=131072-196607", 200000), {
      status: 206,
      start: 131072,
      end: 196607,
    });
  });

  it("stops at the end of the file", () => {
    assert.deepEqual(answerRange("bytes=900-2000", 1000), { status: 206, start: 900, end: 999 });
    assert.deepEqual(answerRange("bytes=900-", 1000), { status: 206, start: 900, end: 999 });
    assert.deepEqual(answerRange("bytes=999-999", 1000), { status: 206, start: 999, end: 999 });
  });

  it("sends a suffix", () => {
    assert.deepEqual(answerRange("bytes=-100", 1000), { status: 206, start: 900, end: 999 });
    assert.deepEqual(answerRange("bytes=-5000", 1000), { status: 206, start: 0, end: 999 });
  });

  it("refuses ranges past the end", () => {
    assert.deepEqual(answerRange("bytes=1000-", 1000), { status: 416 });
    assert.deepEqual(answerRange("bytes=1000-1999", 1000), { status: 416 });
    assert.deepEqual(answerRange("bytes=99999999999999999999-", 1000), { status: 416 });
    assert.deepEqual(answerRange("bytes=-0", 1000), { status: 416 });
    assert.deepEqual(answerRange("bytes=0-", 0), { status: 416 });
    assert.deepEqual(answerRange("bytes=-10", 0), { status: 416 });
  });

  it("ignores headers it doesn't support, and sends the whole file", () => {
    for (const header of [
      "",
      "bytes=",
      "bytes=-",
      "bytes=5-1",
      "bytes=0-1,5-6",
      "bytes=a-b",
      "bytes=1.5-2",
      "bytes = 0-1",
      "items=0-1",
      "0-1",
    ]) {
      assert.deepEqual(answerRange(header, 1000), { status: 200 }, header);
    }
  });
});
