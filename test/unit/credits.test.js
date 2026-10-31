import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CREDITS, creditsText } from "../../src/shared/credits.js";

const README = fs.readFileSync(
  path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "README.md"),
  "utf8",
);

const components = CREDITS.flatMap((group) => group.components);

describe("creditsText", () => {
  it("lists every component with its license and link", () => {
    const lines = creditsText({}).split("\n");
    for (const { name, license, url } of components) {
      // Not a heading, such as "pdf.js includes:".
      const index = lines.findIndex((line) => line.startsWith(name) && !line.endsWith(":"));
      assert.notEqual(index, -1, name);
      if (license) assert.ok(lines[index].endsWith(`(${license})`), lines[index]);
      assert.equal(lines[index + 1], url);
    }
  });

  it("adds the versions it's given, and leaves out unknown ones", () => {
    const text = creditsText({ "pdf.js": "6.4.299", Electron: null });
    assert.match(text, /^pdf\.js 6\.4\.299 by Mozilla \(Apache-2\.0\)$/m);
    assert.match(text, /^Electron \(MIT\)$/m);
  });
});

describe("README.md", () => {
  it("links the same projects under Credits as the About panel", () => {
    const section = README.split(/^## Credits$/m)[1]?.split(/^## /m)[0];
    assert.ok(section, "README.md has a Credits section");
    const links = [...section.matchAll(/\]\((https?:[^)]+)\)/g)].map((match) => match[1]);
    assert.deepEqual(links.toSorted(), components.map((component) => component.url).toSorted());
  });
});
