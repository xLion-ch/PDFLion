#!/usr/bin/env node
/**
 * Builds the web app into dist/web/, laid out as `pdflion://app/` is on the
 * desktop, for GitHub Pages to serve at /PDFLion/:
 *
 * - `viewer/`: pdf.js's generic build, without its source maps, debugger and
 *   demo PDF, as the packaged desktop app leaves them out, and a viewer.html
 *   with PDFLion's overrides.css, geometry.js, the web's keys.js and
 *   viewer-host.js, and bridge.js, and a `<meta>` CSP that mirrors the
 *   desktop's header
 * - `pdflion/`, `home/`, `tabs/`, `shared/`: src/viewer/, src/home/ (whose
 *   home.html gets home-host.js and a CSP), the strip's tabs.js and tabs.css,
 *   and src/shared/
 * - `web/`: src/web/, with version.js written for this build
 * - `lib/pdf-lib.min.js`: @cantoo/pdf-lib's browser build
 * - `index.html`, `sw.js` and `manifest.webmanifest` at the root, since the
 *   service worker's scope is its folder. sw.js gets the version, so that
 *   each build's differs.
 *
 * The stylesheets name their icons from the origin (`/pdflion/icons/`), as
 * the desktop serves them, so they get the app's path before them.
 *
 *   node scripts/build-web.js [--version <version>] [--out <folder>]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { VIEWER_CSP, WEB_HOME_CSP, WEB_SHELL_CSP } from "../src/shared/csp.js";
import { BASE } from "./serve-web.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const PDFJS = path.join(ROOT, "vendor", "pdf.js", "build");
const PDFJS_BUILD = path.join(PDFJS, "generic");
const SRC = path.join(ROOT, "src");
export const OUT = path.join(ROOT, "dist", "web");

/** Of src/web/, what goes to the app's root rather than into web/. */
const AT_ROOT = new Set(["index.html", "sw.js", "manifest.webmanifest"]);

/** Of src/tabs/, what the shell uses: not tabs.html, the desktop's page. */
const STRIP_FILES = ["tabs.js", "tabs.css"];

/**
 * What the packaged app leaves out of pdf.js's build too (extraResources in
 * electron-builder.yml).
 *
 * @param {string} relative path in the build, with `/`
 * @returns {boolean}
 */
export function isLeftOut(relative) {
  return (
    relative.endsWith(".map") ||
    relative.startsWith("web/debugger.") ||
    relative === "web/compressed.tracemonkey-pldi-09.pdf"
  );
}

/**
 * @param {string} csp
 * @returns {string} a `<meta>` tag that sets it
 */
function cspTag(csp) {
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
}

/**
 * Adds PDFLion to pdf.js's viewer.html, before `</head>`, as
 * src/main/protocol.js does on the desktop, but with relative URLs and the
 * web's hosts: the CSP first, then the classic scripts, which run in order
 * before the viewer's module scripts.
 *
 * @param {string} html
 * @returns {string}
 */
export function injectViewer(html) {
  if (!html.includes("</head>")) throw new Error("viewer.html has no </head>");
  const injection = [
    cspTag(VIEWER_CSP),
    '<link rel="stylesheet" href="../../pdflion/overrides.css">',
    '<script src="../../pdflion/geometry.js"></script>',
    '<script src="../../web/keys.js"></script>',
    '<script src="../../web/viewer-host.js"></script>',
    '<script src="../../pdflion/bridge.js"></script>',
  ].join("");
  return html.replace("</head>", `${injection}</head>`);
}

/**
 * Adds the CSP and the web's host to Home's page, before home.js runs, which
 * is deferred.
 *
 * @param {string} html
 * @returns {string}
 */
export function injectHome(html) {
  if (!html.includes("</head>")) throw new Error("home.html has no </head>");
  const injection = [
    cspTag(WEB_HOME_CSP),
    '<script src="../web/keys.js"></script>',
    '<script src="../web/home-host.js"></script>',
  ].join("");
  return html.replace("</head>", `${injection}</head>`);
}

/**
 * Adds the shell's CSP, right after its charset.
 *
 * @param {string} html
 * @returns {string}
 */
export function injectShell(html) {
  const charset = '<meta charset="utf-8" />';
  if (!html.includes(charset)) throw new Error("index.html has no charset to put the CSP after");
  return html.replace(charset, `${charset}${cspTag(WEB_SHELL_CSP)}`);
}

/**
 * Puts the app's path before the icons a stylesheet names from the origin.
 *
 * @param {string} css
 * @param {string} name the stylesheet's, for the error
 * @returns {string}
 */
export function prefixIcons(css, name) {
  if (!css.includes("url(/pdflion/icons/")) throw new Error(`${name} has no /pdflion/icons/ URLs`);
  return css.replaceAll("url(/pdflion/icons/", `url(${BASE}pdflion/icons/`);
}

