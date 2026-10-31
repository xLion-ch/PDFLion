/**
 * The blank document File > New opens: one empty page, of the paper size the
 * system's region uses.
 * Free of Electron and Node, in src/shared/, so that the web app can use it
 * too, and unit tests under plain Node.
 */

/** @typedef {{ width: number, height: number }} PaperSize in PDF points, 1/72 inch */

/** 8.5 × 11 inches. */
export const LETTER = Object.freeze({ width: 612, height: 792 });

/** 210 × 297 mm. */
export const A4 = Object.freeze({ width: 595.28, height: 841.89 });

/**
 * The regions that use US Letter, as CLDR's paper size data lists them
 * (`<paperSize type="US-Letter">` in common/supplemental/supplementalData.xml,
 * checked against CLDR 49). Everywhere else uses A4.
 */
const LETTER_REGIONS = new Set([
  "BZ",
  "CA",
  "CL",
  "CO",
  "CR",
  "GT",
  "MX",
  "NI",
  "PA",
  "PH",
  "PR",
  "SV",
  "US",
  "VE",
]);

/** The page sides PDF readers should handle, in points (ISO 32000-1, annex C). */
const MIN_SIDE = 3;
const MAX_SIDE = 14400;

/**
 * @param {string} countryCode ISO 3166 code, such as app.getLocaleCountryCode()
 *   returns, or "" when the region is unknown
 * @returns {PaperSize} Letter for the regions that use it, else A4
 */
export function paperSize(countryCode) {
  return LETTER_REGIONS.has(countryCode.toUpperCase()) ? LETTER : A4;
}

/**
 * A PDF with one empty page: a catalog, a page tree and a page with no
 * content stream and empty resources, indexed by a classic cross-reference
 * table.
 *
 * @param {PaperSize} size the page's size in points, rounded to 2 decimals
 * @returns {Uint8Array}
 */
export function blankPdf({ width, height }) {
  for (const side of [width, height]) {
    if (!Number.isFinite(side) || side < MIN_SIDE || side > MAX_SIDE) {
      throw new RangeError(`A page side of ${side} points is outside ${MIN_SIDE}…${MAX_SIDE}`);
    }
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(width)} ${number(height)}] /Resources << >> >>`,
  ];

  let body = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  // Each entry is exactly 20 bytes, its line break included.
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // All ASCII, so each character is one byte and the offsets hold.
  return new TextEncoder().encode(body);
}

/**
 * @param {number} value
 * @returns {string} `value` rounded to 2 decimals, without trailing zeros
 */
function number(value) {
  return String(Math.round(value * 100) / 100);
}
