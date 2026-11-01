import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanName, freeName, isDocumentId, isNotInFiles } from "../../src/web/library.js";

describe("library.js", () => {
  it("knows a document's id by its form", () => {
    assert.ok(isDocumentId("6a432432-3ee3-41f0-a0cc-ea87e5af8db4"));
    for (const id of ["", "6A432432-3EE3-41F0-A0CC-EA87E5AF8DB4", "../x", 7, null]) {
      assert.ok(!isDocumentId(id), String(id));
    }
  });

  it("makes a file name of a name, or nothing", () => {
    assert.equal(cleanName("Report.pdf"), "Report.pdf");
    assert.equal(cleanName("  a/b\\c\u0000.pdf "), "abc.pdf");
    assert.equal(cleanName("x".repeat(300)).length, 255);
    for (const name of ["", " ", "/", ".", "..", 5, undefined]) {
      assert.equal(cleanName(name), null, String(name));
    }
  });

  it("gives a name that no document has, as Files does", () => {
    const records = /** @type {any[]} */ ([{ name: "Untitled.pdf" }, { name: "untitled 2.pdf" }]);
    assert.equal(freeName(records, "Report.pdf"), "Report.pdf");
    assert.equal(freeName(records, "Untitled.pdf"), "Untitled 3.pdf");
    assert.equal(freeName([{ name: "Notes" }], "Notes"), "Notes 2");
  });

  it("says a document isn't in Files while its copy has later revisions", () => {
    const record = /** @type {any} */ ({ revision: 0, exportedRevision: 0 });
    assert.equal(isNotInFiles(record), false);
    assert.equal(isNotInFiles({ ...record, revision: 2, exportedRevision: 1 }), true);
    // Made with New, and never shared.
    assert.equal(isNotInFiles({ ...record, exportedRevision: -1 }), true);
  });
});
