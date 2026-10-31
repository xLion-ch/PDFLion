#!/usr/bin/env node
/**
 * Builds dist/trials/: trials that answer, on an iPad, what a web app of
 * PDFLion needs to know before it's built, such as how many viewers fit in
 * memory and what the Apple Pencil sends.
 * scripts/serve-web.js serves the folder at /PDFLion/, laid out as the web
 * app will be:
 *
 * - `viewer/`: today's viewer, the pdf.js build with PDFLion's overrides.css,
 *   geometry.js and bridge.js, and host.js standing in for window.pdflion
 * - `pdflion/`: src/viewer/
 * - `docs/`: PDFs to open, pdf.js's demo and one of large scanned pages
 * - the trial pages, a service worker that keeps all of it for offline use
 *   and serves IndexedDB's bytes with ranges, and a manifest, so the trials
 *   also run as a Home Screen app
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { BASE } from "../../scripts/serve-web.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PDFJS_BUILD = path.join(ROOT, "vendor", "pdf.js", "build", "generic");
export const OUT = path.join(ROOT, "dist", "trials");

/** Of the trials' folder, what isn't served. */
const NOT_SERVED = new Set(["build.js", "run.js", "results.jsonl"]);

/**
 * What the packaged app leaves out of pdf.js's build too (extraResources in
 * electron-builder.yml).
 *
 * @param {string} relative path in the build, with `/`
 */
function isLeftOut(relative) {
  return (
    relative.endsWith(".map") ||
    relative.startsWith("web/debugger.") ||
    relative === "web/compressed.tracemonkey-pldi-09.pdf"
  );
}

/**
 * Added before `</head>` of viewer.html, as src/main/protocol.js adds its
 * VIEWER_INJECTION, but relative, and with host.js before bridge.js.
 */
const VIEWER_INJECTION = [
  '<link rel="stylesheet" href="../../pdflion/overrides.css">',
  '<script src="../../pdflion/geometry.js"></script>',
  '<script src="../../host.js"></script>',
  '<script src="../../pdflion/bridge.js"></script>',
].join("");

/** The scanned pages: A4 at 300 dpi, in colour, as a phone's scanner app makes them. */
const SCAN = { pages: 10, width: 2480, height: 3508 };

export function build() {
  const viewerHtml = path.join(PDFJS_BUILD, "web", "viewer.html");
  if (!fs.existsSync(viewerHtml)) {
    throw new Error("there's no pdf.js build: run npm run pdfjs:build");
  }
  fs.rmSync(OUT, { recursive: true, force: true });

  copyTree(PDFJS_BUILD, path.join(OUT, "viewer"), (relative) => !isLeftOut(relative));
  copyTree(path.join(ROOT, "src", "viewer"), path.join(OUT, "pdflion"));
  // Its icons' URLs start at the origin, which here is outside /PDFLion/.
  // Relative ones wouldn't do: most are in custom properties, which
  // browsers resolve against viewer.css, which uses them.
  const overrides = path.join(OUT, "pdflion", "overrides.css");
  const css = fs.readFileSync(overrides, "utf8");
  if (!css.includes("url(/pdflion/icons/")) {
    throw new Error("overrides.css has no /pdflion/icons/ URLs");
  }
  fs.writeFileSync(overrides, css.replaceAll("url(/pdflion/icons/", `url(${BASE}pdflion/icons/`));
  copyTree(HERE, OUT, (relative) => !NOT_SERVED.has(relative));
  fs.copyFileSync(path.join(ROOT, "src", "main", "ranges.js"), path.join(OUT, "ranges.js"));
  fs.copyFileSync(path.join(ROOT, "resources", "icon.png"), path.join(OUT, "icon.png"));

  const html = fs.readFileSync(viewerHtml, "utf8");
  if (!html.includes("</head>")) throw new Error(`no </head> in ${viewerHtml}`);
  fs.writeFileSync(
    path.join(OUT, "viewer", "web", "viewer.html"),
    html.replace("</head>", `${VIEWER_INJECTION}</head>`),
  );

  fs.mkdirSync(path.join(OUT, "docs"));
  fs.copyFileSync(
    path.join(PDFJS_BUILD, "web", "compressed.tracemonkey-pldi-09.pdf"),
    path.join(OUT, "docs", "tracemonkey.pdf"),
  );
  fs.writeFileSync(path.join(OUT, "docs", "scans.pdf"), scannedPages(SCAN));

  writeServiceWorker();
}

