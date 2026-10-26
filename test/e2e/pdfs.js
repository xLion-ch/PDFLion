/**
 * Small test PDFs, written when a test needs them, so no binary fixtures are
 * committed.
 */
import fs from "node:fs/promises";

/**
 * @param {string[]} objects the body of each object, numbered from 1, with the
 *   catalog first
 * @returns {Buffer} a PDF with a classic cross-reference table
 */
function pdf(objects) {
  let body = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** @param {string} text */
function stream(text) {
  return `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
}

const HELVETICA =
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/**
 * Writes a one-page form with a single empty text field named "name", which
 * pdf.js shows as an `<input>`.
 *
 * @param {string} file
 */
export async function writeForm(file) {
  await fs.writeFile(
    file,
    pdf([
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F 5 0 R >> >> /Contents 6 0 R /Annots [4 0 R] >>",
      "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [72 670 360 700] /F 4 /P 3 0 R /DA (/Helv 14 Tf 0 g) /MK << /BC [0 0 0] >> >>",
      HELVETICA,
      stream("BT /F 14 Tf 72 710 Td (Name:) Tj ET"),
    ]),
  );
}

/** The links writeLinks() puts on its page, top to bottom. */
export const LINKS = ["https://example.com/", "file:///etc/passwd", "javascript:alert(1)"];

/**
 * Writes a page with one link annotation for each of LINKS.
 *
 * @param {string} file
 */
export async function writeLinks(file) {
  const y = (/** @type {number} */ index) => 700 - index * 60;
  const escape = (/** @type {string} */ text) => text.replace(/[\\()]/g, "\\$&");
  const labels = LINKS.map((url, index) => `1 0 0 1 72 ${y(index)} Tm (${escape(url)}) Tj`);
  await fs.writeFile(
    file,
    pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F 4 0 R >> >> /Contents 5 0 R /Annots [${LINKS.map((_, i) => `${6 + i} 0 R`).join(" ")}] >>`,
      HELVETICA,
      stream(`BT /F 14 Tf\n${labels.join("\n")}\nET`),
      ...LINKS.map(
        (url, index) =>
          `<< /Type /Annot /Subtype /Link /Rect [70 ${y(index) - 6} 360 ${y(index) + 18}] /Border [0 0 0] /A << /S /URI /URI (${escape(url)}) >> >>`,
      ),
    ]),
  );
}
