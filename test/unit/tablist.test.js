import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TabList } from "../../src/shared/tablist.js";

/**
 * @param {Record<number, string[]>} windows window id -> tab ids
 * @returns {TabList}
 */
function listOf(windows) {
  const list = new TabList();
  for (const [windowId, tabs] of Object.entries(windows)) {
    for (const tab of tabs) list.add(Number(windowId), tab);
  }
  return list;
}

describe("TabList add", () => {
  it("keeps the order and makes the first tab active", () => {
    const list = listOf({ 1: ["a", "b", "c"] });
    assert.deepEqual(list.tabsOf(1), ["a", "b", "c"]);
    assert.equal(list.activeTab(1), "a");
    assert.equal(list.windowOf("b"), 1);
  });

  it("inserts at every index", () => {
    for (const [index, expected] of [
      [0, ["x", "a", "b"]],
      [1, ["a", "x", "b"]],
      [2, ["a", "b", "x"]],
    ]) {
      const list = listOf({ 1: ["a", "b"] });
      list.add(1, "x", /** @type {number} */ (index));
      assert.deepEqual(list.tabsOf(1), expected);
      assert.equal(list.activeTab(1), "a");
    }
  });

  it("refuses indexes out of range and tabs already in a window", () => {
    const list = listOf({ 1: ["a"], 2: ["b"] });
    assert.throws(() => list.add(1, "x", 2), RangeError);
    assert.throws(() => list.add(1, "x", -1), RangeError);
    assert.throws(() => list.add(1, "x", 0.5), RangeError);
    assert.throws(() => list.add(3, "x", 1), RangeError);
    assert.throws(() => list.add(1, "b"), /already/);
    assert.deepEqual(list.tabsOf(1), ["a"]);
    assert.equal(list.windowOf("x"), undefined);
  });
});

describe("TabList remove", () => {
  it("activates the right neighbour of an active tab", () => {
    const list = listOf({ 1: ["a", "b", "c"] });
    list.activate("b");
    assert.equal(list.remove("b"), "c");
    assert.deepEqual(list.tabsOf(1), ["a", "c"]);
    assert.equal(list.activeTab(1), "c");
  });

  it("activates the left neighbour of an active last tab", () => {
    const list = listOf({ 1: ["a", "b", "c"] });
    list.activate("c");
    assert.equal(list.remove("c"), "b");
    assert.equal(list.activeTab(1), "b");
  });

  it("keeps the active tab when another one goes", () => {
    const list = listOf({ 1: ["a", "b", "c"] });
    list.activate("c");
    assert.equal(list.remove("a"), "c");
    assert.equal(list.activeTab(1), "c");
  });

  it("forgets a window once its last tab has gone", () => {
    const list = listOf({ 1: ["a"], 2: ["b"] });
    assert.equal(list.remove("a"), null);
    assert.deepEqual(list.tabsOf(1), []);
    assert.equal(list.activeTab(1), null);
    assert.equal(list.windowOf("a"), undefined);
    assert.deepEqual(list.tabsOf(2), ["b"]);
  });

  it("ignores unknown tabs", () => {
    const list = listOf({ 1: ["a"] });
    assert.equal(list.remove("x"), null);
    assert.deepEqual(list.tabsOf(1), ["a"]);
  });
});

