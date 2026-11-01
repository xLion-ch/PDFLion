import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIBRARY_VERSION,
  MAX_LIBRARY_BYTES,
  MAX_SETTINGS_BYTES,
  backupFileName,
  documentFiles,
  readLibraryFile,
  readSettingsFile,
  SETTINGS_VERSION,
  writeLibraryFile,
  writeSettingsFile,
} from "../../src/shared/backup.js";
import { MAX_FAVOURITES } from "../../src/shared/tools.js";

const pencil = { tool: "ink", color: "#1e66f5", thickness: 2, opacity: 1 };
const text = { tool: "freetext", color: "#000000", size: 10 };
const toolSettings = {
  eraser: { mode: /** @type {const} */ ("line"), size: 20 },
  penOnly: true,
  favourites: [pencil, text],
};
const exported = { app: "1.0.412", platform: "darwin", at: new Date("2026-10-31T14:00:00.000Z") };

/**
 * @param {Record<string, unknown>} changes
 * @returns {string} a settings file of version 1 with `changes`
 */
const file = (changes) =>
  JSON.stringify({ format: "pdflion-settings", version: 1, ...changes });

describe("writeSettingsFile", () => {
  it("writes the settings, with what wrote them and when", () => {
    const written = writeSettingsFile({ toolSettings, automaticUpdates: false }, exported);
    assert.ok(written.endsWith("}\n"));
    assert.deepEqual(JSON.parse(written), {
      format: "pdflion-settings",
      version: SETTINGS_VERSION,
      exportedAt: "2026-10-31T14:00:00.000Z",
      exportedBy: { app: "1.0.412", platform: "darwin" },
      toolSettings: { eraser: { mode: "line", size: 20 }, penOnly: true },
      favourites: [pencil, text],
      updates: { automatic: false },
    });
  });

  it("leaves out the updates where there's no such setting", () => {
    const written = writeSettingsFile({ toolSettings, automaticUpdates: null }, exported);
    assert.ok(!("updates" in JSON.parse(written)));
  });
});

describe("readSettingsFile", () => {
  it("reads what writeSettingsFile() wrote", () => {
    const written = writeSettingsFile({ toolSettings, automaticUpdates: true }, exported);
    assert.deepEqual(readSettingsFile(written), {
      settings: {
        eraser: { mode: "line", size: 20 },
        penOnly: true,
        favourites: [pencil, text],
        automaticUpdates: true,
      },
    });
  });

  it("reads a file with a byte order mark, as Notepad may save it", () => {
    assert.ok("settings" in readSettingsFile(`﻿${file({})}`));
  });

  it("drops what it doesn't know, and what's wrong", () => {
    const read = readSettingsFile(
      file({
        toolSettings: { eraser: { mode: "pixel", size: 10 }, penOnly: "yes", theme: "dark" },
        favourites: [pencil, { ...text, size: 1000 }, "ink", pencil, { ...text, script: "x" }],
        updates: { automatic: 1, channel: "beta" },
        windows: [{ x: 0 }],
      }),
    );
    assert.deepEqual(read, {
      settings: {
        eraser: null,
        penOnly: null,
        favourites: [pencil, text],
        automaticUpdates: null,
      },
    });
  });

  it("reads a file without settings as one that has none", () => {
    assert.deepEqual(readSettingsFile(file({ favourites: "none" })), {
      settings: { eraser: null, penOnly: null, favourites: [], automaticUpdates: null },
    });
  });

  it(`keeps ${MAX_FAVOURITES} favourites at most`, () => {
    const favourites = Array.from({ length: MAX_FAVOURITES + 5 }, (_, index) => ({
      ...pencil,
      color: `#${index.toString(16).padStart(6, "0")}`,
    }));
    const read = readSettingsFile(file({ favourites }));
    assert.ok("settings" in read);
    assert.equal(read.settings.favourites.length, MAX_FAVOURITES);
  });

  for (const [description, text, error] of [
    ["what isn't JSON", "{ format: pdflion-settings", "not-settings"],
    ["JSON that isn't an object", "[1]", "not-settings"],
    ["another format", JSON.stringify({ format: "pdflion-backup", version: 1 }), "not-settings"],
    ["a file without a version", JSON.stringify({ format: "pdflion-settings" }), "not-settings"],
    ["a version that isn't one", file({ version: "1" }), "not-settings"],
    ["a version below 1", file({ version: 0 }), "not-settings"],
    ["a newer version", file({ version: SETTINGS_VERSION + 1 }), "newer"],
    ["a file over 1 MiB", file({ padding: "x".repeat(MAX_SETTINGS_BYTES) }), "too-large"],
  ]) {
    it(`refuses ${description}`, () => {
      assert.deepEqual(readSettingsFile(text), { error });
    });
  }
});

