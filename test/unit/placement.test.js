import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASCADE_STEP, parsePlacement, placeWindow } from "../../src/main/placement.js";

const defaultSize = { width: 1000, height: 800 };
// A laptop display below the menu bar, and a second display to its right.
const primary = { x: 0, y: 25, width: 1440, height: 875 };
const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };
const displays = [primary, secondary];

describe("parsePlacement", () => {
  it("reads what rememberPlacement() stores", () => {
    assert.deepEqual(parsePlacement({ x: -8, y: 30, width: 900, height: 700, maximized: true }), {
      bounds: { x: -8, y: 30, width: 900, height: 700 },
      maximized: true,
    });
  });

  it("treats anything but true as not maximized", () => {
    for (const maximized of [undefined, false, "true", 1]) {
      assert.equal(
        parsePlacement({ x: 0, y: 0, width: 1, height: 1, maximized })?.maximized,
        false,
      );
    }
  });

  it("rejects malformed values", () => {
    for (const value of [
      undefined,
      null,
      "window",
      [],
      {},
      { x: 0, y: 0, width: 900 },
      { x: "0", y: 0, width: 900, height: 700 },
      { x: 0.5, y: 0, width: 900, height: 700 },
      { x: 0, y: Number.NaN, width: 900, height: 700 },
      { x: 0, y: 0, width: 1e300, height: 700 },
      { x: 0, y: 0, width: 0, height: 700 },
      { x: 0, y: 0, width: 900, height: -700 },
    ]) {
      assert.equal(parsePlacement(value), null, JSON.stringify(value));
    }
  });
});

describe("placeWindow", () => {
  it("centers the default size on the primary display when nothing is remembered", () => {
    assert.deepEqual(placeWindow(null, defaultSize, displays, []), {
      x: 220,
      y: 63,
      width: 1000,
      height: 800,
    });
  });

  it("uses the remembered bounds", () => {
    const remembered = { x: 100, y: 120, width: 800, height: 600 };
    assert.deepEqual(placeWindow(remembered, defaultSize, displays, []), remembered);
  });

  it("keeps a window on the secondary display", () => {
    const remembered = { x: 2000, y: 100, width: 800, height: 600 };
    assert.deepEqual(placeWindow(remembered, defaultSize, displays, []), remembered);
  });

  it("moves a window that straddles two displays onto the one showing most of it", () => {
    const remembered = { x: 1240, y: 100, width: 800, height: 600 };
    assert.deepEqual(placeWindow(remembered, defaultSize, displays, []), {
      ...remembered,
      x: 1440,
    });
  });

  it("moves a window partly off screen back on", () => {
    assert.deepEqual(
      placeWindow({ x: -200, y: 0, width: 800, height: 600 }, defaultSize, [primary], []),
      { x: 0, y: 25, width: 800, height: 600 },
    );
    assert.deepEqual(
      placeWindow({ x: 1000, y: 600, width: 800, height: 600 }, defaultSize, [primary], []),
      { x: 640, y: 300, width: 800, height: 600 },
    );
  });

  it("shrinks a window larger than its display", () => {
    assert.deepEqual(
      placeWindow({ x: 0, y: 0, width: 1920, height: 1080 }, defaultSize, [primary], []),
      primary,
    );
  });

  it("centers a window whose display is gone on the primary display, keeping its size", () => {
    const remembered = { x: 4000, y: 100, width: 800, height: 600 };
    assert.deepEqual(placeWindow(remembered, defaultSize, displays, []), {
      x: 320,
      y: 163,
      width: 800,
      height: 600,
    });
  });

  it("cascades from windows already there", () => {
    const remembered = { x: 100, y: 120, width: 800, height: 600 };
    const first = placeWindow(remembered, defaultSize, displays, []);
    const second = placeWindow(remembered, defaultSize, displays, [first]);
    const third = placeWindow(remembered, defaultSize, displays, [second, first]);
    assert.deepEqual(second, { ...remembered, x: 100 + CASCADE_STEP, y: 120 + CASCADE_STEP });
    assert.deepEqual(third, {
      ...remembered,
      x: 100 + 2 * CASCADE_STEP,
      y: 120 + 2 * CASCADE_STEP,
    });
  });

  it("ignores windows elsewhere", () => {
    const remembered = { x: 100, y: 120, width: 800, height: 600 };
    const elsewhere = { ...remembered, x: 101 };
    assert.deepEqual(placeWindow(remembered, defaultSize, displays, [elsewhere]), remembered);
  });

  it("starts over at the top left when the cascade reaches the bottom", () => {
    const remembered = { x: 620, y: 290, width: 800, height: 600 };
    assert.deepEqual(placeWindow(remembered, defaultSize, [primary], [remembered]), {
      ...remembered,
      x: primary.x,
      y: primary.y,
    });
  });

  it("stacks windows that fill the display rather than loop", () => {
    const full = { ...primary };
    assert.deepEqual(placeWindow(full, defaultSize, [primary], [full, full]), full);
  });
});
