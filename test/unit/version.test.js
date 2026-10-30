import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatVersion } from "../../scripts/version.js";

describe("formatVersion", () => {
  it("takes the major and minor version from package.json, and counts the commits", () => {
    assert.equal(formatVersion("1.0.0", 412), "1.0.412");
    assert.equal(formatVersion("0.1.0", 31), "0.1.31");
    assert.equal(formatVersion("12.34.0", 1), "12.34.1");
  });

  it("gives a pull request's build a pre-release of the same count", () => {
    assert.equal(formatVersion("1.0.0", 412, 7), "1.0.412-pr.7");
  });

  it("wants package.json's patch version to be 0, and nothing after it", () => {
    for (const version of ["1.0.5", "1.0", "1.0.0-beta.1", "v1.0.0", ""]) {
      assert.throws(() => formatVersion(version, 412), /package\.json/, version);
    }
  });

  it("refuses counts and pull request numbers that aren't positive integers", () => {
    for (const commits of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => formatVersion("1.0.0", commits), /commits/, String(commits));
    }
    for (const pullRequest of [0, -3, 2.5, Number.NaN]) {
      assert.throws(() => formatVersion("1.0.0", 412, pullRequest), /pull request/, String(pullRequest));
    }
  });
});