/**
 * @param {string} source sw.js
 * @param {string} version
 * @returns {string} sw.js for that version
 */
export function serviceWorker(source, version) {
  const line = /^const VERSION = "dev";$/m;
  if (!line.test(source)) throw new Error('sw.js has no `const VERSION = "dev";`');
  return source.replace(line, `const VERSION = ${JSON.stringify(version)};`);
}

/**
 * @param {string} version
 * @param {string | null} pdfjsVersion
 * @returns {string} web/version.js
 */
export function versionModule(version, pdfjsVersion) {
  return [
    "// Written by scripts/build-web.js.",
    `export const VERSION = ${JSON.stringify(version)};`,
    `export const PDFJS_VERSION = ${JSON.stringify(pdfjsVersion)};`,
    "",
  ].join("\n");
}

/**
 * @param {{ version: string, out?: string }} options
 */
export function build({ version, out = OUT }) {
  const viewerHtml = path.join(PDFJS_BUILD, "web", "viewer.html");
  if (!fs.existsSync(viewerHtml)) throw new Error("there's no pdf.js build: run npm run pdfjs:build");
  fs.rmSync(out, { recursive: true, force: true });

  copyTree(PDFJS_BUILD, path.join(out, "viewer"), (relative) => !isLeftOut(relative));
  write(out, "viewer/web/viewer.html", injectViewer(fs.readFileSync(viewerHtml, "utf8")));

  copyTree(path.join(SRC, "viewer"), path.join(out, "pdflion"));
  transform(out, "pdflion/overrides.css", (css) => prefixIcons(css, "overrides.css"));

  copyTree(path.join(SRC, "home"), path.join(out, "home"));
  transform(out, "home/home.css", (css) => prefixIcons(css, "home.css"));
  transform(out, "home/home.html", injectHome);

  for (const file of STRIP_FILES) {
    fs.mkdirSync(path.join(out, "tabs"), { recursive: true });
    fs.copyFileSync(path.join(SRC, "tabs", file), path.join(out, "tabs", file));
  }
  transform(out, "tabs/tabs.css", (css) => prefixIcons(css, "tabs.css"));

  copyTree(path.join(SRC, "shared"), path.join(out, "shared"));

  copyTree(path.join(SRC, "web"), path.join(out, "web"), (relative) => !AT_ROOT.has(relative));
  transform(out, "web/web.css", (css) => prefixIcons(css, "web.css"));
  write(out, "web/version.js", versionModule(version, pdfjsVersion()));
  write(out, "index.html", injectShell(fs.readFileSync(path.join(SRC, "web", "index.html"), "utf8")));
  write(out, "sw.js", serviceWorker(fs.readFileSync(path.join(SRC, "web", "sw.js"), "utf8"), version));
  fs.copyFileSync(path.join(SRC, "web", "manifest.webmanifest"), path.join(out, "manifest.webmanifest"));

  fs.mkdirSync(path.join(out, "lib"));
  fs.copyFileSync(
    path.join(ROOT, "node_modules", "@cantoo", "pdf-lib", "dist", "pdf-lib.min.js"),
    path.join(out, "lib", "pdf-lib.min.js"),
  );
}

/** @returns {string | null} the pdf.js build's version, from build/version.json */
function pdfjsVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PDFJS, "version.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * @returns {string} the version CI would build this commit as, or `0.0.0-dev`
 *   without the history to count
 */
function localVersion() {
  try {
    return execFileSync(process.execPath, [path.join(ROOT, "scripts", "version.js")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "0.0.0-dev";
  }
}

/**
 * @param {string} out
 * @param {string} relative
 * @param {string} text
 */
function write(out, relative, text) {
  fs.mkdirSync(path.dirname(path.join(out, relative)), { recursive: true });
  fs.writeFileSync(path.join(out, relative), text);
}

/**
 * @param {string} out
 * @param {string} relative
 * @param {(text: string) => string} change
 */
function transform(out, relative, change) {
  const file = path.join(out, relative);
  fs.writeFileSync(file, change(fs.readFileSync(file, "utf8")));
}

/**
 * @param {string} from
 * @param {string} to
 * @param {(relative: string) => boolean} [keep] by the path below `from`, with `/`
 */
export function copyTree(from, to, keep = () => true) {
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
export function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

/** @param {string[]} args the command line, without node and the script */
function main(args) {
  const { values } = parseArgs({
    args,
    options: { version: { type: "string" }, out: { type: "string" } },
  });
  const version = values.version ?? localVersion();
  const out = values.out ? path.resolve(values.out) : OUT;
  build({ version, out });
  console.log(`Built PDFLion ${version} for the web in ${path.relative(process.cwd(), out)}/`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${/** @type {Error} */ (error).message}`);
    process.exit(1);
  }
}
