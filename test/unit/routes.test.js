import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveInside, resolveUrl } from "../../src/main/routes.js";

const mounts = { viewer: "/app/viewer", pdflion: "/app/src/viewer" };

describe("resolveUrl", () => {
  it("maps each mount to its root", () => {
    assert.equal(
      resolveUrl("pdflion://app/viewer/web/viewer.html", mounts),
      "/app/viewer/web/viewer.html",
    );
    assert.equal(
      resolveUrl("pdflion://app/pdflion/bridge.js", mounts),
      "/app/src/viewer/bridge.js",
    );
  });

  it("ignores the query and fragment", () => {
    assert.equal(
      resolveUrl("pdflion://app/viewer/web/viewer.html?file=#page=2", mounts),
      "/app/viewer/web/viewer.html",
    );
  });

  it("decodes percent-encoded names", () => {
    assert.equal(
      resolveUrl("pdflion://app/viewer/web/locale/en%2DUS/viewer.ftl", mounts),
      "/app/viewer/web/locale/en-US/viewer.ftl",
    );
  });

  it("rejects other schemes and hosts", () => {
    assert.equal(resolveUrl("file:///app/viewer/web/viewer.html", mounts), null);
    assert.equal(resolveUrl("pdflion://evil/viewer/web/viewer.html", mounts), null);
    assert.equal(resolveUrl("not a url", mounts), null);
  });

  it("rejects unknown mounts and bare mount roots", () => {
    assert.equal(resolveUrl("pdflion://app/", mounts), null);
    assert.equal(resolveUrl("pdflion://app/viewer", mounts), null);
    assert.equal(resolveUrl("pdflion://app/viewer/", mounts), null);
    assert.equal(resolveUrl("pdflion://app/doc/x.pdf", mounts), null);
    assert.equal(resolveUrl("pdflion://app/constructor/x", mounts), null);
    assert.equal(resolveUrl("pdflion://app/__proto__/x", mounts), null);
  });

  for (const url of [
    "pdflion://app/viewer/../../etc/passwd",
    "pdflion://app/viewer/%2e%2e/%2e%2e/etc/passwd",
    "pdflion://app/viewer/.%2E/package.json",
    "pdflion://app/viewer/..%2f..%2f..%2fpackage.json",
    "pdflion://app/viewer/..%2F..%2F..%2Fpackage.json",
    "pdflion://app/viewer/web%2f..%2f..%2f..%2fpackage.json",
    "pdflion://app/viewer/%2e%2e%2f%2e%2e%2fpackage.json",
    "pdflion://app/viewer/%2fetc%2fpasswd",
    "pdflion://app/viewer//etc/passwd",
    "pdflion://app/viewer/..%2fviewer-sibling%2fsecret",
    "pdflion://app/pdflion/..%2f..%2fmain%2fmain.js",
  ]) {
    it(`rejects traversal: ${url}`, () => {
      assert.equal(resolveUrl(url, mounts), null);
    });
  }

  it("decodes only once", () => {
    assert.equal(
      resolveUrl("pdflion://app/viewer/%252e%252e%252fpackage.json", mounts),
      "/app/viewer/%2e%2e%2fpackage.json",
    );
  });
});

describe("resolveInside", () => {
  it("resolves paths inside the root", () => {
    assert.equal(resolveInside("/root", "a/b.txt"), "/root/a/b.txt");
    assert.equal(resolveInside("/root", "a/../b.txt"), "/root/b.txt");
  });

  it("allows names that merely start with two dots", () => {
    assert.equal(resolveInside("/root", "..hidden"), "/root/..hidden");
  });

  it("rejects the root itself", () => {
    assert.equal(resolveInside("/root", "."), null);
    assert.equal(resolveInside("/root", "a/.."), null);
  });

  it("rejects paths that leave the root", () => {
    assert.equal(resolveInside("/root", ".."), null);
    assert.equal(resolveInside("/root", "../x"), null);
    assert.equal(resolveInside("/root", "a/../../x"), null);
    assert.equal(resolveInside("/root", "/etc/passwd"), null);
    assert.equal(resolveInside("/root", "../root-sibling/x"), null);
  });

  it("rejects null bytes and malformed escapes", () => {
    assert.equal(resolveInside("/root", "a%00.txt"), null);
    assert.equal(resolveInside("/root", "%E0%A4%A"), null);
    assert.equal(resolveInside("/root", "%"), null);
  });
});
