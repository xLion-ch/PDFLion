import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  docPath,
  docToken,
  HOME_URL,
  isHomeUrl,
  isTabsUrl,
  isViewerUrl,
  resolveInside,
  resolveUrl,
  TABS_URL,
  thumbnailId,
  thumbnailUrl,
  viewerUrl,
} from "../../src/main/routes.js";

// Absolute on each platform: `/app` on macOS, `C:\app` (the current drive) on Windows.
const app = path.resolve("/app");
const mounts = {
  viewer: path.join(app, "viewer"),
  pdflion: path.join(app, "src", "viewer"),
  tabs: path.join(app, "src", "tabs"),
  lib: path.join(app, "node_modules", "@cantoo", "pdf-lib", "dist"),
};
const isWindows = process.platform === "win32";
const token = "0b6c3a52-5d0e-4c55-9d1e-6f1c2f0e8a41";

/**
 * Follows a viewer URL to the document URL the way pdf.js v6.4.299 does: its
 * parseQueryString decodes `file` once with URLSearchParams, then the result is
 * resolved against the viewer's location.
 *
 * @param {string} url
 */
function documentUrlFor(url) {
  const file = new URLSearchParams(new URL(url).search).get("file");
  return new URL(file ?? "", url);
}

describe("viewerUrl", () => {
  it("points the viewer at a same-origin /doc/ URL", () => {
    const url = viewerUrl(token, "Report.pdf");
    assert.ok(url.startsWith("pdflion://app/viewer/web/viewer.html?file="));
    assert.equal(documentUrlFor(url).href, `pdflion://app/doc/${token}/Report.pdf`);
  });

  for (const name of [
    "Report #2.pdf",
    "what?.pdf",
    "100% done.pdf",
    "a+b & c=d;.pdf",
    "Ünïcödé 文件.pdf",
    "colon:in name.pdf",
  ]) {
    it(`round-trips the token and name: ${name}`, () => {
      const docUrl = documentUrlFor(viewerUrl(token, name));
      assert.equal(docUrl.search, "");
      assert.equal(docUrl.hash, "");
      assert.equal(docToken(docUrl.href), token);
      assert.equal(decodeURIComponent(docUrl.pathname.split("/").pop() ?? ""), name);
    });

    it(`gives pdf.js's url for the document: ${name}`, () => {
      // bridge.js compares the two after saving, to notice a Save As.
      const file = new URLSearchParams(new URL(viewerUrl(token, name)).search).get("file");
      assert.equal(docPath(token, name), file);
    });
  }
});

describe("isViewerUrl", () => {
  it("accepts the viewer with any query and fragment", () => {
    assert.ok(isViewerUrl("pdflion://app/viewer/web/viewer.html"));
    assert.ok(isViewerUrl(viewerUrl(token, "a.pdf")));
    assert.ok(isViewerUrl("pdflion://app/viewer/web/viewer.html?file=#page=2"));
  });

  it("rejects other pages, origins and schemes", () => {
    assert.ok(!isViewerUrl("pdflion://app/viewer/web/viewer.htm"));
    assert.ok(!isViewerUrl("pdflion://app/viewer/web/debugger.html"));
    assert.ok(!isViewerUrl("pdflion://app/pdflion/viewer.html"));
    assert.ok(!isViewerUrl("pdflion://evil/viewer/web/viewer.html"));
    assert.ok(!isViewerUrl("https://app/viewer/web/viewer.html"));
    assert.ok(!isViewerUrl("file:///viewer/web/viewer.html"));
    assert.ok(!isViewerUrl("about:blank"));
    assert.ok(!isViewerUrl(""));
  });
});

describe("isTabsUrl", () => {
  it("accepts the tab strip with any query and fragment", () => {
    assert.ok(isTabsUrl(TABS_URL));
    assert.ok(isTabsUrl(`${TABS_URL}?x=1#y`));
  });

  it("rejects the viewer, other pages, origins and schemes", () => {
    assert.ok(!isTabsUrl(viewerUrl(token, "a.pdf")));
    assert.ok(!isTabsUrl("pdflion://app/tabs/tabs.js"));
    assert.ok(!isTabsUrl("pdflion://app/tabs/"));
    assert.ok(!isTabsUrl("pdflion://app/pdflion/tabs.html"));
    assert.ok(!isTabsUrl("pdflion://evil/tabs/tabs.html"));
    assert.ok(!isTabsUrl("https://app/tabs/tabs.html"));
    assert.ok(!isTabsUrl("about:blank"));
    assert.ok(!isTabsUrl(""));
  });

  it("is not the viewer", () => {
    assert.ok(!isViewerUrl(TABS_URL));
  });
});

describe("docToken", () => {
  it("extracts the token", () => {
    assert.equal(docToken(`pdflion://app/doc/${token}/x.pdf`), token);
    assert.equal(docToken(`pdflion://app/doc/${token}/x.pdf?a=1#page=3`), token);
  });

  it("rejects anything else", () => {
    assert.equal(docToken(`pdflion://app/doc/${token}`), null);
    assert.equal(docToken(`pdflion://app/doc/${token}/`), null);
    assert.equal(docToken(`pdflion://app/doc/${token}/a/b.pdf`), null);
    assert.equal(docToken(`pdflion://app/viewer/doc/${token}/x.pdf`), null);
    assert.equal(docToken(`pdflion://evil/doc/${token}/x.pdf`), null);
    assert.equal(docToken(`https://app/doc/${token}/x.pdf`), null);
    assert.equal(docToken("not a url"), null);
  });
});

