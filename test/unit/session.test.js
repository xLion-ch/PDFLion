import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSession, parseView, viewHash } from "../../src/web/session.js";

const ID = "6a432432-3ee3-41f0-a0cc-ea87e5af8db4";
const OTHER = "0b2d4a0e-58f1-4d8e-9f5d-2b6a1c3e4f50";

describe("session.js", () => {
  it("takes a view as pdf.js's location has it, rounded, and nothing more", () => {
    assert.deepEqual(parseView({ page: 3, zoom: 125.5, left: -8.4, top: 791.6, extra: 1 }), {
      page: 3,
      zoom: 125.5,
      left: -8,
      top: 792,
    });
    assert.deepEqual(parseView({ page: 1, zoom: "page-fit" }), { page: 1, zoom: "page-fit", left: 0, top: 0 });
    assert.deepEqual(parseView({ page: 1, zoom: 100, left: Infinity, top: 1e12 }), {
      page: 1,
      zoom: 100,
      left: 0,
      top: 10_000_000,
    });
    for (const value of [
      null,
      "page=1",
      { page: 0, zoom: 100 },
      { page: 1.5, zoom: 100 },
      { page: "2", zoom: 100 },
      { page: 1, zoom: 0 },
      { page: 1, zoom: 1e9 },
      { page: 1, zoom: NaN },
      { page: 1, zoom: "100" },
      { page: 1, zoom: "page-fit&search=x" },
      { page: 1 },
    ]) {
      assert.equal(parseView(value), null, JSON.stringify(value));
    }
  });

  it("writes a view as pdf.js's hash", () => {
    assert.equal(viewHash({ page: 3, zoom: 125, left: -8, top: 792 }), "page=3&zoom=125,-8,792");
    assert.equal(viewHash({ page: 1, zoom: "page-width", left: 0, top: 0 }), "page=1&zoom=page-width,0,0");
  });

  it("restores the tabs in order with the active one, and drops what isn't a tab", () => {
    const view = { page: 2, zoom: "auto", left: 0, top: 10 };
    assert.deepEqual(
      parseSession({
        tabs: [
          { kind: "document", documentId: ID, view },
          { kind: "home" },
          { kind: "document", documentId: "../x" },
          { kind: "settings" },
          null,
          { kind: "document", documentId: OTHER, view: { page: -1 } },
        ],
        active: 5,
      }),
      {
        tabs: [
          { kind: "document", documentId: ID, view },
          { kind: "home" },
          { kind: "document", documentId: OTHER, view: null },
        ],
        active: 2,
      },
    );
  });

  it("keeps a document's tab and Home once, and the last tab active without a valid one", () => {
    assert.deepEqual(
      parseSession({
        tabs: [{ kind: "home" }, { kind: "document", documentId: ID }, { kind: "home" }, { kind: "document", documentId: ID }],
        active: 3,
      }),
      { tabs: [{ kind: "home" }, { kind: "document", documentId: ID, view: null }], active: 1 },
    );
    for (const value of [undefined, null, 7, { tabs: "x" }, { tabs: [] }]) {
      assert.deepEqual(parseSession(value), { tabs: [], active: -1 }, JSON.stringify(value));
    }
  });
});