describe("TabList move", () => {
  it("moves within a window to every index", () => {
    for (const [index, expected] of [
      [0, ["b", "a", "c"]],
      [1, ["a", "b", "c"]],
      [2, ["a", "c", "b"]],
    ]) {
      const list = listOf({ 1: ["a", "b", "c"] });
      assert.equal(list.move("b", 1, /** @type {number} */ (index)), true);
      assert.deepEqual(list.tabsOf(1), expected);
      assert.equal(list.activeTab(1), "a");
    }
  });

  it("keeps the moved tab active within its window", () => {
    const list = listOf({ 1: ["a", "b", "c"] });
    list.activate("a");
    list.move("a", 1, 2);
    assert.equal(list.activeTab(1), "a");
  });

  it("moves to another window at every index", () => {
    for (const [index, expected] of [
      [0, ["b", "x", "y"]],
      [1, ["x", "b", "y"]],
      [2, ["x", "y", "b"]],
    ]) {
      const list = listOf({ 1: ["a", "b", "c"], 2: ["x", "y"] });
      list.activate("b");
      list.move("b", 2, /** @type {number} */ (index));
      assert.deepEqual(list.tabsOf(1), ["a", "c"]);
      assert.equal(list.activeTab(1), "c");
      assert.deepEqual(list.tabsOf(2), expected);
      assert.equal(list.activeTab(2), "x");
      assert.equal(list.windowOf("b"), 2);
    }
  });

  it("moves into a new window, where it becomes active", () => {
    const list = listOf({ 1: ["a", "b"] });
    list.move("b", 2, 0);
    assert.deepEqual(list.tabsOf(2), ["b"]);
    assert.equal(list.activeTab(2), "b");
    assert.equal(list.activeTab(1), "a");
  });

  it("empties the window the last tab leaves", () => {
    const list = listOf({ 1: ["a"], 2: ["x"] });
    list.move("a", 2, 1);
    assert.deepEqual(list.tabsOf(1), []);
    assert.equal(list.activeTab(1), null);
    assert.deepEqual(list.tabsOf(2), ["x", "a"]);
  });

  it("refuses indexes out of range, changing nothing", () => {
    const list = listOf({ 1: ["a", "b"], 2: ["x"] });
    assert.throws(() => list.move("a", 1, 2), RangeError);
    assert.throws(() => list.move("a", 2, 2), RangeError);
    assert.throws(() => list.move("a", 3, 1), RangeError);
    assert.throws(() => list.move("a", 1, -1), RangeError);
    assert.deepEqual(list.tabsOf(1), ["a", "b"]);
    assert.deepEqual(list.tabsOf(2), ["x"]);
  });

  it("ignores unknown tabs", () => {
    const list = listOf({ 1: ["a"] });
    assert.equal(list.move("x", 1, 0), false);
    assert.deepEqual(list.tabsOf(1), ["a"]);
  });
});

describe("TabList activate", () => {
  it("makes a tab its window's active tab", () => {
    const list = listOf({ 1: ["a", "b"], 2: ["x"] });
    assert.equal(list.activate("b"), true);
    assert.equal(list.activeTab(1), "b");
    assert.equal(list.activeTab(2), "x");
  });

  it("ignores unknown tabs", () => {
    const list = listOf({ 1: ["a", "b"] });
    assert.equal(list.activate("x"), false);
    assert.equal(list.activeTab(1), "a");
  });
});

describe("TabList next and previous", () => {
  it("step from the active tab and wrap around", () => {
    const list = listOf({ 1: ["a", "b", "c"] });
    assert.equal(list.next(1), "b");
    assert.equal(list.previous(1), "c");
    list.activate("c");
    assert.equal(list.next(1), "a");
    assert.equal(list.previous(1), "b");
  });

  it("don't change the active tab", () => {
    const list = listOf({ 1: ["a", "b"] });
    list.next(1);
    list.previous(1);
    assert.equal(list.activeTab(1), "a");
  });

  it("give the only tab, or null without tabs", () => {
    const list = listOf({ 1: ["a"] });
    assert.equal(list.next(1), "a");
    assert.equal(list.previous(1), "a");
    assert.equal(list.next(2), null);
    assert.equal(list.previous(2), null);
  });
});

describe("TabList queries", () => {
  it("hand out copies", () => {
    const list = listOf({ 1: ["a", "b"] });
    list.tabsOf(1).push("x");
    assert.deepEqual(list.tabsOf(1), ["a", "b"]);
  });

  it("know nothing of unknown ids", () => {
    const list = new TabList();
    assert.deepEqual(list.tabsOf(1), []);
    assert.equal(list.windowOf("a"), undefined);
    assert.equal(list.activeTab(1), null);
  });
});
