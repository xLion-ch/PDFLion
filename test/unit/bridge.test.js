import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "src");
const BRIDGE = fs.readFileSync(path.join(SRC, "viewer", "bridge.js"), "utf8");

/** Lets pending promises and stream reads settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A stand-in for the PDFDataRangeTransport in pdf.js's src/display/api.js,
 * which records what the bridge hands it.
 */
class FakeRangeTransport {
  /** @param {number} length */
  constructor(length, initialData) {
    this.length = length;
    this.initialData = initialData;
    /** @type {Uint8Array[]} */
    this.progressive = [];
    this.done = false;
    /** @type {[number, Uint8Array][]} */
    this.ranges = [];
  }
  onDataProgressiveRead(chunk) {
    this.progressive.push(chunk);
  }
  onDataProgressiveDone() {
    this.done = true;
  }
  onDataRange(begin, chunk) {
    this.ranges.push([begin, chunk]);
  }
}

/**
 * Runs bridge.js the way viewer.html does, in a page with stand-ins for what
 * it uses: window.pdflion from the preload, and pdf.js's PDFViewerApplication.
 *
 * @param {object} [options]
 * @param {string} [options.platform] what the preload reports
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [options.fetch]
 */
function loadBridge({ platform = "darwin", fetch } = {}) {
  /** @type {any[][]} */
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };

  const pdflion = {
    platform,
    /** @type {((command: string) => unknown) | null} */
    handle: null,
    /** @type {boolean[]} */
    edited: [],
    /** @type {[string, Uint8Array][]} */
    writes: [],
    /** What main's save and saveAs answer: the document's path, or null. */
    answer: /** @type {string | null} */ ("/doc/t/a.pdf"),
    /** Runs while main "writes", e.g. to edit the document meanwhile. */
    duringWrite: () => {},
    onCommand(callback) {
      this.handle = callback;
    },
    async save(bytes) {
      pdflion.writes.push(["save", bytes]);
      pdflion.duringWrite();
      return pdflion.answer;
    },
    async saveAs(bytes) {
      pdflion.writes.push(["saveAs", bytes]);
      return pdflion.answer;
    },
    setEdited(value) {
      pdflion.edited.push(value);
    },
  };

  const document = {
    title: "",
    listeners: /** @type {Record<string, Function>} */ ({}),
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  };

  const app = {
    initializedPromise: Promise.resolve(),
    eventBus: {
      listeners: /** @type {Record<string, Function>} */ ({}),
      on(name, listener) {
        this.listeners[name] = listener;
      },
    },
    url: "/doc/t/a.pdf",
    pdfViewer: { currentScaleValue: "auto" },
    findBar: { open: record("findBar.open") },
    viewsManager: { toggle: record("viewsManager.toggle") },
    pdfScriptingManager: {
      dispatchWillSave: async () => calls.push(["willSave"]),
      dispatchDidSave: async () => calls.push(["didSave"]),
    },
    triggerPrinting: record("triggerPrinting"),
    zoomIn: record("zoomIn"),
    zoomOut: record("zoomOut"),
    rotatePages: record("rotatePages"),
    requestPresentationMode: record("requestPresentationMode"),
    setTitleUsingUrl: record("setTitleUsingUrl"),
    /** @param {string} title */
    setTitle(title) {
      document.title = title;
    },
    open: record("open"),
    /** @type {any} */
    pdfDocument: null,
  };

  const page = {
    pdflion,
    PDFViewerApplication: app,
    PDFViewerApplicationOptions: {
      setAll(options) {
        page.options = { ...options };
      },
    },
    pdfjsLib: { PDFDataRangeTransport: FakeRangeTransport },
    /** @type {any} */
    options: null,
    listeners: /** @type {Record<string, Function>} */ ({}),
    addEventListener(type, listener) {
      page.listeners[type] = listener;
    },
    document,
    // Node gives custom schemes an opaque origin, where Chromium treats the
    // registered pdflion: scheme as standard. An https origin stands in.
    location: {
      href: "https://app.test/viewer/web/viewer.html?file=x",
      origin: "https://app.test",
    },
    fetch,
    URL,
    AbortController,
    console: { warn: record("console.warn"), error: record("console.error") },
  };
  page.window = page;
  vm.runInNewContext(BRIDGE, page, { filename: "bridge.js" });

  return {
    page,
    pdflion,
    app,
    calls,
    /** Dispatches webviewerloaded and waits for the viewer to "initialise". */
    async load() {
      document.listeners.webviewerloaded();
      await settle();
    },
    /**
     * Pretends pdf.js has loaded a document.
     * @param {{ formData?: boolean }} [options]
     */
    openDocument({ formData = false } = {}) {
      app.pdfDocument = {
        annotationStorage: { size: formData ? 1 : 0, onSetModified: null, onResetModified: null },
        saveDocument: async () => new Uint8Array([1, 2, 3]),
        getData: async () => new Uint8Array([9]),
      };
      app.eventBus.listeners.documentloaded();
      return app.pdfDocument.annotationStorage;
    },
    /** @param {string} command */
    run(command) {
      return /** @type {Function} */ (pdflion.handle)(command);
    },
    /** @param {Partial<KeyboardEvent>} key */
    keepsFromPdfjs(key) {
      let stopped = false;
      page.listeners.keydown({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...key,
        stopImmediatePropagation: () => {
          stopped = true;
        },
      });
      return stopped;
    },
  };
}