/**
 * sw.js: the service worker's own code, after answerRange() from
 * src/main/ranges.js, which a classic script can't import, and the list of
 * files to keep, which changes with every build, so that the browser
 * installs the new one.
 */
function writeServiceWorker() {
  const files = listFiles(OUT).filter((file) => file !== "sw.js");
  const bytes = files.reduce((sum, file) => sum + fs.statSync(path.join(OUT, file)).size, 0);
  const ranges = fs.readFileSync(path.join(ROOT, "src", "main", "ranges.js"), "utf8");
  if (!/^export function answerRange\(/m.test(ranges)) {
    throw new Error("src/main/ranges.js no longer exports answerRange()");
  }
  const build = { id: new Date().toISOString(), files: ["./", ...files], bytes };
  fs.writeFileSync(
    path.join(OUT, "sw.js"),
    [
      "// Built by test/trials/build.js from sw.js, after src/main/ranges.js.",
      ranges.replace(/^export function/m, "function"),
      `const BUILD = ${JSON.stringify(build)};`,
      fs.readFileSync(path.join(HERE, "sw.js"), "utf8"),
    ].join("\n"),
  );
}

/**
 * @param {string} from
 * @param {string} to
 * @param {(relative: string) => boolean} [keep] by the path below `from`, with `/`
 */
function copyTree(from, to, keep = () => true) {
  for (const relative of listFiles(from)) {
    if (!keep(relative)) continue;
    const target = path.join(to, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, relative), target);
  }
}

/**
 * @param {string} dir
 * @returns {string[]} the files below it, with `/`, in a stable order
 */
function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

/**
 * A PDF of large images, one a page, each different, so that pdf.js decodes
 * and caches each on its own. Gradients and squares keep the file small, but
 * a page decodes to as many pixels as a real scan.
 *
 * @param {{ pages: number, width: number, height: number }} scan
 * @returns {Buffer}
 */
function scannedPages({ pages, width, height }) {
  const kids = Array.from({ length: pages }, (_, page) => `${3 + 3 * page} 0 R`).join(" ");
  /** @type {(string | Buffer)[][]} each object's parts, numbered from 1 */
  const objects = [
    ["<< /Type /Catalog /Pages 2 0 R >>"],
    [`<< /Type /Pages /Count ${pages} /Kids [${kids}] >>`],
  ];
  const content = "q 595 0 0 842 0 0 cm /Im Do Q";
  for (let page = 0; page < pages; page++) {
    const first = 3 + 3 * page;
    objects.push(
      [
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
          `/Resources << /XObject << /Im ${first + 2} 0 R >> >> /Contents ${first + 1} 0 R >>`,
      ],
      [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
      imageObject(width, height, page),
    );
  }

  /** @type {Buffer[]} */
  const parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let length = parts[0].length;
  const offsets = objects.map((object, index) => {
    const offset = length;
    for (const part of [`${index + 1} 0 obj\n`, ...object, "\nendobj\n"]) {
      const buffer = typeof part === "string" ? Buffer.from(part, "latin1") : part;
      parts.push(buffer);
      length += buffer.length;
    }
    return offset;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  ].join("");
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {number} page
 * @returns {(string | Buffer)[]} an RGB image XObject's parts
 */
function imageObject(width, height, page) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 3 * (y * width + x);
      pixels[i] = (x * 255) / width;
      pixels[i + 1] = (y * 255) / height;
      pixels[i + 2] = (page * 47 + (((x >> 6) ^ (y >> 6)) & 1) * 64) & 255;
    }
  }
  const data = zlib.deflateSync(pixels);
  const dictionary =
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`;
  return [`${dictionary}\nstream\n`, data, "\nendstream"];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    build();
    console.log(`Built ${path.relative(process.cwd(), OUT)}/`);
  } catch (error) {
    console.error(`error: ${/** @type {Error} */ (error).message}`);
    process.exit(1);
  }
}
