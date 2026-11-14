import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  build,
  buildId,
  fileList,
  injectHome,
  injectShell,
  injectViewer,
  isLeftOut,
  listFiles,
  prefixIcons,
  serviceWorker,
  versionModule,
} from "../../scripts/build-web.js";
import { VIEWER_CSP, WEB_HOME_CSP, WEB_SHELL_CSP } from "../../src/shared/csp.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PDFJS_BUILD = path.join(ROOT, "vendor", "pdf.js", "build", "generic", "web", "viewer.html");

describe("build-web.js parts", () => {
  it("leaves out pdf.js's source maps, debugger and demo PDF", () => {
    assert.ok(isLeftOut("build/pdf.mjs.map"));
    assert.ok(isLeftOut("web/debugger.mjs"));
    assert.ok(isLeftOut("web/debugger.css"));
    assert.ok(isLeftOut("web/compressed.tracemonkey-pldi-09.pdf"));
    assert.ok(!isLeftOut("web/viewer.mjs"));
    assert.ok(!isLeftOut("web/locale/de/viewer.ftl"));
    assert.ok(!isLeftOut("web/cmaps/Adobe-Japan1-UCS2.bcmap"));
  });

  it("adds the CSP, then PDFLion's styles and scripts to the viewer, the host before bridge.js", () => {
    const html = injectViewer("<head><script src=viewer.mjs type=module></script></head><body>");
    const injected = html.slice(html.indexOf("</script>") + 9, html.indexOf("</head>"));
    assert.equal(
      injected,
      [
        `<meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}">`,
        '<link rel="stylesheet" href="../../pdflion/overrides.css">',
        '<script src="../../pdflion/geometry.js"></script>',
        '<script src="../../pdflion/backgrounds.js"></script>',
        '<script src="../../web/keys.js"></script>',
        '<script src="../../web/viewer-host.js"></script>',
        '<script src="../../shared/texts.js"></script>',
        '<script src="../../pdflion/bridge.js"></script>',
      ].join(""),
    );
    assert.throws(() => injectViewer("<html>"), /no <\/head>/);
  });

  it("adds the CSP and the host to Home", () => {
    const html = injectHome('<head><script src="home.js" defer></script></head>');
    assert.ok(html.includes(`content="${WEB_HOME_CSP}"`));
    assert.ok(html.indexOf("keys.js") < html.indexOf("home-host.js"));
    assert.ok(html.indexOf("home-host.js") < html.indexOf("</head>"));
  });

  it("puts the shell's CSP right after its charset", () => {
    const html = injectShell('<head><meta charset="utf-8" /><title>PDFLion</title>');
    assert.equal(
      html,
      `<head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${WEB_SHELL_CSP}"><title>PDFLion</title>`,
    );
    assert.throws(() => injectShell("<head>"), /charset/);
  });

  it("puts the app's path before the icons' URLs", () => {
    assert.equal(
      prefixIcons("a { mask: url(/pdflion/icons/home.svg) } b { --x: url(/pdflion/icons/add.svg) }", "x.css"),
      "a { mask: url(/PDFLion/pdflion/icons/home.svg) } b { --x: url(/PDFLion/pdflion/icons/add.svg) }",
    );
    assert.throws(() => prefixIcons("a {}", "x.css"), /x\.css has no/);
  });

  it("writes the version and the files into the service worker, and the version into version.js", () => {
    const source = 'import x from "./y.js";\nconst VERSION = "dev";\nconst BUILD = "dev";\nconst FILES = {};\n';
    const files = { "index.html": /** @type {[string, number]} */ (["a".repeat(64), 12]) };
    assert.equal(
      serviceWorker(source, "1.2.3-pr.4", files),
      [
        'import x from "./y.js";',
        'const VERSION = "1.2.3-pr.4";',
        `const BUILD = "${buildId(files)}";`,
        "const FILES = {",
        `  "index.html": ["${"a".repeat(64)}",12],`,
        "};",
        "",
      ].join("\n"),
    );
    assert.match(buildId(files), /^[0-9a-f]{12}$/);
    assert.notEqual(buildId(files), buildId({ "index.html": ["b".repeat(64), 12] }));
    assert.throws(() => serviceWorker("const VERSION = 1;", "1.2.3", files), /VERSION/);
    assert.throws(() => serviceWorker('const VERSION = "dev";\nconst BUILD = "dev";', "1.2.3", files), /FILES/);
    assert.match(versionModule("1.2.3", "6.4.299"), /VERSION = "1\.2\.3";\nexport const PDFJS_VERSION = "6\.4\.299";/);
  });

  it("gives the shell what it frames and installs, and nothing more", () => {
    for (const directive of ["frame-src 'self'", "manifest-src 'self'", "worker-src 'self'"]) {
      assert.ok(WEB_SHELL_CSP.includes(directive), directive);
    }
    assert.ok(WEB_HOME_CSP.includes("img-src 'self' blob:"));
    for (const csp of [VIEWER_CSP, WEB_HOME_CSP, WEB_SHELL_CSP]) {
      assert.ok(csp.startsWith("default-src 'none'"));
      // 'wasm-unsafe-eval' is pdf.js's image decoders'.
      assert.doesNotMatch(csp, /'unsafe-eval'|'unsafe-inline'/);
    }
  });
});

