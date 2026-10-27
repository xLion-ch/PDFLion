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
 * @param {any[][]} calls
 * @param {string} name
 * @returns {any[][]} the calls of `name`
 */
const named = (calls, name) => calls.filter(([other]) => other === name);

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
 * @param {boolean} [options.toolbar] whether the page has pdf.js's toolbar
 */
function loadBridge({ platform = "darwin", fetch, toolbar = true } = {}) {
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
    /** @type {[string, string[] | undefined][]} */
    dialogs: [],
    /** What a prompt answers: whether the user goes ahead. */
    dialogAnswer: true,
    async pageDialog(reason, items) {
      pdflion.dialogs.push([reason, items]);
      return pdflion.dialogAnswer;
    },
  };

  /** A stand-in DOM element, enough for the toolbar button and the script tag. */
  class Element {
    /** @param {string} tagName */
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      /** @type {Element[]} */
      this.children = [];
      /** @type {Record<string, Function>} */
      this.listeners = {};
      this.textContent = "";
    }
    /** @param {Element[]} children */
    append(...children) {
      this.children.push(...children);
    }
    /** @param {Element} sibling */
    before(sibling) {
      document.toolbar.splice(document.toolbar.indexOf(this), 0, sibling);
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
  }

  const separator = Object.assign(new Element("div"), { id: "editorModeSeparator" });
  /**
   * The close button of the views manager's waiting bar, which ends pdf.js's
   * wait for added files.
   */
  const stopWaiting = Object.assign(new Element("button"), {
    id: "viewsManagerStatusWaitingCloseButton",
    clicks: 0,
    click() {
      this.clicks++;
    },
  });
  const document = {
    title: "",
    listeners: /** @type {Record<string, Function>} */ ({}),
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    /** The toolbar's children, from #editorModeButtons on. */
    toolbar: /** @type {Element[]} */ ([new Element("div"), separator]),
    /** @param {string} id */
    getElementById(id) {
      if (id === stopWaiting.id) return stopWaiting;
      return toolbar ? (this.toolbar.find((element) => element.id === id) ?? null) : null;
    },
    /** @param {string} tagName */
    createElement: (tagName) => new Element(tagName),
    head: {
      /** Loads a script: @cantoo/pdf-lib's, as protocol.js would serve it. */
      append(script) {
        calls.push(["script", script.src]);
        setImmediate(() => {
          if (script.src === "/lib/pdf-lib.min.js") {
            page.PDFLib = pdfLib;
            script.onload();
          } else {
            script.onerror();
          }
        });
      },
    },
  };

  /**
   * A stand-in for @cantoo/pdf-lib: a "document" is its bytes, and a change
   * appends a marker byte, as an incremental update appends after them.
   */
  const pdfLib = {
    /** Set to make load() throw, as for a file the library can't read. */
    failure: /** @type {Error | null} */ (null),
    PDFDocument: {
      async load(bytes, options) {
        // Copies, since the bridge's arrays and objects come from another realm.
        calls.push(["PDFLib.load", [...bytes], { ...options }]);
        if (pdfLib.failure) throw pdfLib.failure;
        return {
          insertPage: (index, size) => calls.push(["PDFLib.insertPage", index, [...size]]),
          save: async () => new Uint8Array([...bytes, 0xff]),
        };
      },
    },
  };

  const eventBus = {
    /** @type {{ name: string, listener: Function, once: boolean }[]} */
    listeners: [],
    on(name, listener, options) {
      this.listeners.push({ name, listener, once: options?.once ?? false });
    },
    /** @param {string} name */
    dispatch(name) {
      for (const entry of [...this.listeners]) {
        if (entry.name !== name) continue;
        if (entry.once) this.listeners.splice(this.listeners.indexOf(entry), 1);
        entry.listener();
      }
    },
  };

  /**
   * @typedef {object} DocumentOptions
   * @property {boolean} [formData] whether a form value was typed
   * @property {object} [info] what getMetadata() answers as `info`
   * @property {boolean} [isPureXfa]
   * @property {number[]} [data] the document's bytes
   * @property {number} [numPages]
   */

  /**
   * @param {DocumentOptions} options
   * @returns {any} a stand-in for pdf.js's PDFDocumentProxy
   */
  const newDocument = ({
    formData = false,
    info = {},
    isPureXfa = false,
    data = [9],
    numPages = 1,
  }) => {
    const entries = formData ? [["4R", { value: "Ada" }]] : [];
    return {
      numPages,
      /** The order of the pages pdf.js's page tools show, once they changed it. */
      pagesMapper: {
        /** @type {Uint32Array | null} */
        order: null,
        getMapping() {
          return this.order ?? undefined;
        },
      },
      annotationStorage: {
        get size() {
          return entries.length;
        },
        onSetModified: null,
        onResetModified: null,
        /** @param {[string, unknown]} entry */
        add: (entry) => entries.push(entry),
        [Symbol.iterator]: () => entries[Symbol.iterator](),
      },
      saveDocument: async () => new Uint8Array([1, 2, 3]),
      getData: async () => new Uint8Array(data),
      getMetadata: async () => ({ info: { EncryptFilterName: null, ...info } }),
      getPage: async () => ({}),
      isPureXfa,
      extractPages: async (pageInfos, copyLevels) => {
        calls.push(["extractPages", pageInfos, copyLevels]);
        return new Uint8Array([7]);
      },
    };
  };

  const app = {
    initializedPromise: Promise.resolve(),
    eventBus,
    url: "/doc/t/a.pdf",
    _docFilename: "a.pdf",
    page: 1,
    pdfViewer: {
      /** How many pages the viewer shows, with the page tools' changes. */
      pagesCount: 1,
      currentScaleValue: "auto",
      pagesRotation: 0,
      /** @type {Promise<void> | null} */
      pagesPromise: null,
      scrollMode: 0,
      spreadMode: 0,
      /** Each page's view and /Rotate, as pdf.js's PDFPageProxy has them. */
      pages: [{ view: [0, 0, 612, 792], rotate: 0 }],
      /** @param {number} index */
      getPageView(index) {
        return { pdfPage: this.pages[index] };
      },
    },
    /** @type {any} */
    pdfThumbnailViewer: null,
    findBar: { open: record("findBar.open") },
    viewsManager: {
      visibleView: 0,
      toggle: record("viewsManager.toggle"),
      switchView: record("viewsManager.switchView"),
      close: record("viewsManager.close"),
    },
    pdfScriptingManager: {
      dispatchWillSave: async () => calls.push(["willSave"]),
      dispatchDidSave: async () => calls.push(["didSave"]),
    },
    triggerPrinting: record("triggerPrinting"),
    zoomIn: record("zoomIn"),
    zoomOut: record("zoomOut"),
    rotatePages: record("rotatePages"),
    requestPresentationMode: record("requestPresentationMode"),
    /** @param {string} url */
    setTitleUsingUrl(url, downloadUrl) {
      calls.push(["setTitleUsingUrl", url, downloadUrl]);
      app.url = url;
    },
    /** @param {string} title */
    setTitle(title) {
      document.title = title;
    },
    /** @type {any} */
    initialBookmark: null,
    /** @type {any} */
    initialRotation: null,
    /** Fails the next open() with data, as for bytes pdf.js can't read. */
    failNextOpen: false,
    /** Fails the pages of the next document opened with data, as for a broken page tree. */
    failNextPages: false,
    /** How many pages the documents opened with data have. */
    openedPages: 1,
    /**
     * Records the call. With data, it stands in for a reload: a new document,
     * and later its documentloaded, documentinit and metadataloaded.
     */
    async open(args) {
      calls.push(["open", args]);
      if (!args?.data) return;
      // pdf.js closes the open document first.
      app.pdfDocument = null;
      if (app.failNextOpen) {
        app.failNextOpen = false;
        throw new Error("Invalid PDF structure.");
      }
      app.url = "";
      // pdf.js sets its own initial view, from what it remembers.
      Object.assign(app.pdfViewer, { scrollMode: 0, spreadMode: 0, pagesCount: app.openedPages });
      app.pdfDocument = newDocument({ data: [...args.data], numPages: app.openedPages });
      if (app.failNextPages) {
        // pdf.js has the document, but not its pages, and sends no events.
        app.failNextPages = false;
        app.pdfViewer.pagesPromise = Promise.reject(new Error("Invalid page tree"));
        return;
      }
      app.pdfViewer.pagesPromise = Promise.resolve();
      setImmediate(() => {
        eventBus.dispatch("documentloaded");
        eventBus.dispatch("documentinit");
        eventBus.dispatch("metadataloaded");
      });
    },
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
      /** Other options, as set() leaves them. */
      values: /** @type {Record<string, unknown>} */ ({ viewOnLoad: 0 }),
      /** @param {string} name */
      get(name) {
        return this.values[name];
      },
      set(name, value) {
        calls.push(["options.set", name, value]);
        this.values[name] = value;
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
    pdfLib,
    /** The toolbar's elements, in order. */
    get toolbar() {
      return document.toolbar;
    },
    /**
     * Pretends pdf.js has loaded a document.
     * @param {DocumentOptions} [options]
     */
    openDocument(options = {}) {
      app.pdfDocument = newDocument(options);
      app.pdfViewer.pagesCount = app.pdfDocument.numPages;
      eventBus.dispatch("documentloaded");
      return app.pdfDocument.annotationStorage;
    },
    /**
     * Pretends pages were moved, copied or deleted in pdf.js's page tools, or
     * such a change undone.
     *
     * @param {number[]} order the document's page numbers, in the order shown
     * @param {any[]} [pageInfos] what getStructuralChanges() gives for them
     */
    changePages(order, pageInfos = [{ document: null, includePages: order.map((n) => n - 1) }]) {
      app.pdfDocument.pagesMapper.order = Uint32Array.from(order);
      app.pdfThumbnailViewer = {
        // Stays true once pages changed, as in pdf.js, until another document opens.
        hasStructuralChanges: () => app.pdfDocument.pagesMapper.order !== null,
        getStructuralChanges: () => ({ pageInfos, copyLevels: null }),
      };
      app.pdfViewer.pagesCount = order.length;
      eventBus.dispatch("pagesedited");
    },
    stopWaiting,
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
      enableSplitMerge: true,
      enableMerge: true,
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

  for (const [platform, name] of [
    ["win32", "Windows"],
    ["linux", "Linux"],
  ]) {
    it(`keeps pdf.js from the Ctrl shortcuts and F4 on ${name}`, () => {
      const bridge = loadBridge({ platform });
      for (const key of ["o", "s", "p", "f", "+", "=", "-", "0"]) {
        assert.ok(bridge.keepsFromPdfjs(press(key, "ctrl")), `Ctrl+${key}`);
      }
      assert.ok(bridge.keepsFromPdfjs(press("F", "ctrl+shift")), "Ctrl+Shift+F");
      assert.ok(bridge.keepsFromPdfjs(press("F4")), "F4");
    });

    it(`leaves pdf.js AltGr characters and other keys on ${name}`, () => {
      const bridge = loadBridge({ platform });
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
  }
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

describe("bridge.js Insert Blank Page", () => {
  it("adds a toolbar button, enabled once a document that can change has loaded", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const button = bridge.toolbar.find((element) => element.id === "pdflionInsertBlankPage");
    assert.ok(button);
    assert.equal(bridge.toolbar.indexOf(button), bridge.toolbar.length - 2, "before the separator");
    assert.equal(button.className, "toolbarButton");
    assert.equal(button.title, "Insert Blank Page");
    assert.equal(button.disabled, true);
    bridge.openDocument();
    await settle();
    assert.equal(button.disabled, false);

    button.listeners.click();
    for (let turn = 0; turn < 10; turn++) await settle();
    assert.equal(named(bridge.calls, "PDFLib.insertPage").length, 1);
  });

  it("keeps the button disabled for a locked document", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ info: { EncryptFilterName: "Standard" } });
    await settle();
    const button = bridge.toolbar.find((element) => element.id === "pdflionInsertBlankPage");
    assert.equal(button.disabled, true);
  });

  it("does without a toolbar", async () => {
    const bridge = loadBridge({ toolbar: false });
    await bridge.load();
    bridge.openDocument();
    assert.equal(await bridge.run("insertBlankPage"), true);
  });

  it("inserts a page of the current page's size after it, as an increment, and shows it", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    assert.equal(await bridge.run("insertBlankPage"), true);
    assert.deepEqual(named(bridge.calls, "PDFLib.load"), [
      ["PDFLib.load", [9], { forIncrementalUpdate: true, updateMetadata: false }],
    ]);
    assert.deepEqual(named(bridge.calls, "PDFLib.insertPage"), [["PDFLib.insertPage", 1, [612, 792]]]);
    const [[, args]] = named(bridge.calls, "open");
    assert.deepEqual([...args.data], [9, 0xff]);
    assert.equal(args.filename, "a.pdf");
    assert.equal(bridge.app.initialBookmark, "page=2&zoom=auto");
    // It keeps its URL, which save() compares against.
    assert.equal(bridge.app.url, "/doc/t/a.pdf");
    assert.deepEqual(bridge.pdflion.edited, [true]);
    assert.deepEqual(bridge.pdflion.dialogs, []);
    // Shown at initialBookmark, not where pdf.js's history left the document.
    assert.deepEqual(named(bridge.calls, "options.set"), [
      ["options.set", "viewOnLoad", 1],
      ["options.set", "viewOnLoad", 0],
    ]);
  });

  it("inserts after the current page", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    bridge.app.pdfViewer.pages = [
      { view: [0, 0, 612, 792], rotate: 0 },
      { view: [10, 20, 310, 420], rotate: 0 },
      { view: [0, 0, 612, 792], rotate: 0 },
    ];
    bridge.app.page = 2;
    await bridge.run("insertBlankPage");
    assert.deepEqual(named(bridge.calls, "PDFLib.insertPage"), [["PDFLib.insertPage", 2, [300, 400]]]);
    assert.equal(bridge.app.initialBookmark, "page=3&zoom=auto");
  });

  for (const rotate of [90, 270, -90]) {
    it(`gives the new page the size of a page shown on its side by /Rotate ${rotate}`, async () => {
      const bridge = loadBridge();
      await bridge.load();
      bridge.openDocument();
      bridge.app.pdfViewer.pages = [{ view: [0, 0, 612, 792], rotate }];
      await bridge.run("insertBlankPage");
      assert.deepEqual(named(bridge.calls, "PDFLib.insertPage")[0][2], [792, 612]);
    });
  }

  it("keeps the zoom, rotation, scroll and spread modes, and the sidebar", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    Object.assign(bridge.app.pdfViewer, {
      currentScaleValue: "1.5",
      pagesRotation: 90,
      scrollMode: 3,
      spreadMode: 1,
    });
    bridge.app.viewsManager.visibleView = 1;
    await bridge.run("insertBlankPage");
    assert.equal(bridge.app.initialBookmark, "page=2&zoom=150");
    assert.equal(bridge.app.initialRotation, 90);
    assert.equal(bridge.app.pdfViewer.scrollMode, 3);
    assert.equal(bridge.app.pdfViewer.spreadMode, 1);
    assert.deepEqual(named(bridge.calls, "viewsManager.switchView"), [["viewsManager.switchView", 1, true]]);

    bridge.app.viewsManager.visibleView = 0;
    bridge.app.pdfViewer.currentScaleValue = "page-fit";
    await bridge.run("insertBlankPage");
    assert.equal(bridge.app.initialBookmark, "page=2&zoom=page-fit");
    assert.equal(named(bridge.calls, "viewsManager.close").length, 1);
  });

  it("stays edited until saved, and then saves the changed document", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    await bridge.run("insertBlankPage");
    assert.equal(bridge.pdflion.edited.at(-1), true);
    assert.equal(await bridge.run("save"), true);
    assert.deepEqual([...bridge.pdflion.writes[0][1]], [9, 0xff]);
    assert.equal(bridge.pdflion.edited.at(-1), false);
  });

  it("keeps typed form values, by changing the bytes Save would write", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument({ formData: true });
    storage.onSetModified();
    await bridge.run("insertBlankPage");
    assert.deepEqual(named(bridge.calls, "PDFLib.load")[0][1], [1, 2, 3]);
    assert.deepEqual(bridge.pdflion.edited, [true, true]);
  });

  it("changes nothing, and says so, when the library can't read the document", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    bridge.pdfLib.failure = new Error("Page dictionary kid reference points to wrong type");
    assert.equal(await bridge.run("insertBlankPage"), false);
    assert.deepEqual(bridge.pdflion.dialogs, [["failed", undefined]]);
    assert.deepEqual(named(bridge.calls, "open"), []);
    assert.deepEqual(bridge.pdflion.edited, []);
  });

  for (const [what, failure] of [
    ["open the result", "failNextOpen"],
    ["read the result's pages", "failNextPages"],
  ]) {
    it(`goes back to the document as it was when pdf.js can't ${what}`, async () => {
      const bridge = loadBridge();
      await bridge.load();
      bridge.openDocument();
      bridge.app[failure] = true;
      assert.equal(await bridge.run("insertBlankPage"), false);
      assert.deepEqual(
        named(bridge.calls, "open").map(([, args]) => [...args.data]),
        [[9, 0xff], [9]],
      );
      assert.deepEqual(bridge.pdflion.dialogs, [["failed", undefined]]);
      assert.deepEqual(bridge.pdflion.edited, [false]);
      assert.equal(bridge.app.url, "/doc/t/a.pdf");
      // Nothing is left running.
      assert.equal(await bridge.run("insertBlankPage"), true);
    });
  }

  for (const [description, options, reason] of [
    ["with a password", { info: { EncryptFilterName: "Standard" } }, "locked-encrypted"],
    ["that are pure XFA forms", { isPureXfa: true }, "locked-xfa"],
  ]) {
    it(`refuses documents ${description}, saying why`, async () => {
      const bridge = loadBridge();
      await bridge.load();
      bridge.openDocument(/** @type {any} */ (options));
      assert.equal(await bridge.run("insertBlankPage"), false);
      assert.deepEqual(bridge.pdflion.dialogs, [[reason, undefined]]);
      assert.deepEqual(named(bridge.calls, "PDFLib.load"), []);
    });
  }

  it("asks once before changing a signed document", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ info: { IsSignaturesPresent: true } });
    bridge.pdflion.dialogAnswer = false;
    assert.equal(await bridge.run("insertBlankPage"), false);
    assert.deepEqual(named(bridge.calls, "PDFLib.load"), []);

    bridge.pdflion.dialogAnswer = true;
    assert.equal(await bridge.run("insertBlankPage"), true);
    // The answer outlives the reopened document.
    bridge.app.pdfDocument.getMetadata = async () => ({ info: { IsSignaturesPresent: true } });
    assert.equal(await bridge.run("insertBlankPage"), true);
    assert.deepEqual(bridge.pdflion.dialogs, [
      ["signed", undefined],
      ["signed", undefined],
    ]);
  });

  it("runs one page change or save at a time", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument();
    const inserting = bridge.run("insertBlankPage");
    storage.onSetModified();
    assert.equal(await bridge.run("save"), false);
    assert.equal(await inserting, true);

    storage.onSetModified();
    /** @type {Promise<unknown> | undefined} */
    let insertDuringSave;
    bridge.pdflion.duringWrite = () => {
      insertDuringSave = bridge.run("insertBlankPage");
    };
    await bridge.run("save");
    assert.equal(await insertDuringSave, false);
  });

  it("loads @cantoo/pdf-lib from /lib/ once", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    await bridge.run("insertBlankPage");
    await bridge.run("insertBlankPage");
    assert.deepEqual(named(bridge.calls, "script"), [["script", "/lib/pdf-lib.min.js"]]);
  });
});