describe("bridge.js viewer options", () => {
  it("sets them before the viewer initialises", async () => {
    const bridge = loadBridge();
    await bridge.load();
    assert.deepEqual(bridge.page.options, {
      disablePreferences: true,
      defaultUrl: "",
      externalLinkTarget: 2,
    });
  });

  it("hides pdf.js's changes marker in the title", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.app.setTitle("* Report");
    assert.equal(bridge.page.document.title, "Report");
  });
});

describe("bridge.js commands", () => {
  for (const [command, expected] of [
    ["print", ["triggerPrinting"]],
    ["zoomIn", ["zoomIn"]],
    ["zoomOut", ["zoomOut"]],
    ["find", ["findBar.open"]],
    ["toggleSidebar", ["viewsManager.toggle"]],
    ["rotateLeft", ["rotatePages", -90]],
    ["rotateRight", ["rotatePages", 90]],
    ["presentation", ["requestPresentationMode"]],
  ]) {
    it(`maps ${command} to pdf.js`, async () => {
      const bridge = loadBridge();
      await bridge.load();
      bridge.run(command);
      assert.deepEqual(bridge.calls.at(-1), expected);
    });
  }

  it("maps actualSize to pdf.js's Actual Size zoom", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.run("actualSize");
    assert.equal(bridge.app.pdfViewer.currentScaleValue, "page-actual");
  });

  it("answers unknown commands with null", async () => {
    const bridge = loadBridge();
    await bridge.load();
    for (const command of ["nope", "__proto__", "constructor", "hasOwnProperty", "toString"]) {
      assert.equal(bridge.run(command), null, command);
    }
  });

  it("knows every command the menu sends", async () => {
    const menu = fs.readFileSync(path.join(SRC, "main", "menu.js"), "utf8");
    const commands = [...menu.matchAll(/commandItem\(\s*"[^"]*",\s*"(\w+)"/g)].map(([, c]) => c);
    assert.ok(commands.length >= 10, `found only ${commands}`);
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    bridge.pdflion.answer = null; // so save and saveAs write nothing
    for (const command of commands) {
      assert.notEqual(await bridge.run(command), null, command);
    }
  });
});

describe("bridge.js save", () => {
  it("writes nothing when the document is unchanged", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    assert.equal(await bridge.run("save"), true);
    assert.deepEqual(bridge.pdflion.writes, []);
  });

  it("writes the original bytes when there are no form data or annotations", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument();
    storage.onSetModified();
    assert.equal(await bridge.run("save"), true);
    assert.deepEqual(
      bridge.pdflion.writes.map(([how, bytes]) => [how, [...bytes]]),
      [["save", [9]]],
    );
    assert.deepEqual(bridge.pdflion.edited, [true, false]);
    assert.deepEqual(
      bridge.calls.filter(([name]) => name.endsWith("Save")),
      [["willSave"], ["didSave"]],
    );
  });

  it("writes pdf.js's saved document when there is form data", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument({ formData: true });
    storage.onSetModified();
    await bridge.run("save");
    assert.deepEqual([...bridge.pdflion.writes[0][1]], [1, 2, 3]);
  });

  it("stays edited when the write fails", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument({ formData: true });
    storage.onSetModified();
    bridge.pdflion.answer = null;
    assert.equal(await bridge.run("save"), false);
    assert.deepEqual(bridge.pdflion.edited, [true]);
  });

  it("ignores pdf.js clearing the edited flag before main has written", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument({ formData: true });
    storage.onSetModified();
    bridge.pdflion.answer = null;
    bridge.pdflion.duringWrite = () => storage.onResetModified(); // as saveDocument() does
    await bridge.run("save");
    assert.deepEqual(bridge.pdflion.edited, [true]);
  });

  it("stays edited after changes made during the save", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument({ formData: true });
    storage.onSetModified();
    bridge.pdflion.duringWrite = () => storage.onSetModified();
    assert.equal(await bridge.run("save"), true);
    assert.equal(bridge.pdflion.edited.at(-1), true);
  });

  it("shows the new file's name after Save As", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    bridge.pdflion.answer = "/doc/t/Copy.pdf";
    assert.equal(await bridge.run("saveAs"), true);
    assert.deepEqual(
      bridge.pdflion.writes.map(([how]) => how),
      ["saveAs"],
    );
    assert.deepEqual(
      bridge.calls.find(([name]) => name === "setTitleUsingUrl"),
      ["setTitleUsingUrl", "/doc/t/Copy.pdf", "/doc/t/Copy.pdf"],
    );
  });
});

