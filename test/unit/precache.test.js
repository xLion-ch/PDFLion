import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheName, fileAt, parseFileList, planInstall, toHex } from "../../src/web/precache.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("precache.js", () => {
  it("names a build's cache by its version and build", () => {
    assert.equal(cacheName("1.2.3", "0123456789ab"), "pdflion-1.2.3-0123456789ab");
  });

  it("copies what an older cache has with the same contents, and downloads the rest", () => {
    const files = {
      "index.html": /** @type {[string, number]} */ ([A, 10]),
      "web/version.js": /** @type {[string, number]} */ ([B, 20]),
      "web/new.js": /** @type {[string, number]} */ ([C, 30]),
      "viewer/web/viewer.mjs": /** @type {[string, number]} */ ([C, 40]),
    };
    const plan = planInstall(files, [
      {
        cache: "pdflion-1.0.0-old",
        files: {
          "index.html": [A, 10],
          // Changed.
          "web/version.js": [A, 20],
          // The same contents, at another path.
          "web/other.js": [C, 30],
        },
      },
      { cache: "pdflion-1.1.0-newer", files: { "viewer/web/viewer.mjs": [C, 40], "index.html": [A, 10] } },
    ]);
    assert.deepEqual(plan, {
      copy: [
        { path: "index.html", from: "pdflion-1.0.0-old" },
        { path: "viewer/web/viewer.mjs", from: "pdflion-1.1.0-newer" },
      ],
      download: ["web/version.js", "web/new.js"],
    });
    // A first install downloads everything.
    assert.deepEqual(planInstall(files, []).download, Object.keys(files));
    // Not a file of another size, nor one the list only inherits.
    assert.deepEqual(planInstall({ "index.html": [A, 11], toString: [A, 1] }, [{ cache: "x", files: { "index.html": [A, 10] } }]).copy, []);
  });

  it("reads a cache's list of its files, or refuses it", () => {
    const list = { "index.html": [A, 10] };
    assert.deepEqual(parseFileList(list), list);
    assert.deepEqual(parseFileList({}), {});
    for (const value of [
      null,
      [],
      "x",
      { "index.html": [A] },
      { "index.html": ["A".repeat(64), 10] },
      { "index.html": [A, -1] },
      { "index.html": [A, 1.5] },
      { "index.html": { 0: A, 1: 10 } },
    ]) {
      assert.equal(parseFileList(value), null, JSON.stringify(value));
    }
  });

  it("finds the app's file a request names", () => {
    const scope = new URL("https://xlion-ch.github.io/PDFLion/");
    const files = {
      "index.html": /** @type {[string, number]} */ ([A, 1]),
      "viewer/web/viewer.html": /** @type {[string, number]} */ ([A, 1]),
      "viewer/web/locale/zh-TW/viewer.ftl": /** @type {[string, number]} */ ([A, 1]),
    };
    const at = (/** @type {string} */ url) => fileAt(new URL(url, scope), scope, files);
    assert.equal(at("https://xlion-ch.github.io/PDFLion/"), "index.html");
    assert.equal(at("index.html?x=1#y"), "index.html");
    assert.equal(at("viewer/web/viewer.html?file=%2FPDFLion%2Fdoc%2Fx%2Fa.pdf#page=2"), "viewer/web/viewer.html");
    assert.equal(at("viewer/web/locale/zh-TW/viewer.ftl"), "viewer/web/locale/zh-TW/viewer.ftl");
    for (const url of [
      "sw.js",
      ".pdflion-files.json",
      "doc/6a432432-3ee3-41f0-a0cc-ea87e5af8db4/a.pdf",
      "viewer/web/missing.js",
      "https://xlion-ch.github.io/Other/index.html",
      "https://example.com/PDFLion/index.html",
      "%E0%A4%A",
      "constructor",
    ]) {
      assert.equal(at(url), null, url);
    }
  });

  it("writes a digest in hex", () => {
    assert.equal(toHex(new Uint8Array([0, 15, 255]).buffer), "000fff");
  });
});
