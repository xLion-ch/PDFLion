import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SETTINGS_BYTES,
  readSettingsFile,
  SETTINGS_VERSION,
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
