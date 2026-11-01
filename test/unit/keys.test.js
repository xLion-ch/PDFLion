import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const KEYS = fs.readFileSync(
  path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "src", "web", "keys.js"),
  "utf8",
);

/**
 * @param {string} platform what navigator.platform says
 * @returns {any} PDFLionKeys, as keys.js defines it in a page
 */
function loadKeys(platform = "MacIntel") {
  const page = { navigator: { platform } };
  vm.runInNewContext(KEYS, page);
  return vm.runInContext("PDFLionKeys", page);
}

/**
 * @param {string} key
 * @param {string} [modifiers] such as "meta+shift"
 * @param {string} [code]
 */
const press = (key, modifiers = "", code = `Key${key.toUpperCase()}`) => ({
  key,
  code,
  metaKey: modifiers.includes("meta"),
  ctrlKey: modifiers.includes("ctrl"),
  altKey: modifiers.includes("alt"),
  shiftKey: modifiers.includes("shift"),
});

describe("keys.js", () => {
  const { shortcutOf, commandKeyHere } = loadKeys();

  it("knows the shortcuts with ⌘, as on Apple's keyboards", () => {
    const cases = [
      [press("o", "meta"), "open"],
      [press("n", "meta"), "newDocument"],
      [press("w", "meta"), "closeTab"],
      [press("s", "meta"), "save"],
      [press("S", "meta+shift"), "share"],
      [press("N", "meta+shift"), "insertBlankPage"],
      // ⌥6 types a character of its own.
      [press("§", "meta+alt", "Digit6"), "pageOverview"],
      [press("E", "meta+shift"), "eraser"],
      [press("H", "meta+shift"), "home"],
      [press("Tab", "ctrl", "Tab"), "nextTab"],
      [press("Tab", "ctrl+shift", "Tab"), "previousTab"],
    ];
    for (const [event, action] of cases) assert.equal(shortcutOf(event, "meta"), action, action);
  });

  it("knows them with Ctrl elsewhere, with Ctrl+Shift+O for the page overview", () => {
    assert.equal(shortcutOf(press("s", "ctrl"), "ctrl"), "save");
    assert.equal(shortcutOf(press("O", "ctrl+shift"), "ctrl"), "pageOverview");
    assert.equal(shortcutOf(press("Tab", "ctrl", "Tab"), "ctrl"), "nextTab");
    assert.equal(shortcutOf(press("s", "meta"), "ctrl"), null);
  });

  it("leaves other keys, and the shortcuts with other modifiers, alone", () => {
    for (const event of [
      press("s"),
      press("s", "ctrl"),
      press("s", "meta+alt"),
      press("p", "meta"),
      press("f", "meta"),
      press("=", "meta", "Equal"),
      press("z", "meta"),
      press("6", "meta", "Digit6"),
      press("Tab", "meta+ctrl", "Tab"),
    ]) {
      assert.equal(shortcutOf(event, "meta"), null, JSON.stringify(event));
    }
  });

  it("takes ⌘ on Apple's devices, iPads too, and Ctrl elsewhere", () => {
    assert.equal(commandKeyHere(), "meta");
    assert.equal(loadKeys("iPad").commandKeyHere(), "meta");
    assert.equal(loadKeys("Win32").commandKeyHere(), "ctrl");
    assert.equal(loadKeys("Linux x86_64").commandKeyHere(), "ctrl");
  });
});