describe("backup.js Library.json", () => {
  const ID = "6a432432-3ee3-41f0-a0cc-ea87e5af8db4";
  const OTHER = "0b2d4a0e-58f1-4d8e-9f5d-2b6a1c3e4f50";
  const report = {
    id: ID,
    name: "Report.pdf",
    size: 1234,
    createdAt: 1_700_000_000_000,
    openedAt: 1_700_000_100_000,
    modifiedAt: 1_700_000_050_000,
    revision: 3,
    exportedRevision: 1,
    source: /** @type {const} */ ("files"),
    sha256: "a".repeat(64),
    file: "Documents/Report.pdf",
    thumbnail: `Thumbnails/${ID}.png`,
  };
  const untitled = {
    ...report,
    id: OTHER,
    name: "Untitled.pdf",
    revision: 0,
    exportedRevision: -1,
    source: /** @type {const} */ ("new"),
    sha256: null,
    file: "Documents/Untitled.pdf",
    thumbnail: null,
  };

  it("names a backup by the local date", () => {
    assert.equal(backupFileName(new Date(2026, 9, 31, 23, 59)), "PDFLion Backup 2026-10-31.zip");
    assert.equal(backupFileName(new Date(2027, 0, 2)), "PDFLion Backup 2027-01-02.zip");
  });

  it("gives each document a file of its own name, with numbers for repeats", () => {
    const files = documentFiles([
      { id: "a", name: "Report.pdf" },
      { id: "b", name: "report.pdf" },
      { id: "c", name: "Report 2.pdf" },
      { id: "d", name: "Notes" },
      { id: "e", name: `${"x".repeat(251)}.pdf` },
      { id: "f", name: `${"x".repeat(251)}.pdf` },
    ]);
    assert.deepEqual([...files.values()].slice(0, 4), [
      "Documents/Report.pdf",
      "Documents/report 2.pdf",
      "Documents/Report 2 2.pdf",
      "Documents/Notes",
    ]);
    // Still a name of at most 255 characters.
    assert.equal(files.get("f"), `Documents/${"x".repeat(249)} 2.pdf`);
  });

  it("writes the documents' records, which it reads back", () => {
    const text = writeLibraryFile([report, untitled], exported);
    const file = JSON.parse(text);
    assert.equal(file.format, "pdflion-library");
    assert.equal(file.version, LIBRARY_VERSION);
    assert.deepEqual(file.exportedBy, { app: "1.0.412", platform: "darwin" });
    assert.deepEqual(readLibraryFile(text), { documents: [report, untitled], rejected: 0 });
  });

  it("drops what it doesn't know, and records that aren't right", () => {
    const wrong = [
      { ...report, id: "../x" },
      { ...report, id: ID.toUpperCase() },
      { ...report, name: "a/b.pdf" },
      { ...report, name: "" },
      { ...report, name: "x".repeat(256) },
      { ...report, size: 0 },
      { ...report, openedAt: "yesterday" },
      { ...report, revision: -1 },
      { ...report, exportedRevision: 4 },
      { ...report, exportedRevision: -2 },
      { ...report, source: "web" },
      { ...report, sha256: "A".repeat(64) },
      { ...report, file: "../Report.pdf" },
      { ...report, file: "Documents/a/b.pdf" },
      { ...report, file: "Documents/" },
      { ...report, thumbnail: `Thumbnails/${OTHER}.png` },
      null,
      "Report.pdf",
    ];
    const text = JSON.stringify({
      format: "pdflion-library",
      version: 1,
      documents: [{ ...report, extra: "x" }, ...wrong, { ...report, file: "Documents/Copy.pdf" }, { ...untitled, file: report.file }],
    });
    // The first of each id and of each file only.
    assert.deepEqual(readLibraryFile(text), { documents: [report], rejected: wrong.length + 2 });
  });

  it("refuses another format, a newer version, and a file too large", () => {
    assert.deepEqual(readLibraryFile("{"), { error: "not-library" });
    assert.deepEqual(readLibraryFile(JSON.stringify({ format: "pdflion-settings", version: 1, documents: [] })), {
      error: "not-library",
    });
    assert.deepEqual(readLibraryFile(JSON.stringify({ format: "pdflion-library", version: 1 })), {
      error: "not-library",
    });
    assert.deepEqual(readLibraryFile(JSON.stringify({ format: "pdflion-library", version: 2, documents: [] })), {
      error: "newer",
    });
    assert.deepEqual(readLibraryFile(" ".repeat(MAX_LIBRARY_BYTES + 1)), { error: "too-large" });
    assert.deepEqual(readLibraryFile(`\uFEFF${JSON.stringify({ format: "pdflion-library", version: 1, documents: [] })}`), {
      documents: [],
      rejected: 0,
    });
  });
});
