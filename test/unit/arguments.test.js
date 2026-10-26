import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { commandLineFiles, secondInstanceFiles } from "../../src/main/arguments.js";

// Absolute on each platform: `/docs` on macOS and Linux, `C:\docs` (the current drive) on Windows.
const cwd = path.resolve("/docs");
const isWindows = process.platform === "win32";

/** @param {string} name */
const inCwd = (name) => path.join(cwd, name);

/** Names a file manager may pass, with spaces, non-ASCII and URL syntax. */
const NAMES = ["Report.pdf", "Über uns.pdf", "日本語 文書.pdf", "Ελληνικά.pdf", "#1 at 100%.pdf"];

/**
 * The command line of the packaged app: its executable, then `args`.
 * @param {string[]} args
 */
const packaged = (...args) =>
  commandLineFiles(["/opt/PDFLion/pdflion", ...args], { defaultApp: false, cwd });

describe("commandLineFiles", () => {
  it("skips Electron and the app path under electron .", () => {
    const argv = ["/repo/node_modules/electron/dist/electron", "/repo"];
    assert.deepEqual(commandLineFiles(argv, { defaultApp: true, cwd }), []);
    assert.deepEqual(commandLineFiles([...argv, inCwd("a.pdf")], { defaultApp: true, cwd }), [
      inCwd("a.pdf"),
    ]);
  });

  it("skips only the executable once packaged", () => {
    assert.deepEqual(packaged(), []);
    assert.deepEqual(packaged(inCwd("a.pdf"), inCwd("b.pdf")), [inCwd("a.pdf"), inCwd("b.pdf")]);
  });

  it("resolves relative paths against cwd", () => {
    assert.deepEqual(packaged("a.pdf", path.join("sub", "b.pdf"), path.join("..", "c.pdf")), [
      inCwd("a.pdf"),
      path.join(cwd, "sub", "b.pdf"),
      path.resolve(cwd, "..", "c.pdf"),
    ]);
  });

  it("reads names with a colon, and drive letters, as paths", () => {
    for (const arg of ["notes:v2.pdf", "C:\\docs\\a.pdf", "C:/docs/a.pdf"]) {
      assert.deepEqual(packaged(arg), [path.resolve(cwd, arg)], arg);
    }
  });

  it("drops flags", () => {
    assert.deepEqual(
      packaged("--user-data-dir=/tmp/x", "-v", "--no-sandbox", "a.pdf", "--enable-features=X"),
      [inCwd("a.pdf")],
    );
  });

  it("converts file:// URIs, with spaces and non-ASCII names", () => {
    for (const name of NAMES) {
      const uri = pathToFileURL(inCwd(name)).href;
      assert.deepEqual(packaged(uri), [inCwd(name)], uri);
    }
  });

  it("converts file:// URIs written without percent-encoding", () => {
    const uri = `file://${isWindows ? "/" : ""}${inCwd("Über uns.pdf").replaceAll("\\", "/")}`;
    assert.deepEqual(packaged(uri), [inCwd("Über uns.pdf")]);
  });

  it("converts file://localhost/ URIs", () => {
    const { pathname } = pathToFileURL(inCwd("a.pdf"));
    assert.deepEqual(packaged(`file://localhost${pathname}`), [inCwd("a.pdf")]);
  });

  it("drops other URIs, and file:// URIs with an encoded slash", () => {
    assert.deepEqual(
      packaged("https://example.com/a.pdf", "smb://server/share/a.pdf", "FILE:///%2Fetc%2Fpasswd"),
      [],
    );
  });

  it(
    "drops file:// URIs of other hosts",
    { skip: isWindows && "Windows reads them as UNC paths" },
    () => {
      assert.deepEqual(packaged("file://server/share/a.pdf"), []);
    },
  );
});

describe("secondInstanceFiles", () => {
  it("returns the absolute paths a second instance passed", () => {
    const files = NAMES.map(inCwd);
    assert.deepEqual(secondInstanceFiles({ files }), files);
  });

  it("converts file:// URIs", () => {
    const uri = pathToFileURL(inCwd("Über uns.pdf")).href;
    assert.deepEqual(secondInstanceFiles({ files: [uri] }), [inCwd("Über uns.pdf")]);
  });

  it("drops relative paths, other URIs and anything but strings", () => {
    assert.deepEqual(
      secondInstanceFiles({
        files: [
          "a.pdf",
          "https://example.com/a.pdf",
          1,
          null,
          {},
          [inCwd("a.pdf")],
          inCwd("b.pdf"),
        ],
      }),
      [inCwd("b.pdf")],
    );
  });

  it("returns nothing for malformed additionalData", () => {
    for (const data of [
      undefined,
      null,
      "a.pdf",
      42,
      [inCwd("a.pdf")],
      {},
      { files: inCwd("a.pdf") },
      { files: null },
      { files: { 0: inCwd("a.pdf"), length: 1 } },
    ]) {
      assert.deepEqual(secondInstanceFiles(data), [], JSON.stringify(data));
    }
  });
});