describe("bridge.js menu shortcuts", () => {
  /** @param {string} key @param {string} modifiers e.g. "meta+shift" */
  const press = (key, modifiers = "") => ({
    key,
    metaKey: modifiers.includes("meta"),
    ctrlKey: modifiers.includes("ctrl"),
    altKey: modifiers.includes("alt"),
    shiftKey: modifiers.includes("shift"),
  });

  it("keeps pdf.js from the ⌘ shortcuts it shares with the menu on macOS", () => {
    const bridge = loadBridge({ platform: "darwin" });
    for (const key of ["o", "s", "p", "f", "+", "=", "-", "0"]) {
      assert.ok(bridge.keepsFromPdfjs(press(key, "meta")), `⌘${key}`);
    }
    assert.ok(bridge.keepsFromPdfjs(press("F", "meta+shift")), "⇧⌘F");
  });

  it("leaves pdf.js every other key on macOS", () => {
    const bridge = loadBridge({ platform: "darwin" });
    for (const [key, modifiers] of [
      ["s", "ctrl"],
      ["s", "meta+shift"],
      ["s", "meta+alt"],
      ["c", "meta"],
      ["F4", ""],
      ["f", ""],
    ]) {
      assert.ok(!bridge.keepsFromPdfjs(press(key, modifiers)), `${modifiers}+${key}`);
    }
  });

  it("keeps pdf.js from the Ctrl shortcuts and F4 on Windows", () => {
    const bridge = loadBridge({ platform: "win32" });
    for (const key of ["o", "s", "p", "f", "+", "=", "-", "0"]) {
      assert.ok(bridge.keepsFromPdfjs(press(key, "ctrl")), `Ctrl+${key}`);
    }
    assert.ok(bridge.keepsFromPdfjs(press("F", "ctrl+shift")), "Ctrl+Shift+F");
    assert.ok(bridge.keepsFromPdfjs(press("F4")), "F4");
  });

  it("leaves pdf.js AltGr characters and other keys on Windows", () => {
    const bridge = loadBridge({ platform: "win32" });
    for (const [key, modifiers] of [
      ["s", "ctrl+alt"], // AltGr+S
      ["s", "meta"],
      ["F4", "shift"],
      ["F4", "alt"],
      ["c", "ctrl"],
    ]) {
      assert.ok(!bridge.keepsFromPdfjs(press(key, modifiers)), `${modifiers}+${key}`);
    }
  });
});