describe("bridge.js document bytes", () => {
  /**
   * Page 2, then page 1 of another document, as pdf.js's page tools describe them.
   * @param {Uint8Array} other
   */
  const pageInfos = (other) => [
    { document: null, includePages: [[1, 0]] },
    { document: other, includePages: [[0, 1]] },
  ];

  it("writes pdf.js's page changes", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument({ numPages: 2 });
    const other = new Uint8Array([5]);
    bridge.changePages([2, 1], pageInfos(other));
    storage.add(["pdfjs_internal_editor_0", {}]);
    storage.onSetModified();
    await bridge.run("save");
    assert.deepEqual([...bridge.pdflion.writes[0][1]], [7]);
    const [[, infos, copyLevels]] = named(bridge.calls, "extractPages");
    // Only viewer annotations, which pdf.js brings along itself.
    assert.equal(infos[0].document, null);
    assert.equal(infos[1].document, other);
    assert.equal(copyLevels, null);
  });

  it("brings typed form values along with pdf.js's page changes", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument({ formData: true, numPages: 2 });
    const other = new Uint8Array([5]);
    bridge.changePages([2, 1], pageInfos(other));
    storage.onSetModified();
    await bridge.run("save");
    const [[, infos]] = named(bridge.calls, "extractPages");
    assert.deepEqual([...infos[0].document], [1, 2, 3]);
    assert.deepEqual(infos[0].includePages, [[1, 0]]);
    assert.equal(infos[1].document, other);
  });

  it("writes the document as it was once page changes are undone", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 2 });
    bridge.changePages([2, 1]);
    bridge.changePages([1, 2]);
    assert.equal(await bridge.run("saveAs"), true);
    assert.deepEqual([...bridge.pdflion.writes[0][1]], [9]);
    assert.deepEqual(named(bridge.calls, "extractPages"), []);
  });
});