describe("build-web.js build", { skip: !fs.existsSync(PDFJS_BUILD) && "there's no pdf.js build" }, () => {
  /** @type {string} */
  let out;
  /** @type {string[]} */
  let files;

  before(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), "build-web-"));
    build({ version: "9.8.7", out });
    files = listFiles(out);
  });

  after(() => fs.rmSync(out, { recursive: true, force: true }));

  it("lays the app out as the desktop serves it, with the shell at the root", () => {
    for (const file of [
      "index.html",
      "sw.js",
      "manifest.webmanifest",
      "viewer/web/viewer.html",
      "viewer/build/pdf.mjs",
      "pdflion/bridge.js",
      "pdflion/icons/ios_share.svg",
      "home/home.html",
      "tabs/tabs.js",
      "shared/ranges.js",
      "web/shell.js",
      "web/library.js",
      "web/icons/apple-touch-icon.png",
      "lib/pdf-lib.min.js",
    ]) {
      assert.ok(files.includes(file), file);
    }
    // Not the desktop's strip page, and the root's files only at the root.
    for (const file of ["tabs/tabs.html", "web/index.html", "web/sw.js", "web/manifest.webmanifest"]) {
      assert.ok(!files.includes(file), file);
    }
  });

  it("leaves out what the packaged app leaves out of pdf.js", () => {
    assert.deepEqual(
      files.filter((file) => file.startsWith("viewer/") && isLeftOut(file.slice("viewer/".length))),
      [],
    );
  });

  it("has the version in the service worker and version.js", () => {
    assert.match(fs.readFileSync(path.join(out, "sw.js"), "utf8"), /^const VERSION = "9\.8\.7";$/m);
    assert.match(fs.readFileSync(path.join(out, "web", "version.js"), "utf8"), /"9\.8\.7"/);
  });

  it("lists every other file in the service worker, with its SHA-256 and size", () => {
    const listed = fileList(out);
    assert.deepEqual(Object.keys(listed), files.filter((file) => file !== "sw.js"));
    const viewer = fs.readFileSync(path.join(out, "viewer", "web", "viewer.html"));
    assert.deepEqual(listed["viewer/web/viewer.html"], [
      crypto.createHash("sha256").update(viewer).digest("hex"),
      viewer.length,
    ]);
    const source = fs.readFileSync(path.join(out, "sw.js"), "utf8");
    assert.ok(source.includes(`const BUILD = "${buildId(listed)}";`));
    assert.ok(source.includes(`  "web/version.js": ${JSON.stringify(listed["web/version.js"])},`));
    assert.ok(files.includes("web/precache.js"));
  });

  it("names no icon from the origin's root", () => {
    for (const file of files.filter((name) => name.endsWith(".css"))) {
      const css = fs.readFileSync(path.join(out, file), "utf8");
      assert.ok(!css.includes("url(/pdflion/"), file);
    }
  });

  it("injects the hosts into the viewer and Home", () => {
    const viewer = fs.readFileSync(path.join(out, "viewer", "web", "viewer.html"), "utf8");
    assert.ok(viewer.indexOf("viewer-host.js") < viewer.indexOf("bridge.js"));
    const home = fs.readFileSync(path.join(out, "home", "home.html"), "utf8");
    assert.ok(home.includes("home-host.js"));
  });
});
