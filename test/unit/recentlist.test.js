import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  addRecent,
  isRecentId,
  MAX_RECENT,
  readRecentList,
  removeRecent,
} from "../../src/main/recentlist.js";

/** Absolute on each platform: `/docs/a.pdf` on macOS, `C:\docs\a.pdf` on Windows. */
const file = (/** @type {string} */ name) => path.resolve("/docs", name);

/** @returns {() => string} makes the ids 00000000-0000-4000-8000-000000000001, …02 and so on */
function ids() {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

const A = "0b6c3a52-5d0e-4c55-9d1e-6f1c2f0e8a41";
const B = "7e2f9d10-3c4b-4a5e-8f6d-1a2b3c4d5e6f";

describe("readRecentList", () => {
  it("reads the entries state.json holds", () => {
    const entries = [
      { id: A, path: file("a.pdf"), openedAt: 1000 },
      { id: B, path: file("b.pdf"), openedAt: 500 },
    ];
    assert.deepEqual(readRecentList(entries, ids()), entries);
  });

  it("reads an earlier version's paths, with new ids and no time", () => {
    assert.deepEqual(readRecentList([file("a.pdf"), file("b.pdf")], ids()), [
      { id: "00000000-0000-4000-8000-000000000001", path: file("a.pdf"), openedAt: null },
      { id: "00000000-0000-4000-8000-000000000002", path: file("b.pdf"), openedAt: null },
    ]);
  });

  it("keeps only what it knows of an entry", () => {
    assert.deepEqual(
      readRecentList([{ id: A, path: file("a.pdf"), openedAt: 1, extra: "x" }], ids()),
      [{ id: A, path: file("a.pdf"), openedAt: 1 }],
    );
  });

  it("forgets a time that isn't one", () => {
    for (const openedAt of [-1, Number.NaN, "1000", null, undefined]) {
      const [entry] = readRecentList([{ id: A, path: file("a.pdf"), openedAt }], ids());
      assert.equal(entry.openedAt, null);
    }
  });

  it("drops what's wrong, and repeats of a path or an id", () => {
    assert.deepEqual(
      readRecentList(
        [
          { id: A, path: file("a.pdf"), openedAt: 3 },
          { id: "not-a-uuid", path: file("x.pdf"), openedAt: 1 },
          { id: B, path: "relative.pdf", openedAt: 1 },
          { id: B, path: file("a.pdf"), openedAt: 2 },
          { id: A, path: file("c.pdf"), openedAt: 2 },
          "relative.pdf",
          `${file("nul")}\0.pdf`,
          42,
          null,
          [file("d.pdf")],
          { id: B, path: file("b.pdf"), openedAt: 1 },
        ],
        ids(),
      ),
      [
        { id: A, path: file("a.pdf"), openedAt: 3 },
        { id: B, path: file("b.pdf"), openedAt: 1 },
      ],
    );
  });

  it(`keeps the first ${MAX_RECENT}`, () => {
    const paths = Array.from({ length: MAX_RECENT + 5 }, (_, index) => file(`${index}.pdf`));
    const entries = readRecentList(paths, ids());
    assert.equal(entries.length, MAX_RECENT);
    assert.equal(entries.at(-1)?.path, file(`${MAX_RECENT - 1}.pdf`));
  });

  it("starts empty for anything but a list", () => {
    for (const value of [undefined, null, "a.pdf", { 0: file("a.pdf") }]) {
      assert.deepEqual(readRecentList(value, ids()), []);
    }
  });
});

describe("addRecent", () => {
  const entries = [
    { id: A, path: file("a.pdf"), openedAt: 1000 },
    { id: B, path: file("b.pdf"), openedAt: 500 },
  ];

  it("puts a new document first, with a new id and the time", () => {
    const { entries: added, dropped } = addRecent(entries, file("c.pdf"), 2000, ids());
    assert.deepEqual(added, [
      { id: "00000000-0000-4000-8000-000000000001", path: file("c.pdf"), openedAt: 2000 },
      ...entries,
    ]);
    assert.deepEqual(dropped, []);
  });

  it("moves a document that's there first, keeping its id", () => {
    const { entries: added } = addRecent(entries, file("b.pdf"), 2000, ids());
    assert.deepEqual(added, [
      { id: B, path: file("b.pdf"), openedAt: 2000 },
      { id: A, path: file("a.pdf"), openedAt: 1000 },
    ]);
  });

  it(`keeps ${MAX_RECENT}, and says which fell off`, () => {
    const full = Array.from({ length: MAX_RECENT }, (_, index) => ({
      id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
      path: file(`${index}.pdf`),
      openedAt: index,
    }));
    const { entries: added, dropped } = addRecent(full, file("new.pdf"), 2000, ids());
    assert.equal(added.length, MAX_RECENT);
    assert.equal(added[0].path, file("new.pdf"));
    assert.deepEqual(dropped, [full.at(-1)]);
  });
});

describe("removeRecent", () => {
  it("removes the entry with that id, and only it", () => {
    const entries = [
      { id: A, path: file("a.pdf"), openedAt: 1 },
      { id: B, path: file("b.pdf"), openedAt: 2 },
    ];
    assert.deepEqual(removeRecent(entries, A), [entries[1]]);
    assert.deepEqual(removeRecent(entries, "unknown"), entries);
  });
});

describe("isRecentId", () => {
  it("takes UUIDs in lower case only", () => {
    assert.ok(isRecentId(A));
    for (const id of [A.toUpperCase(), `${A}x`, "../a", "", 1, null]) {
      assert.ok(!isRecentId(id), String(id));
    }
  });
});