describe("bridge.js range loading", () => {
  const ETAG = '"7-1000-5"';

  /** A fetch that answers the document request and then each range request. */
  function fakeFetch({
    document = () =>
      new Response(new Uint8Array(1000), { headers: { "Content-Length": "1000", ETag: ETAG } }),
    range = () => new Response(new Uint8Array(100), { status: 206 }),
  } = {}) {
    /** @type {[string, RequestInit | undefined][]} */
    const requests = [];
    const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      requests.push([url, init]);
      return /** @type {any} */ (init)?.headers ? range() : document();
    };
    return { fetch, requests };
  }

  it("opens /doc/ URLs through a transport that streams the file", async () => {
    const { fetch } = fakeFetch();
    const bridge = loadBridge({ fetch });
    await bridge.load();
    await bridge.app.open({ url: "/doc/t/a.pdf" });
    await settle();
    const [[name, args]] = bridge.calls;
    assert.equal(name, "open");
    assert.equal(args.url, "/doc/t/a.pdf");
    const transport = args.range;
    assert.ok(transport instanceof FakeRangeTransport);
    assert.equal(transport.length, 1000);
    assert.equal(
      transport.progressive.reduce((sum, chunk) => sum + chunk.length, 0),
      1000,
    );
    assert.ok(transport.done);
  });

  it("fetches ranges with the stream's ETag", async () => {
    const { fetch, requests } = fakeFetch();
    const bridge = loadBridge({ fetch });
    await bridge.load();
    await bridge.app.open({ url: "/doc/t/a.pdf" });
    const transport = bridge.calls[0][1].range;
    await transport.requestDataRange(100, 200);
    // Spread, since the page made the object in its own realm.
    assert.deepEqual(
      { ...requests.at(-1)?.[1]?.headers },
      { Range: "bytes=100-199", "If-Match": ETAG },
    );
    assert.equal(transport.ranges.length, 1);
    assert.equal(transport.ranges[0][0], 100);
    assert.equal(transport.ranges[0][1].length, 100);
  });

  it("leaves a refused range to the stream", async () => {
    const { fetch } = fakeFetch({ range: () => new Response(null, { status: 412 }) });
    const bridge = loadBridge({ fetch });
    await bridge.load();
    await bridge.app.open({ url: "/doc/t/a.pdf" });
    const transport = bridge.calls[0][1].range;
    await transport.requestDataRange(100, 200);
    assert.deepEqual(transport.ranges, []);
    assert.equal(bridge.calls.at(-1)?.[0], "console.warn");
  });

  it("ignores ranges that arrive after the document closed", async () => {
    const { fetch } = fakeFetch();
    const bridge = loadBridge({ fetch });
    await bridge.load();
    await bridge.app.open({ url: "/doc/t/a.pdf" });
    const transport = bridge.calls[0][1].range;
    transport.abort();
    await transport.requestDataRange(100, 200);
    assert.deepEqual(transport.ranges, []);
  });

  it("leaves other documents to pdf.js", async () => {
    const { fetch, requests } = fakeFetch();
    const bridge = loadBridge({ fetch });
    await bridge.load();
    for (const args of [
      { url: "https://example.com/doc/a.pdf" },
      { url: "/viewer/a.pdf" },
      { data: new Uint8Array(1) },
    ]) {
      await bridge.app.open(args);
      assert.equal(bridge.calls.at(-1)?.[1], args);
    }
    assert.deepEqual(requests, []);
  });

  it("leaves a document main can't serve to pdf.js, which reports it", async () => {
    const { fetch } = fakeFetch({ document: () => new Response("Not found", { status: 404 }) });
    const bridge = loadBridge({ fetch });
    await bridge.load();
    const args = { url: "/doc/t/gone.pdf" };
    await bridge.app.open(args);
    assert.equal(bridge.calls.at(-1)?.[1], args);
  });
});
