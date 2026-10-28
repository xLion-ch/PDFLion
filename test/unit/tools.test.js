import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ERASER,
  MAX_FAVOURITES,
  parseEraser,
  parseFavourite,
  parseFavourites,
  parseToolSettings,
  readToolSettings,
  removeFavourite,
} from "../../src/main/tools.js";

const pencil = { tool: "ink", color: "#1e66f5", thickness: 1, opacity: 1 };
const text = { tool: "freetext", color: "#000000", size: 10 };
const highlight = { tool: "highlight", color: "#ffff98", thickness: 12 };

/**
 * @param {number} count
 * @returns {object[]} that many different Pencil favourites
 */
function pencils(count) {
  return Array.from({ length: count }, (_, i) => ({
    ...pencil,
    color: `#${i.toString(16).padStart(6, "0")}`,
  }));
}

describe("tools parseEraser", () => {
  it("takes both modes, and sizes from 2 to 50 points", () => {
    for (const eraser of [
      { mode: "line", size: 2 },
      { mode: "object", size: 50 },
      { mode: "line", size: 12.5 },
    ]) {
      assert.deepEqual(parseEraser(eraser), eraser);
    }
  });

  it("keeps only the mode and the size", () => {
    assert.deepEqual(parseEraser({ mode: "line", size: 10, colour: "red" }), {
      mode: "line",
      size: 10,
    });
  });

  for (const eraser of [
    { mode: "pixel", size: 10 },
    { mode: "Line", size: 10 },
    { mode: "line", size: 1.9 },
    { mode: "line", size: 50.1 },
    { mode: "line", size: "10" },
    { mode: "line", size: Number.NaN },
    { mode: "line", size: Infinity },
    { mode: "line" },
    { size: 10 },
    null,
    "line",
    [],
  ]) {
    it(`refuses ${JSON.stringify(eraser)}`, () => {
      assert.equal(parseEraser(eraser), null);
    });
  }
});

describe("tools parseFavourite", () => {
  it("takes a favourite of each tool", () => {
    for (const favourite of [pencil, text, highlight]) {
      assert.deepEqual(parseFavourite(favourite), favourite);
    }
  });

  it("takes the ends of pdf.js's ranges", () => {
    for (const favourite of [
      { ...pencil, thickness: 20, opacity: 0.05 },
      { ...text, size: 5 },
      { ...text, size: 100 },
      { ...highlight, thickness: 8 },
      { ...highlight, thickness: 24 },
    ]) {
      assert.deepEqual(parseFavourite(favourite), favourite);
    }
  });

  it("writes colours in lower case", () => {
    assert.equal(parseFavourite({ ...pencil, color: "#1E66F5" })?.color, "#1e66f5");
  });

  it("keeps only the settings of its tool", () => {
    assert.deepEqual(parseFavourite({ ...text, thickness: 3, opacity: 0.5, onclick: "x" }), text);
  });

  for (const [description, favourite] of [
    ["a thickness beyond Pencil's", { ...pencil, thickness: 21 }],
    ["an opacity below Pencil's", { ...pencil, opacity: 0 }],
    ["an opacity above Pencil's", { ...pencil, opacity: 1.5 }],
    ["a size below Text's", { ...text, size: 4 }],
    ["a size beyond Text's", { ...text, size: 101 }],
    ["a thickness below Highlight's", { ...highlight, thickness: 7 }],
    ["a thickness beyond Highlight's", { ...highlight, thickness: 25 }],
    ["a missing setting", { tool: "ink", color: "#1e66f5", thickness: 1 }],
    ["a setting as text", { ...text, size: "10" }],
    ["a setting that isn't a number", { ...pencil, opacity: Number.NaN }],
    ["no colour", { tool: "freetext", size: 10 }],
    ["a colour name", { ...text, color: "red" }],
    ["a short colour", { ...text, color: "#fff" }],
    ["a colour with alpha", { ...text, color: "#1e66f5ff" }],
    ["a colour that isn't hexadecimal", { ...text, color: "#1e66fg" }],
    ["a colour with space around it", { ...text, color: " #1e66f5" }],
    ["another tool", { ...highlight, tool: "stamp" }],
    ["an inherited property as the tool", { ...text, tool: "toString" }],
    ["no tool", { color: "#1e66f5", size: 10 }],
    ["something else than an object", "ink"],
    ["a list", [pencil]],
    ["null", null],
  ]) {
    it(`refuses ${description}`, () => {
      assert.equal(parseFavourite(favourite), null);
    });
  }
});