describe("resolveUrl", () => {
  it("maps each mount to its root", () => {
    assert.equal(
      resolveUrl("pdflion://app/viewer/web/viewer.html", mounts),
      path.join(mounts.viewer, "web", "viewer.html"),
    );
    assert.equal(
      resolveUrl("pdflion://app/pdflion/bridge.js", mounts),
      path.join(mounts.pdflion, "bridge.js"),
    );
    assert.equal(resolveUrl(TABS_URL, mounts), path.join(mounts.tabs, "tabs.html"));
    assert.equal(
      resolveUrl("pdflion://app/lib/pdf-lib.min.js", mounts),
      path.join(mounts.lib, "pdf-lib.min.js"),
    );
  });

  it("ignores the query and fragment", () => {
    assert.equal(
      resolveUrl("pdflion://app/viewer/web/viewer.html?file=#page=2", mounts),
      path.join(mounts.viewer, "web", "viewer.html"),
    );
  });

  it("decodes percent-encoded names", () => {
    assert.equal(
      resolveUrl("pdflion://app/viewer/web/locale/en%2DUS/viewer.ftl", mounts),
      path.join(mounts.viewer, "web", "locale", "en-US", "viewer.ftl"),
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
    "pdflion://app/tabs/..%2fmain%2fmain.js",
    "pdflion://app/lib/..%2fpackage.json",
    "pdflion://app/lib/..%2f..%2f..%2f..%2fpackage.json",
    "pdflion://app/lib/%2e%2e/%2e%2e/%2e%2e/%2e%2e/src/main/main.js",
  ]) {
    it(`rejects traversal: ${url}`, () => {
      assert.equal(resolveUrl(url, mounts), null);
    });
  }

  for (const url of [
    "pdflion://app/viewer/..%5C..%5Cpackage.json",
    "pdflion://app/viewer/web%5C..%5C..%5C..%5Cpackage.json",
    "pdflion://app/viewer/..%5Cviewer-sibling%5Csecret",
    "pdflion://app/viewer/C:%5CWindows%5Cwin.ini",
    "pdflion://app/viewer/C:/Windows/win.ini",
    "pdflion://app/viewer/%5CWindows%5Cwin.ini",
    "pdflion://app/viewer/%5C%5Cserver%5Cshare%5Cx.pdf",
  ]) {
    it(
      `rejects Windows traversal: ${url}`,
      { skip: !isWindows && "backslashes and drive letters are plain characters here" },
      () => {
        assert.equal(resolveUrl(url, mounts), null);
      },
    );
  }

  it("decodes only once", () => {
    assert.equal(
      resolveUrl("pdflion://app/viewer/%252e%252e%252fpackage.json", mounts),
      path.join(mounts.viewer, "%2e%2e%2fpackage.json"),
    );
  });
});

describe("resolveInside", () => {
  const root = path.resolve("/root");

  it("resolves paths inside the root", () => {
    assert.equal(resolveInside(root, "a/b.txt"), path.join(root, "a", "b.txt"));
    assert.equal(resolveInside(root, "a/../b.txt"), path.join(root, "b.txt"));
  });

  it("allows names that merely start with two dots", () => {
    assert.equal(resolveInside(root, "..hidden"), path.join(root, "..hidden"));
  });

  it("rejects the root itself", () => {
    assert.equal(resolveInside(root, "."), null);
    assert.equal(resolveInside(root, "a/.."), null);
  });

  it("rejects paths that leave the root", () => {
    assert.equal(resolveInside(root, ".."), null);
    assert.equal(resolveInside(root, "../x"), null);
    assert.equal(resolveInside(root, "a/../../x"), null);
    assert.equal(resolveInside(root, "/etc/passwd"), null);
    assert.equal(resolveInside(root, "../root-sibling/x"), null);
  });

  it("rejects null bytes and malformed escapes", () => {
    assert.equal(resolveInside(root, "a%00.txt"), null);
    assert.equal(resolveInside(root, "%E0%A4%A"), null);
    assert.equal(resolveInside(root, "%"), null);
  });
});

describe("Home's URLs", () => {
  it("knows Home, whatever its query and fragment, and nothing else", () => {
    assert.equal(HOME_URL, "pdflion://app/home/home.html");
    assert.ok(isHomeUrl(HOME_URL));
    assert.ok(isHomeUrl(`${HOME_URL}?x#y`));
    for (const url of [
      TABS_URL,
      "pdflion://app/home/other.html",
      "https://app/home/home.html",
      "pdflion://other/home/home.html",
    ]) {
      assert.ok(!isHomeUrl(url), url);
    }
  });

  it("names a thumbnail by its document's id and when it was written", () => {
    const url = thumbnailUrl(token, 1234);
    assert.equal(url, `pdflion://app/thumb/${token}.png?v=1234`);
    assert.equal(thumbnailId(url), token);
  });

  it("finds no thumbnail id in other URLs", () => {
    for (const url of [
      "pdflion://app/thumb/first.png",
      `pdflion://app/thumb/${token}.jpg`,
      `pdflion://app/thumb/${token}/x.png`,
      "pdflion://app/thumb/..%2Fstate.json",
      `pdflion://app/doc/${token}/a.pdf`,
      `https://app/thumb/${token}.png`,
    ]) {
      assert.equal(thumbnailId(url), null, url);
    }
  });
});