describe("bridge.js page tools", () => {
  it("count pages moved, copied or deleted as edits, until they're undone", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 3 });
    bridge.changePages([2, 1, 3]);
    bridge.changePages([1, 3]);
    // pdf.js keeps an order once it has changed one, even when it's undone.
    bridge.changePages([1, 2, 3]);
    assert.deepEqual(bridge.pdflion.edited, [true, true, false]);
  });

  it("leave each shown page cached at its place, where getPage() finds it", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 3 });
    /** pdf.js's cache of pages by their place, which a page's number updates. */
    const cache = new Map();
    class Page {
      #number = 0;
      get pageNumber() {
        return this.#number;
      }
      set pageNumber(number) {
        this.#number = number;
        cache.set(number, this);
      }
    }
    const [first, second, third] = [1, 2, 3].map((number) =>
      Object.assign(new Page(), { pageNumber: number }),
    );
    const { pdfViewer } = bridge.app;

    // Deleting page 2 moves page 3 to its place.
    third.pageNumber = 2;
    pdfViewer.pages = [first, third];
    bridge.changePages([1, 3]);
    assert.equal(cache.get(2), third);

    // Undoing it moves page 3 back. Page 2 keeps its number, so pdf.js leaves
    // page 3 cached at its place.
    third.pageNumber = 3;
    pdfViewer.pages = [first, second, third];
    bridge.changePages([1, 2, 3]);
    for (const [index, page] of [first, second, third].entries()) {
      assert.equal(cache.get(index + 1), page, `page ${index + 1}`);
    }
  });

  it("keep the document edited when its form changes are undone", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const storage = bridge.openDocument({ numPages: 2 });
    bridge.changePages([2, 1]);
    storage.onSetModified();
    storage.onResetModified();
    assert.deepEqual(bridge.pdflion.edited, [true, true, true]);
  });

  it("keep a document with an inserted page edited when its form changes are undone", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    await bridge.run("insertBlankPage");
    const storage = bridge.app.pdfDocument.annotationStorage;
    storage.onSetModified();
    storage.onResetModified();
    assert.deepEqual(bridge.pdflion.edited, [true, true, true]);
  });
});

