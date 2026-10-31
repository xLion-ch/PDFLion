import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { A4, LETTER, blankPdf, paperSize } from "../../src/shared/blank.js";

/** @param {Uint8Array} bytes */
const text = (bytes) => new TextDecoder("latin1").decode(bytes);

/**
 * Reads the cross-reference table the way a PDF reader starts: from the
 * offset after the last `startxref`.
 *
 * @param {string} pdf
 * @returns {{ xref: number, entries: string[], trailer: string }}
 */
function readXref(pdf) {
  const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)?.[1]);
  const [header, count] = pdf.slice(xref).split("\n", 2);
  assert.equal(header, "xref");
  const [first, size] = count.split(" ").map(Number);
  assert.equal(first, 0);
  const start = xref + "xref\n".length + count.length + 1;
  const entries = [];
  for (let index = 0; index < size; index++) {
    entries.push(pdf.slice(start + index * 20, start + (index + 1) * 20));
  }
  const trailer = pdf.slice(start + size * 20);
  return { xref, entries, trailer };
}

describe("blankPdf", () => {
  const pdf = text(blankPdf(A4));

  it("starts with a PDF header and ends with %%EOF", () => {
    assert.ok(pdf.startsWith("%PDF-1.7\n"));
    assert.ok(pdf.endsWith("%%EOF\n"));
  });

  it("points startxref at the cross-reference table", () => {
    const { xref } = readXref(pdf);
    assert.ok(pdf.startsWith("xref\n", xref));
    assert.equal(pdf.indexOf("xref\n"), xref);
  });

  it("points each cross-reference entry at its object", () => {
    const { entries } = readXref(pdf);
    assert.equal(entries.length, 4);
    assert.equal(entries[0], "0000000000 65535 f \n");
    entries.slice(1).forEach((entry, index) => {
      assert.match(entry, /^\d{10} 00000 n \n$/);
      assert.ok(pdf.startsWith(`${index + 1} 0 obj\n`, Number(entry.slice(0, 10))), entry);
    });
  });

  it("has a trailer naming the catalog and the number of objects", () => {
    const { trailer } = readXref(pdf);
    assert.ok(trailer.startsWith("trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n"), trailer);
    assert.match(pdf, /1 0 obj\n<< \/Type \/Catalog \/Pages 2 0 R >>\nendobj/);
    assert.match(pdf, /2 0 obj\n<< \/Type \/Pages \/Kids \[3 0 R\] \/Count 1 >>\nendobj/);
  });

  it("has one page of the given size, with no content stream", () => {
    assert.equal(pdf.match(/\/Type \/Page\b/g)?.length, 1);
    assert.match(pdf, /\/MediaBox \[0 0 595\.28 841\.89\]/);
    assert.match(text(blankPdf(LETTER)), /\/MediaBox \[0 0 612 792\]/);
    assert.match(pdf, /\/Resources << >>/);
    assert.doesNotMatch(pdf, /\/Contents|stream/);
  });

  it("rounds sizes to 2 decimals", () => {
    assert.match(text(blankPdf({ width: 100.006, height: 200.1 })), /\/MediaBox \[0 0 100\.01 200\.1\]/);
    assert.match(text(blankPdf({ width: 300.004, height: 400 })), /\/MediaBox \[0 0 300 400\]/);
  });

  it("is plain ASCII", () => {
    assert.ok(blankPdf(LETTER).every((byte) => byte < 0x80));
  });

  it("refuses sizes PDF readers needn't handle", () => {
    for (const side of [0, 2, -612, 14401, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => blankPdf({ width: side, height: 792 }), RangeError, String(side));
      assert.throws(() => blankPdf({ width: 612, height: side }), RangeError, String(side));
    }
  });
});

describe("paperSize", () => {
  it("gives Letter where CLDR lists it", () => {
    assert.deepEqual(paperSize("US"), LETTER);
    assert.deepEqual(paperSize("CA"), LETTER);
    assert.deepEqual(paperSize("mx"), LETTER);
  });

  it("gives A4 everywhere else, and for an unknown region", () => {
    assert.deepEqual(paperSize("CH"), A4);
    assert.deepEqual(paperSize("GB"), A4);
    assert.deepEqual(paperSize(""), A4);
  });

  it("gives Letter as 8.5 × 11 inches and A4 as 210 × 297 mm, in points", () => {
    assert.deepEqual(LETTER, { width: 8.5 * 72, height: 11 * 72 });
    assert.equal(A4.width, Math.round((210 / 25.4) * 72 * 100) / 100);
    assert.equal(A4.height, Math.round((297 / 25.4) * 72 * 100) / 100);
  });
});