describe("tools parseFavourites", () => {
  it("takes a list of favourites", () => {
    assert.deepEqual(parseFavourites([pencil, text, highlight]), [pencil, text, highlight]);
    assert.deepEqual(parseFavourites([]), []);
  });

  it("drops repeats, keeping the first", () => {
    const thicker = { ...pencil, thickness: 2 };
    assert.deepEqual(
      parseFavourites([pencil, thicker, { ...pencil, color: "#1E66F5" }, text, { ...pencil }]),
      [pencil, thicker, text],
    );
  });

  it(`takes ${MAX_FAVOURITES} favourites and no more`, () => {
    assert.equal(parseFavourites(pencils(MAX_FAVOURITES))?.length, MAX_FAVOURITES);
    assert.equal(parseFavourites(pencils(MAX_FAVOURITES + 1)), null);
  });

  it("refuses a list with anything else in it", () => {
    assert.equal(parseFavourites([pencil, { ...text, size: 200 }]), null);
    assert.equal(parseFavourites([pencil, null]), null);
  });

  it("refuses what isn't a list", () => {
    assert.equal(parseFavourites(pencil), null);
    assert.equal(parseFavourites("[]"), null);
  });
});

describe("tools parseToolSettings", () => {
  it("takes the eraser's settings, the favourites, or both", () => {
    const eraser = { mode: "line", size: 20 };
    assert.deepEqual(parseToolSettings({ eraser }), { eraser });
    assert.deepEqual(parseToolSettings({ favourites: [text] }), { favourites: [text] });
    assert.deepEqual(parseToolSettings({ eraser, favourites: [] }), { eraser, favourites: [] });
  });

  it("drops repeated favourites", () => {
    assert.deepEqual(parseToolSettings({ favourites: [text, text] }), { favourites: [text] });
  });

  for (const [description, settings] of [
    ["nothing to change", {}],
    ["anything else", { eraser: DEFAULT_ERASER, theme: "dark" }],
    ["a wrong eraser", { eraser: { mode: "line", size: 100 } }],
    ["a wrong favourite", { eraser: DEFAULT_ERASER, favourites: [{ ...pencil, opacity: 2 }] }],
    ["too many favourites", { favourites: pencils(MAX_FAVOURITES + 1) }],
    ["a missing eraser", { eraser: undefined }],
    ["a list", [{ eraser: DEFAULT_ERASER }]],
    ["null", null],
  ]) {
    it(`refuses ${description}`, () => {
      assert.equal(parseToolSettings(settings), null);
    });
  }
});

describe("tools readToolSettings", () => {
  it("reads what state.json holds", () => {
    const eraser = { mode: "line", size: 30 };
    assert.deepEqual(readToolSettings({ eraser }, [pencil, highlight]), {
      eraser,
      favourites: [pencil, highlight],
    });
  });

  it("starts with the default eraser and no favourites", () => {
    const settings = readToolSettings(undefined, undefined);
    assert.deepEqual(settings, { eraser: { mode: "object", size: 10 }, favourites: [] });
    // A copy, which the caller may change.
    assert.notEqual(settings.eraser, DEFAULT_ERASER);
  });

  it("falls back to the default eraser for a wrong one", () => {
    for (const toolSettings of [{ eraser: { mode: "pixel", size: 10 } }, { eraser: null }, "line", []]) {
      assert.deepEqual(readToolSettings(toolSettings, []).eraser, DEFAULT_ERASER);
    }
  });

  it("drops wrong and repeated favourites, and keeps the rest", () => {
    assert.deepEqual(
      readToolSettings(undefined, [pencil, { ...text, size: 1 }, "ink", pencil, highlight]).favourites,
      [pencil, highlight],
    );
    assert.deepEqual(readToolSettings(undefined, { 0: pencil }).favourites, []);
  });

  it(`keeps the first ${MAX_FAVOURITES} favourites`, () => {
    const favourites = pencils(MAX_FAVOURITES + 10);
    assert.deepEqual(
      readToolSettings(undefined, favourites).favourites,
      favourites.slice(0, MAX_FAVOURITES),
    );
  });
});

describe("tools removeFavourite", () => {
  it("removes the favourite with the same settings", () => {
    const favourites = [pencil, text, highlight];
    assert.deepEqual(removeFavourite(favourites, { ...text }), [pencil, highlight]);
    assert.deepEqual(favourites, [pencil, text, highlight], "leaves the list as it was");
  });

  it("leaves the favourites when it isn't one of them", () => {
    assert.deepEqual(removeFavourite([pencil, text], { ...text, size: 11 }), [pencil, text]);
  });
});