describe("bridge.js save with page changes", () => {
  it("writes them, then shows the file as saved", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 2 });
    bridge.changePages([2, 1]);
    bridge.app.page = 2;
    bridge.app.openedPages = 2;
    assert.equal(await bridge.run("save"), true);
    assert.deepEqual([...bridge.pdflion.writes[0][1]], [7]);
    const [[, args]] = named(bridge.calls, "open");
    assert.deepEqual([...args.data], [7]);
    assert.equal(args.filename, "a.pdf");
    assert.equal(bridge.app.initialBookmark, "page=2&zoom=auto");
    assert.equal(bridge.app.url, "/doc/t/a.pdf");
    assert.deepEqual(bridge.pdflion.edited, [true, false]);
    // pdf.js's page tools start afresh.
    assert.equal(bridge.app.pdfThumbnailViewer.hasStructuralChanges(), false);
    // The scripts hear of the save before the document is replaced.
    assert.deepEqual(
      bridge.calls.map(([name]) => name).filter((name) => /Save$|^open$/.test(name)),
      ["willSave", "didSave", "open"],
    );
  });

  it("shows the file under its new name after Save As", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 2 });
    bridge.changePages([2, 1]);
    bridge.pdflion.answer = "/doc/u/Copy%20of%20a.pdf";
    assert.equal(await bridge.run("saveAs"), true);
    const [[, args]] = named(bridge.calls, "open");
    assert.equal(args.filename, "Copy of a.pdf");
    assert.equal(bridge.app.url, "/doc/u/Copy%20of%20a.pdf");
  });

  for (const [what, change] of [
    ["pages", (/** @type {any} */ bridge) => bridge.changePages([2, 3, 1])],
    [
      "form values",
      (/** @type {any} */ bridge) => bridge.app.pdfDocument.annotationStorage.onSetModified(),
    ],
  ]) {
    it(`keeps the document as it is, edited, when ${what} change during the save`, async () => {
      const bridge = loadBridge();
      await bridge.load();
      bridge.openDocument({ numPages: 3 });
      bridge.changePages([2, 1, 3]);
      bridge.pdflion.duringWrite = () => change(bridge);
      assert.equal(await bridge.run("save"), true);
      assert.deepEqual(named(bridge.calls, "open"), []);
      assert.equal(bridge.pdflion.edited.at(-1), true);
    });
  }

  it("stays saved when pdf.js can't show the saved file", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 2 });
    bridge.changePages([2, 1]);
    bridge.app.failNextOpen = true;
    assert.equal(await bridge.run("save"), true);
    assert.equal(named(bridge.calls, "console.error").length, 1);
    assert.equal(bridge.pdflion.edited.at(-1), false);
  });
});

