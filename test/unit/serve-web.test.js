import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { serve } from "../../scripts/serve-web.js";

describe("serve-web.js", () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let report;
  /** @type {import("node:http").Server} */
  let server;
  /** @type {string} the URL of /PDFLion/ */
  let base;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-web-"));
    fs.writeFileSync(path.join(root, "index.html"), "<title>Index</title>");
    fs.mkdirSync(path.join(root, "web"));
    fs.writeFileSync(path.join(root, "web", "index.html"), "<title>Web</title>");
    fs.writeFileSync(path.join(root, "doc.pdf"), "0123456789");
    fs.writeFileSync(path.join(root, "app.mjs"), "export {};");
    report = path.join(root, "reports", "results.jsonl");
    ({ server, urls: [base] } = await serve({ root, port: 0, report }));
  });

  after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * @param {string} relative to /PDFLion/
   * @param {RequestInit} [init]
   */
  const get = (relative, init) => fetch(new URL(relative, base), { redirect: "manual", ...init });

  it("serves the folder below /PDFLion/, with an index for each folder", async () => {
    const response = await get("");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<title>Index</title>");
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("Cache-Control"), "max-age=600");
    assert.equal(await (await get("web/")).text(), "<title>Web</title>");
    const script = await get("app.mjs");
    assert.equal(script.headers.get("Content-Type"), "text/javascript; charset=utf-8");
  });

  it("redirects to the slash, as GitHub Pages does", async () => {
    const top = await fetch(new URL("/PDFLion?x=1", base), { redirect: "manual" });
    assert.equal(top.status, 301);
    assert.equal(top.headers.get("Location"), "/PDFLion/?x=1");
    const folder = await get("web");
    assert.equal(folder.status, 301);
    assert.equal(folder.headers.get("Location"), "/PDFLion/web/");
  });

  it("answers byte ranges, and 304 for an ETag the browser has", async () => {
    const range = await get("doc.pdf", { headers: { Range: "bytes=2-5" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("Content-Range"), "bytes 2-5/10");
    assert.equal(await range.text(), "2345");
    assert.equal((await get("doc.pdf", { headers: { Range: "bytes=20-" } })).status, 416);

    const whole = await get("doc.pdf");
    await whole.arrayBuffer();
    const etag = /** @type {string} */ (whole.headers.get("ETag"));
    assert.equal((await get("doc.pdf", { headers: { "If-None-Match": etag } })).status, 304);
  });

  it("finds nothing outside the folder or /PDFLion/", async () => {
    const urls = [
      new URL("/other/", base),
      new URL("..%2F..%2Fetc%2Fpasswd", base),
      new URL("nothing.html", base),
    ];
    for (const url of urls) {
      const response = await fetch(url, { redirect: "manual" });
      assert.equal(response.status, 404, url.href);
    }
  });

  it("takes only GET and HEAD, but for reports", async () => {
    assert.equal((await get("index.html", { method: "POST", body: "x" })).status, 405);
    const head = await get("doc.pdf", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Content-Length"), "10");
  });

  it("adds each report to the file, as a line of JSON", async () => {
    const body = JSON.stringify({ trial: "features", data: { a: 1 } });
    const posted = await get("report", { method: "POST", body });
    assert.equal(posted.status, 204);
    assert.equal((await get("report", { method: "POST", body: "[1]" })).status, 400);
    assert.equal((await get("report", { method: "POST", body: "{" })).status, 400);
    const lines = fs
      .readFileSync(report, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].trial, "features");
    assert.deepEqual(lines[0].data, { a: 1 });
    assert.ok(lines[0].received);
  });
});