describe("bridge.js Add file", () => {
  /**
   * What pdf.js's Add file hands onSaveAndLoad() for a file of its own: the
   * open document, then the file, to insert after the first page.
   */
  const addition = () => ({
    pageInfos: [{ document: null }, { document: new Uint8Array([5]), insertAfter: 0 }],
    copyLevels: null,
  });

  /**
   * Opens a two-page document, whose pages after adding a file are `openedPages`.
   * @param {object} [options] for openDocument()
   */
  async function withDocument(options = {}, openedPages = 4) {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 2, ...options });
    bridge.app.openedPages = openedPages;
    return bridge;
  }

  it("adds the file's pages, shows the first, and counts them as edits", async () => {
    const bridge = await withDocument();
    const data = addition();
    assert.equal(await bridge.app.onSaveAndLoad({ source: {}, data }), true);
    const [[, pageInfos, copyLevels]] = named(bridge.calls, "extractPages");
    assert.equal(pageInfos, data.pageInfos);
    assert.equal(copyLevels, null);
    const [[, args]] = named(bridge.calls, "open");
    assert.deepEqual([...args.data], [7]);
    assert.equal(args.filename, "a.pdf");
    assert.equal(bridge.app.initialBookmark, "page=2&zoom=auto");
    assert.equal(bridge.app.url, "/doc/t/a.pdf");
    assert.deepEqual(bridge.pdflion.edited, [true]);
    assert.equal(bridge.stopWaiting.clicks, 0);
  });

  it("brings typed form values along", async () => {
    const bridge = await withDocument({ formData: true });
    await bridge.app.onSaveAndLoad({ data: addition() });
    const [[, pageInfos]] = named(bridge.calls, "extractPages");
    assert.deepEqual([...pageInfos[0].document], [1, 2, 3]);
    assert.deepEqual([...pageInfos[1].document], [5]);
  });

  it("goes back to the document as it was, and says so, when the file adds no pages", async () => {
    const bridge = await withDocument({}, 2);
    assert.equal(await bridge.app.onSaveAndLoad({ data: addition() }), false);
    assert.deepEqual(
      named(bridge.calls, "open").map(([, args]) => [...args.data]),
      [[7], [9]],
    );
    assert.deepEqual(bridge.pdflion.dialogs, [["failed", undefined]]);
    assert.equal(bridge.pdflion.edited.at(-1), false);
    assert.equal(bridge.stopWaiting.clicks, 1);
  });

  it("changes nothing, and says so, when pdf.js can't make the new document", async () => {
    const bridge = await withDocument();
    bridge.app.pdfDocument.extractPages = async () => null;
    assert.equal(await bridge.app.onSaveAndLoad({ data: addition() }), false);
    assert.deepEqual(named(bridge.calls, "open"), []);
    assert.deepEqual(bridge.pdflion.dialogs, [["failed", undefined]]);
    assert.equal(bridge.stopWaiting.clicks, 1);
  });

  for (const [description, options, answer, reason] of [
    [
      "refuses a document with a password",
      { info: { EncryptFilterName: "Standard" } },
      true,
      "locked-encrypted",
    ],
    [
      "leaves a signed document if the user says so",
      { info: { IsSignaturesPresent: true } },
      false,
      "signed",
    ],
  ]) {
    it(/** @type {string} */ (description), async () => {
      const bridge = await withDocument(/** @type {object} */ (options));
      bridge.pdflion.dialogAnswer = /** @type {boolean} */ (answer);
      assert.equal(await bridge.app.onSaveAndLoad({ data: addition() }), false);
      assert.deepEqual(bridge.pdflion.dialogs, [[reason, undefined]]);
      assert.deepEqual(named(bridge.calls, "extractPages"), []);
      assert.equal(bridge.stopWaiting.clicks, 1);
    });
  }

  it("doesn't run during a save", async () => {
    const bridge = await withDocument();
    bridge.app.pdfDocument.annotationStorage.onSetModified();
    /** @type {Promise<unknown> | undefined} */
    let adding;
    bridge.pdflion.duringWrite = () => {
      adding = bridge.app.onSaveAndLoad({ data: addition() });
    };
    await bridge.run("save");
    assert.equal(await adding, false);
    assert.equal(bridge.stopWaiting.clicks, 1);
    assert.deepEqual(named(bridge.calls, "extractPages"), []);
  });
});
