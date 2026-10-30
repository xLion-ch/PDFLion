import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "src");
const BRIDGE = fs.readFileSync(path.join(SRC, "viewer", "bridge.js"), "utf8");
const GEOMETRY = fs.readFileSync(path.join(SRC, "viewer", "geometry.js"), "utf8");

/** Lets pending promises and stream reads settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {any[][]} calls
 * @param {string} name
 * @returns {any[][]} the calls of `name`
 */
const named = (calls, name) => calls.filter(([other]) => other === name);

// What bridge.js looks for in pdf.js's page tools.
const THUMBNAILS = "#thumbnailsView";
const THUMBNAIL_IMAGE = "#thumbnailsView > .thumbnail > .thumbnailImageContainer";
const CURRENT_THUMBNAIL = `${THUMBNAIL_IMAGE}[aria-current="page"]`;
const CHECKED_THUMBNAIL = "#thumbnailsView > .thumbnail > input:checked";
const DRAGGING_PAGES = "#thumbnailsView.isDragging";
const TAKING_FILES = "#thumbnailsView.isDraggingFile";
const PAGE_CHANGE_ITEMS =
  "#viewsManagerStatusActionCopy, #viewsManagerStatusActionCut, #viewsManagerStatusActionDelete";
const ADD_FILE_PICKER = "#viewsManagerAddFilePicker";
/** The swatch Highlight's colour picker shows as chosen. */
const HIGHLIGHT_SWATCH = '#editorHighlightColorPicker [role="option"][aria-selected="true"]';

/**
 * What pdf.js answers about a document that holds nothing a new file of its
 * pages would drop, as getMetadata()'s `metadata` and the other calls.
 */
const NOTHING_HELD = {
  metadata: /** @type {object | null} */ (null),
  /** The ids of its optional content groups. */
  layers: /** @type {string[]} */ ([]),
  jsActions: /** @type {object | null} */ (null),
  viewerPreferences: /** @type {object | null} */ (null),
  openAction: /** @type {object | null} */ (null),
  pageMode: "UseNone",
  pageLayout: "",
  markInfo: /** @type {Map<string, boolean> | null} */ (null),
  pageLabels: /** @type {string[] | null} */ (null),
};

/** A stand-in for a DOM event the page makes, with what it was made with. */
class SyntheticEvent {
  /** @param {string} type @param {object} [init] */
  constructor(type, init = {}) {
    Object.assign(this, { type, ...init });
  }
}

/**
 * A stand-in element that is, or is in, what `selectors` select.
 *
 * @param {...string} selectors
 */
function element(...selectors) {
  return {
    /** @type {any[]} */
    dispatched: [],
    clicks: 0,
    value: "picked.pdf",
    /** @param {string} selector */
    closest(selector) {
      return selectors.includes(selector) ? this : null;
    },
    /** @param {any} event */
    dispatchEvent(event) {
      this.dispatched.push(event);
      return true;
    },
    click() {
      this.clicks++;
    },
  };
}

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
      // A copy, since the bridge's arrays come from another realm.
      pdflion.dialogs.push([reason, items && [...items]]);
      return pdflion.dialogAnswer;
    },
    /** The tool settings main keeps. */
    toolSettings: { eraser: { mode: "object", size: 24 }, favourites: [] },
    /** @type {object[]} what the page asked main to store */
    storedToolSettings: [],
    /** @type {((settings: object) => void) | null} */
    toolSettingsListener: null,
    async getToolSettings() {
      return pdflion.toolSettings;
    },
    /** @param {object} changes */
    setToolSettings(changes) {
      pdflion.storedToolSettings.push(JSON.parse(JSON.stringify(changes)));
    },
    /** @param {(settings: object) => void} callback */
    onToolSettingsChange(callback) {
      pdflion.toolSettingsListener = callback;
    },
    /** @type {object[]} the favourites whose context menu the page asked for */
    favouriteMenus: [],
    /** @param {object} favourite */
    showFavouriteMenu(favourite) {
      pdflion.favouriteMenus.push(JSON.parse(JSON.stringify(favourite)));
    },
  };

  /**
   * A stand-in DOM element, enough for the toolbar's buttons, the views
   * manager's header and the script tag.
   */
  class Element {
    /** @param {string} tagName */
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      /** @type {Element[]} */
      this.children = [];
      /** @type {Record<string, Function>} */
      this.listeners = {};
      /** @type {Record<string, string>} */
      this.attributes = {};
      this.classes = new Set();
      this.classList = {
        /** @param {string} name @param {boolean} force */
        toggle: (name, force) => {
          if (force) this.classes.add(name);
          else this.classes.delete(name);
        },
      };
      this.textContent = "";
      /** @type {Record<string, string> & { setProperty?: Function }} */
      this.style = {
        /** @param {string} name @param {string} value */
        setProperty(name, value) {
          this[name] = value;
        },
      };
    }
    /** @param {Element[]} children */
    append(...children) {
      this.children.push(...children);
    }
    /** @param {Element[]} children */
    replaceChildren(...children) {
      this.children = children;
    }
    /**
     * @param {unknown} other
     * @returns {boolean} whether it's this element or in it
     */
    contains(other) {
      return other === this || this.children.some((child) => child.contains?.(other));
    }
    focus() {
      document.activeElement = this;
    }
    /** @param {Element} sibling */
    before(sibling) {
      const siblings = this.siblings();
      siblings.splice(siblings.indexOf(this), 0, sibling);
    }
    /** @param {Element} sibling */
    after(sibling) {
      const siblings = this.siblings();
      siblings.splice(siblings.indexOf(this) + 1, 0, sibling);
    }
    /** @returns {Element[]} the list this element is in: the toolbar or the header */
    siblings() {
      return [document.toolbar, document.header].find((list) => list.includes(this)) ?? [];
    }
    /** @param {string} name @param {string} value */
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
  }

  const sidebarButton = Object.assign(new Element("button"), { id: "viewsManagerToggleButton" });
  const separator = Object.assign(new Element("div"), { id: "editorModeSeparator" });
  /** The current page's thumbnail, which takes the focus. */
  const currentThumbnail = { focus: record("thumbnail.focus") };

  /**
   * @param {number} number
   * @returns {object} the checkbox of a page's thumbnail, which a click checks
   *   or unchecks, as in pdf.js
   */
  const checkbox = (number) => ({
    get checked() {
      return document.checkedPages.includes(number);
    },
    click() {
      calls.push(["thumbnail.click", number]);
      const { checkedPages } = document;
      document.checkedPages = this.checked
        ? checkedPages.filter((other) => other !== number)
        : [...checkedPages, number];
    },
  });
  const addFileButton = Object.assign(new Element("button"), { id: "viewsManagerAddFileButton" });
  /** The views manager, which has the focus while `activeElement` is `inside`. */
  const viewsManagerElement = {
    id: "viewsManager",
    /** @param {unknown} element */
    contains: (element) => element === viewsManagerElement.inside,
    inside: {},
  };
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
  /** The viewer's outermost element, whose classes overrides.css styles by. */
  const outerContainer = {
    id: "outerContainer",
    classes: new Set(),
    classList: {
      /** @param {string} name @param {boolean} force */
      toggle(name, force) {
        if (force) outerContainer.classes.add(name);
        else outerContainer.classes.delete(name);
      },
    },
    /** @type {Element[]} what the bridge adds to it, such as the eraser's cursor */
    children: [],
    /** @param {Element[]} children */
    append(...children) {
      outerContainer.children.push(...children);
    },
  };
  const viewerContainer = Object.assign(new Element("div"), { id: "viewerContainer" });
  /**
   * pdf.js's drawing tools' group, which the stand-in toolbar shows as
   * coming before them, rather than holding them.
   */
  const editorModeButtons = Object.assign(new Element("div"), { id: "editorModeButtons" });
  /** pdf.js's Pencil, after which the eraser goes, and its button. */
  const pencil = Object.assign(new Element("div"), { id: "editorInk" });
  const pencilButton = Object.assign(new Element("button"), { id: "editorInkButton" });
  /**
   * What the option boxes of Highlight, Text and Pencil hold, by the name in
   * their ids, where Save as Favourite goes.
   */
  const optionBoxes = {
    Highlight: new Element("div"),
    FreeText: new Element("div"),
    Ink: new Element("div"),
  };
  /**
   * The drawing tools' buttons and option boxes, by the name in their ids,
   * which pdf.js's toolbar shows open with their tool.
   */
  const toolButtons = {
    Highlight: Object.assign(new Element("button"), { id: "editorHighlightButton" }),
    FreeText: Object.assign(new Element("button"), { id: "editorFreeTextButton" }),
    Ink: pencilButton,
  };
  const toolBoxes = {
    Highlight: new Element("div"),
    FreeText: new Element("div"),
    Ink: new Element("div"),
  };
  /**
   * The inputs of the option boxes, by id, with the settings pdf.js shows in
   * them: its defaults.
   * @type {Record<string, { value?: string, valueAsNumber?: number }>}
   */
  const params = {
    editorFreeHighlightThickness: { valueAsNumber: 12 },
    editorFreeTextColor: { value: "#000000" },
    editorFreeTextFontSize: { valueAsNumber: 10 },
    editorInkColor: { value: "#000000" },
    editorInkThickness: { valueAsNumber: 1 },
    editorInkOpacity: { valueAsNumber: 1 },
  };
  const document = {
    title: "",
    /** pdf.js sets `dir` to the language's direction. */
    documentElement: { dir: "ltr" },
    listeners: /** @type {Record<string, Function>} */ ({}),
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    /**
     * The toolbar's children: the sidebar's button, then from
     * #editorModeButtons on.
     */
    toolbar: /** @type {Element[]} */ ([sidebarButton, editorModeButtons, pencil, separator]),
    /** The views manager header's children, from Add file on. */
    header: /** @type {Element[]} */ ([addFileButton]),
    /** @param {string} id */
    getElementById(id) {
      if (id === stopWaiting.id) return stopWaiting;
      if (id === outerContainer.id) return outerContainer;
      if (id === viewsManagerElement.id) return viewsManagerElement;
      if (id === pencilButton.id) return pencilButton;
      if (id === viewerContainer.id) return viewerContainer;
      if (Object.hasOwn(params, id)) return params[id];
      const [, name, part] = /^editor(Highlight|FreeText|Ink)(Button|ParamsToolbar)$/.exec(id) ?? [];
      if (name) return (part === "Button" ? toolButtons : toolBoxes)[name];
      if (!toolbar) return null;
      return [...this.toolbar, ...this.header].find((element) => element.id === id) ?? null;
    },
    /** @type {unknown} */
    activeElement: null,
    /** Whether a thumbnail's checkbox is checked. */
    checked: false,
    /** The numbers of the thumbnails whose checkboxes are checked, for querySelectorAll(). */
    checkedPages: /** @type {number[]} */ ([]),
    /** Whether pdf.js is dragging pages in the thumbnails. */
    dragging: false,
    /**
     * The `data-color` of the swatch Highlight's colour picker shows as
     * chosen, or null for none.
     * @type {string | null}
     */
    highlightColor: "#FFFF98",
    /** @param {string} selector */
    querySelector(selector) {
      if (selector === CHECKED_THUMBNAIL && this.checked) return {};
      if (selector === DRAGGING_PAGES && this.dragging) return {};
      if (selector === CURRENT_THUMBNAIL) return currentThumbnail;
      if (selector === HIGHLIGHT_SWATCH && this.highlightColor) {
        const color = this.highlightColor;
        return { getAttribute: (/** @type {string} */ name) => (name === "data-color" ? color : null) };
      }
      const [, box] =
        /^#editor(\w+)ParamsToolbar > \.editorParamsToolbarContainer$/.exec(selector) ?? [];
      if (box) return (toolbar && optionBoxes[box]) || null;
      const [, number] =
        /^#thumbnailsView > \.thumbnail\[page-number="(\d+)"\] > input$/.exec(selector) ?? [];
      return number ? checkbox(Number(number)) : null;
    },
    /** @param {string} selector */
    querySelectorAll(selector) {
      if (selector !== CHECKED_THUMBNAIL) return [];
      return this.checkedPages.map((number) => ({
        parentElement: { getAttribute: (name) => (name === "page-number" ? String(number) : null) },
      }));
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
    /** Each page's /Rotate, as the file has it, by index: 0 where it's missing. */
    rotations: /** @type {number[]} */ ([]),
    /** @param {number} angle */
    degrees: (angle) => ({ type: "degrees", angle }),
    PDFDocument: {
      async load(bytes, options) {
        // Copies, since the bridge's arrays and objects come from another realm.
        calls.push(["PDFLib.load", [...bytes], { ...options }]);
        if (pdfLib.failure) throw pdfLib.failure;
        return {
          insertPage: (index, size) => calls.push(["PDFLib.insertPage", index, [...size]]),
          /** @param {number} index */
          getPage: (index) => ({
            getRotation: () => pdfLib.degrees(pdfLib.rotations[index] ?? 0),
            setRotation: (/** @type {{ type: string, angle: number }} */ rotation) =>
              calls.push(["PDFLib.setRotation", index, { ...rotation }]),
          }),
          save: async () => new Uint8Array([...bytes, 0xff]),
        };
      },
    },
  };

  const eventBus = {
    /** @type {{ name: string, listener: Function, once: boolean }[]} */
    listeners: [],
    /** @type {[string, any][]} each event dispatched, with its data */
    dispatched: [],
    on(name, listener, options) {
      this.listeners.push({ name, listener, once: options?.once ?? false });
    },
    /** @param {string} name @param {object} [data] */
    dispatch(name, data = {}) {
      this.dispatched.push([name, data]);
      for (const entry of [...this.listeners]) {
        if (entry.name !== name) continue;
        if (entry.once) this.listeners.splice(this.listeners.indexOf(entry), 1);
        entry.listener(data);
      }
    },
  };

  /**
   * A stand-in for pdf.js's ViewsManager, which tells what it shows with
   * sidebarviewchanged, as web/views_manager.js does.
   */
  const viewsManager = {
    /** What it shows, as a `SidebarView`: 0 while it's closed, 1 for the thumbnails. */
    visibleView: 0,
    /** The view it last showed, which it shows when it opens. */
    active: 1,
    get isOpen() {
      return this.visibleView !== 0;
    },
    /** What its sidebar button, F4 and View > Toggle Sidebar call. */
    toggle() {
      calls.push(["viewsManager.toggle"]);
      this.show(this.isOpen ? 0 : this.active);
    },
    /** @param {[number, boolean?]} args the view, and whether to open */
    switchView(...args) {
      calls.push(["viewsManager.switchView", ...args]);
      const [view, forceOpen] = args;
      if (forceOpen || this.visibleView !== 0) this.show(view);
    },
    close() {
      calls.push(["viewsManager.close"]);
      this.show(0);
    },
    /** @param {number} view */
    show(view) {
      if (view === this.visibleView) return;
      this.visibleView = view;
      if (view !== 0) this.active = view;
      // As open() and close() show the sidebar button, before they say so.
      sidebarButton.classList.toggle("toggled", view !== 0);
      sidebarButton.setAttribute("aria-expanded", String(view !== 0));
      eventBus.dispatch("sidebarviewchanged", { view });
    },
    /** Sets `--viewsManager-width`, by which pdf.js moves the document aside. */
    onResizing: record("viewsManager.onResizing"),
  };

  /**
   * @typedef {object} DocumentOptions
   * @property {boolean} [formData] whether a form value was typed
   * @property {object} [info] what getMetadata() answers as `info`
   * @property {boolean} [isPureXfa]
   * @property {number[]} [data] the document's bytes
   * @property {number} [numPages]
   * @property {Partial<typeof NOTHING_HELD>} [holds] what pdf.js answers about
   *   what the document holds, for what NOTHING_HELD doesn't
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
    holds = {},
  }) => {
    const entries = formData ? [["4R", { value: "Ada" }]] : [];
    const held = { ...NOTHING_HELD, ...holds };
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
      getMetadata: async () => ({
        info: { EncryptFilterName: null, ...info },
        metadata: held.metadata,
      }),
      getOptionalContentConfig: async () => new Map(held.layers.map((id) => [id, {}])),
      getJSActions: async () => held.jsActions,
      getViewerPreferences: async () => held.viewerPreferences,
      getOpenAction: async () => held.openAction,
      getPageMode: async () => held.pageMode,
      getPageLayout: async () => held.pageLayout,
      getMarkInfo: async () => held.markInfo,
      getPageLabels: async () => held.pageLabels,
      getPage: async () => ({}),
      isPureXfa,
      extractPages: async (pageInfos, copyLevels) => {
        calls.push(["extractPages", pageInfos, copyLevels]);
        return new Uint8Array([7]);
      },
    };
  };

  /** A stand-in for pdf.js's AnnotationEditorUIManager. */
  const uiManager = {
    /** Whether an editor takes the keys, as a Text box being typed in does. */
    isEditorHandlingKeyboard: false,
    unselectAll: record("ui.unselectAll"),
    addCommands: record("ui.addCommands"),
    *getEditors() {},
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
        return { pdfPage: this.pages[index], div: this.pageDiv, viewport: this.viewport };
      },
      /** @type {any} the first page's div, for the eraser */
      pageDiv: undefined,
      /** @type {any} the first page's viewport, for the eraser */
      viewport: undefined,
      focus: record("pdfViewer.focus"),
      /** pdf.js's tool, as an `AnnotationEditorType`: none until one is chosen. */
      annotationEditorMode: 0,
      _layerProperties: { annotationEditorUIManager: uiManager },
    },
    /** @type {any} */
    pdfThumbnailViewer: null,
    findBar: { open: record("findBar.open") },
    viewsManager,
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
      // pdf.js closes the open document first, and makes new thumbnails, none checked.
      app.pdfDocument = null;
      document.checkedPages = [];
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

  // pdf.js switches tools, as web/app.js and web/pdf_viewer.js do.
  eventBus.on("switchannotationeditormode", (/** @type {{ mode: number }} */ { mode }) => {
    app.pdfViewer.annotationEditorMode = mode;
    eventBus.dispatch("annotationeditormodechanged", { mode });
  });
  // pdf.js's toolbar shows each tool on, with its option box open, while its
  // mode is, before the bridge hears of it (#editorModeChanged in
  // web/toolbar.js).
  eventBus.on("annotationeditormodechanged", (/** @type {{ mode: number }} */ { mode }) => {
    for (const [name, type] of /** @type {const} */ ([["FreeText", 3], ["Highlight", 9], ["Ink", 15]])) {
      toolButtons[name].classList.toggle("toggled", mode === type);
      toolButtons[name].setAttribute("aria-expanded", String(mode === type));
      toolBoxes[name].classList.toggle("hidden", mode !== type);
    }
  });

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
    /** @type {Record<string, { listener: Function, signal?: AbortSignal }[]>} */
    listeners: {},
    addEventListener(type, listener, options) {
      (page.listeners[type] ??= []).push({ listener, signal: options?.signal });
    },
    document,
    DataTransfer: class {
      constructor() {
        /** @type {unknown[]} */
        this.files = [];
        this.items = { add: (/** @type {unknown} */ file) => this.files.push(file) };
      }
    },
    DragEvent: SyntheticEvent,
    KeyboardEvent: SyntheticEvent,
    Event: SyntheticEvent,
    // Node gives custom schemes an opaque origin, where Chromium treats the
    // registered pdflion: scheme as standard. An https origin stands in.
    location: {
      href: "https://app.test/viewer/web/viewer.html?file=x",
      origin: "https://app.test",
    },
    fetch,
    URL,
    AbortController,
    requestAnimationFrame: (/** @type {() => void} */ callback) => setImmediate(callback),
    // Node's own, looked up as they're called, which mock.timers replaces.
    setTimeout: (/** @type {() => void} */ callback, /** @type {number} */ delay) =>
      setTimeout(callback, delay),
    clearTimeout: (/** @type {any} */ timer) => clearTimeout(timer),
    // The stand-in toolbar has no layout to watch.
    ResizeObserver: class {
      observe() {}
    },
    console: { warn: record("console.warn"), error: record("console.error") },
  };
  page.window = page;
  vm.runInNewContext(GEOMETRY, page, { filename: "geometry.js" });
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
    /** The views manager header's elements, in order. */
    get header() {
      return document.header;
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
      const event = this.fire("keydown", {
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...key,
      });
      return event.stopped;
    },
    /**
     * Dispatches an event to the page's listeners on window, as capturing ones
     * get it first.
     *
     * @param {string} type
     * @param {object} [init] the event's properties
     * @returns {any} the event, which records whether it was stopped or prevented
     */
    fire(type, init = {}) {
      const event = {
        type,
        target: null,
        button: 0,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        stopped: false,
        prevented: false,
        stopPropagation() {
          this.stopped = true;
        },
        stopImmediatePropagation() {
          this.stopped = true;
        },
        preventDefault() {
          this.prevented = true;
        },
        ...init,
      };
      for (const { listener, signal } of page.listeners[type] ?? []) {
        if (!signal?.aborted) listener(event);
      }
      return event;
    },
    outerContainer,
    viewsManagerElement,
    pencil,
    pencilButton,
    uiManager,
    viewerContainer,
    optionBoxes,
    params,
    document,
    editorModeButtons,
    toolButtons,
    toolBoxes,
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

describe("bridge.js page overview", () => {
  /**
   * @param {ReturnType<typeof loadBridge>} bridge
   * @returns {number} how often the views manager said it resized, as pdf.js
   *   needs to work out where the thumbnails are
   */
  const relayouts = (bridge) =>
    bridge.app.eventBus.dispatched.filter(
      ([name, data]) => name === "resize" && data.source === bridge.app.viewsManager,
    ).length;

  /** @param {ReturnType<typeof loadBridge>} bridge */
  const isOpen = (bridge) => bridge.outerContainer.classes.has("pdflionPageOverview");

  /**
   * @param {ReturnType<typeof loadBridge>} bridge
   * @returns {[boolean, string]} whether pdf.js's sidebar button shows on, by
   *   its class and by its `aria-expanded`
   */
  const sidebarShown = (bridge) => {
    const [button] = bridge.toolbar;
    return [button.classes.has("toggled"), button.attributes["aria-expanded"]];
  };

  it("adds a toolbar button right of the sidebar's, and page tools to the views manager", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const [sidebar, button] = bridge.toolbar;
    assert.equal(sidebar.id, "viewsManagerToggleButton");
    assert.equal(button.id, "pdflionPageOverview");
    assert.equal(button.className, "toolbarButton");
    assert.equal(button.title, "Page Overview");
    assert.equal(button.attributes["aria-pressed"], "false");

    const [tools, addFile] = bridge.header;
    assert.equal(tools.id, "pdflionPageTools");
    assert.equal(addFile.id, "viewsManagerAddFileButton");
    assert.deepEqual(
      tools.children.map(({ id, title, disabled }) => [id, title, disabled]),
      [
        ["pdflionRotatePagesLeft", "Rotate Pages Left", true],
        ["pdflionRotatePagesRight", "Rotate Pages Right", true],
        ["pdflionOverviewInsertBlankPage", "Insert Blank Page", true],
      ],
    );
    for (const tool of tools.children) {
      assert.equal(tool.className, "toolbarButton viewsManagerButton");
    }
    bridge.openDocument();
    await settle();
    for (const tool of tools.children) assert.equal(tool.disabled, false, tool.id);
  });

  for (const [before, description] of [
    [0, "closed"],
    [1, "on the thumbnails"],
    [2, "on the outline"],
  ]) {
    it(`opens on the thumbnails, and leaves the sidebar ${description} as it was`, async () => {
      const bridge = loadBridge();
      await bridge.load();
      bridge.openDocument();
      const { viewsManager } = bridge.app;
      viewsManager.visibleView = before;
      const button = bridge.toolbar[1];

      assert.equal(bridge.run("pageOverview"), true);
      assert.ok(isOpen(bridge));
      assert.equal(viewsManager.visibleView, 1);
      assert.deepEqual(named(bridge.calls, "viewsManager.switchView")[0], ["viewsManager.switchView", 1, true]);
      assert.ok(button.classes.has("toggled"));
      assert.equal(button.attributes["aria-pressed"], "true");
      assert.deepEqual(sidebarShown(bridge), [false, "false"], "only the overview's button is on");
      assert.equal(relayouts(bridge), 1);
      // So that the arrow keys go from page to page.
      assert.equal(named(bridge.calls, "thumbnail.focus").length, 1);

      assert.equal(bridge.run("pageOverview"), false);
      assert.ok(!isOpen(bridge));
      assert.equal(viewsManager.visibleView, before);
      assert.ok(!button.classes.has("toggled"));
      assert.equal(button.attributes["aria-pressed"], "false");
      assert.deepEqual(sidebarShown(bridge), [before !== 0, String(before !== 0)]);
      // Laid out again in the sidebar, before it closes or switches views.
      assert.equal(relayouts(bridge), 2);
    });
  }

  it("opens and closes with its toolbar button", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const button = bridge.toolbar[1];
    button.listeners.click();
    assert.ok(isOpen(bridge));
    button.listeners.click();
    assert.ok(!isOpen(bridge));
  });

  it("keeps the document where it was while it's open", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const { viewsManager } = bridge.app;
    viewsManager.onResizing(250);
    bridge.run("pageOverview");
    viewsManager.onResizing(1200);
    bridge.run("pageOverview");
    viewsManager.onResizing(250);
    assert.deepEqual(named(bridge.calls, "viewsManager.onResizing"), [
      ["viewsManager.onResizing", 250],
      ["viewsManager.onResizing", 250],
    ]);
  });

  it("closes with Esc, unless pdf.js used it, or it cancels a drag of pages", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.run("pageOverview");
    bridge.fire("keydown", { key: "Escape", defaultPrevented: true });
    assert.ok(isOpen(bridge), "pdf.js closed something with it");
    bridge.page.document.dragging = true;
    bridge.fire("keydown", { key: "Escape" });
    assert.ok(isOpen(bridge), "pdf.js cancelled the drag with it");
    bridge.page.document.dragging = false;
    bridge.fire("keydown", { key: "Enter" });
    assert.ok(isOpen(bridge));
    bridge.fire("keydown", { key: "Escape" });
    assert.ok(!isOpen(bridge));
  });

  it("closes with a double-click on a page, which went to the page", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.run("pageOverview");
    bridge.fire("dblclick", { target: element(THUMBNAILS) });
    assert.ok(isOpen(bridge));
    bridge.fire("dblclick", { target: element(THUMBNAIL_IMAGE) });
    assert.ok(!isOpen(bridge));
    // Closed, a double-click on a thumbnail in the sidebar leaves it open.
    bridge.app.viewsManager.visibleView = 1;
    bridge.fire("dblclick", { target: element(THUMBNAIL_IMAGE) });
    assert.equal(bridge.app.viewsManager.visibleView, 1);
  });

  it("gives the focus to the document when it closes with the focus inside", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.run("pageOverview");
    bridge.run("pageOverview");
    assert.deepEqual(named(bridge.calls, "pdfViewer.focus"), []);

    bridge.run("pageOverview");
    bridge.page.document.activeElement = bridge.viewsManagerElement.inside;
    bridge.fire("keydown", { key: "Escape" });
    assert.equal(named(bridge.calls, "pdfViewer.focus").length, 1);
  });

  it("closes when pdf.js closes the views manager", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.run("pageOverview");
    bridge.app.viewsManager.close();
    assert.ok(!isOpen(bridge));
    assert.ok(!bridge.toolbar[1].classes.has("toggled"));
    // The next toggle opens it again.
    assert.equal(bridge.run("pageOverview"), true);
  });

  it("shows the sidebar instead when the sidebar is toggled while it's open", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const { viewsManager } = bridge.app;
    const toggleButton = element("#viewsManagerToggleButton");

    // pdf.js's sidebar button, whose own listener mustn't toggle it as well.
    bridge.run("pageOverview");
    assert.ok(bridge.fire("click", { target: toggleButton }).stopped);
    assert.ok(!isOpen(bridge));
    assert.equal(viewsManager.visibleView, 1, "the thumbnails, in the sidebar");
    assert.deepEqual(sidebarShown(bridge), [true, "true"]);

    // View > Toggle Sidebar, and F4 in pdf.js, which call toggle(), with the
    // outline in the sidebar before.
    viewsManager.switchView(2);
    bridge.run("pageOverview");
    bridge.run("toggleSidebar");
    assert.ok(!isOpen(bridge));
    assert.equal(viewsManager.visibleView, 2);
    assert.deepEqual(sidebarShown(bridge), [true, "true"]);

    // Without the overview, as pdf.js toggles it.
    bridge.run("toggleSidebar");
    assert.equal(viewsManager.visibleView, 0);
    assert.ok(!bridge.fire("click", { target: toggleButton }).stopped);
  });

  it("keeps pdf.js's sidebar button off while reopen() shows a changed document", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 3 });
    const { app } = bridge;
    app.pdfViewer.pages = Array(3).fill({ view: [0, 0, 612, 792], rotate: 0 });
    // Say pdf.js closes the views manager as it loads it: reopen() opens it again.
    const { open } = app;
    app.open = async (/** @type {any} */ args) => {
      if (args?.data) app.viewsManager.close();
      return open(args);
    };
    bridge.run("pageOverview");
    await bridge.run("insertBlankPage");
    await settle();
    assert.equal(named(bridge.calls, "PDFLib.insertPage").length, 1);
    assert.ok(isOpen(bridge));
    assert.equal(app.viewsManager.visibleView, 1);
    assert.deepEqual(sidebarShown(bridge), [false, "false"]);
  });

  it("lays the thumbnails out again when the window resizes while it's open", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.fire("resize");
    assert.equal(relayouts(bridge), 0);
    bridge.run("pageOverview");
    bridge.fire("resize");
    assert.equal(relayouts(bridge), 2);
  });

  it("stays open while a page change reopens the document", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    bridge.run("pageOverview");
    // pdf.js opens the views manager on the document's page mode, such as its outline.
    const { open } = bridge.app;
    bridge.app.open = async (args) => {
      await open(args);
      bridge.app.viewsManager.switchView(2, true);
    };
    const before = relayouts(bridge);
    assert.equal(await bridge.run("insertBlankPage"), true);
    assert.ok(isOpen(bridge));
    assert.equal(bridge.app.viewsManager.visibleView, 1);
    // The new document's thumbnails are laid out.
    assert.equal(relayouts(bridge), before + 1);
  });

  it("inserts a blank page after the last checked page", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 3 });
    bridge.app.pdfViewer.pages = [
      { view: [0, 0, 612, 792], rotate: 0 },
      { view: [0, 0, 612, 792], rotate: 0 },
      { view: [0, 0, 300, 400], rotate: 0 },
    ];
    bridge.page.document.checkedPages = [1, 3];
    bridge.run("pageOverview");
    await bridge.header[0].children[2].listeners.click();
    assert.deepEqual(named(bridge.calls, "PDFLib.insertPage"), [["PDFLib.insertPage", 3, [300, 400]]]);
    assert.equal(bridge.app.initialBookmark, "page=4&zoom=auto");
  });

  it("inserts after the current page with no page checked, or outside the overview", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 3 });
    bridge.app.pdfViewer.pages = Array(3).fill({ view: [0, 0, 612, 792], rotate: 0 });
    bridge.app.page = 2;
    bridge.run("pageOverview");
    await bridge.run("insertBlankPage");
    bridge.run("pageOverview");
    bridge.page.document.checkedPages = [3];
    bridge.app.page = 2;
    await bridge.run("insertBlankPage");
    assert.deepEqual(
      named(bridge.calls, "PDFLib.insertPage").map(([, index]) => index),
      [2, 2],
    );
  });
});

describe("bridge.js rotating pages", () => {
  /**
   * @param {ReturnType<typeof loadBridge>} bridge
   * @returns {[number, number][]} each page turned, by index, and its new /Rotate
   */
  const turned = (bridge) =>
    named(bridge.calls, "PDFLib.setRotation").map(([, index, { type, angle }]) => {
      assert.equal(type, "degrees");
      return [index, angle];
    });

  /**
   * Opens a three-page document and clicks one of the overview's buttons.
   *
   * @param {"left" | "right"} direction
   * @param {object} [state]
   * @param {number[]} [state.checked] the pages checked in the thumbnails
   * @param {number[]} [state.rotations] each page's /Rotate
   * @param {number} [state.page] the current page
   */
  async function rotate(direction, { checked = [], rotations = [], page = 1 } = {}) {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 3 });
    await settle();
    bridge.app.openedPages = 3;
    bridge.app.page = page;
    bridge.page.document.checkedPages = checked;
    bridge.pdfLib.rotations = rotations;
    const [rotateLeft, rotateRight] = bridge.header[0].children;
    const button = direction === "left" ? rotateLeft : rotateRight;
    const done = await button.listeners.click();
    return { bridge, done };
  }

  it("turns the checked pages right, as an increment, and keeps them checked", async () => {
    const { bridge, done } = await rotate("right", { checked: [3, 1], page: 2 });
    assert.equal(done, true);
    assert.deepEqual(named(bridge.calls, "PDFLib.load"), [
      ["PDFLib.load", [9], { forIncrementalUpdate: true, updateMetadata: false }],
    ]);
    assert.deepEqual(turned(bridge), [
      [0, 90],
      [2, 90],
    ]);
    const [[, args]] = named(bridge.calls, "open");
    assert.deepEqual([...args.data], [9, 0xff]);
    // At the page it showed, with the same pages checked, in a new document.
    assert.equal(bridge.app.initialBookmark, "page=2&zoom=auto");
    assert.deepEqual(named(bridge.calls, "thumbnail.click"), [
      ["thumbnail.click", 1],
      ["thumbnail.click", 3],
    ]);
    assert.deepEqual(bridge.page.document.checkedPages, [1, 3]);
    assert.deepEqual(bridge.pdflion.edited, [true]);
  });

  it("turns the current page when no page is checked", async () => {
    const { bridge } = await rotate("left", { page: 2 });
    assert.deepEqual(turned(bridge), [[1, 270]]);
    assert.deepEqual(named(bridge.calls, "thumbnail.click"), []);
  });

  for (const [rotation, direction, expected] of /** @type {const} */ ([
    [0, "right", 90],
    [90, "right", 180],
    [270, "right", 0],
    [0, "left", 270],
    [90, "left", 0],
    // As pdf.js shows them: past 360 and below 0 wrap around, and an angle
    // that isn't a quarter turn counts as none.
    [450, "right", 180],
    [-90, "right", 0],
    [-450, "left", 180],
    [45, "left", 270],
  ])) {
    it(`turns a page at ${rotation}° ${direction} to ${expected}°`, async () => {
      const { bridge } = await rotate(direction, { rotations: [rotation] });
      assert.deepEqual(turned(bridge), [[0, expected]]);
    });
  }

  it("keeps the pages checked when pdf.js can't show the result", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 3 });
    await settle();
    bridge.app.openedPages = 3;
    bridge.app.failNextOpen = true;
    bridge.page.document.checkedPages = [2];
    assert.equal(await bridge.header[0].children[1].listeners.click(), false);
    assert.deepEqual(
      named(bridge.calls, "open").map(([, args]) => [...args.data]),
      [[9, 0xff], [9]],
    );
    assert.deepEqual(bridge.pdflion.dialogs, [["failed", undefined]]);
    assert.deepEqual(bridge.page.document.checkedPages, [2]);
  });

  it("refuses a document with a password, saying why", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ info: { EncryptFilterName: "Standard" } });
    await settle();
    for (const button of bridge.header[0].children) assert.equal(button.disabled, true);
    assert.equal(await bridge.header[0].children[1].listeners.click(), false);
    assert.deepEqual(bridge.pdflion.dialogs, [["locked-encrypted", undefined]]);
    assert.deepEqual(named(bridge.calls, "PDFLib.load"), []);
  });

  it("doesn't run during a save", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument();
    await settle();
    bridge.app.pdfDocument.annotationStorage.onSetModified();
    /** @type {Promise<unknown> | undefined} */
    let rotating;
    bridge.pdflion.duringWrite = () => {
      rotating = bridge.header[0].children[1].listeners.click();
    };
    await bridge.run("save");
    assert.equal(await rotating, false);
    assert.deepEqual(named(bridge.calls, "PDFLib.load"), []);
  });
});

describe("bridge.js eraser", () => {
  /** @param {ReturnType<typeof loadBridge>} bridge */
  const eraserOf = (bridge) => {
    const container = bridge.toolbar.find((element) => element.id === "pdflionEditorEraser");
    const [button, box] = container.children;
    const [settings] = box.children;
    const [modes, sizeSetter] = settings.children;
    const [line, object] = modes.children.map((/** @type {any} */ label) => label.children[0]);
    return { container, button, box, line, object, size: sizeSetter.children[1] };
  };

  /** @param {ReturnType<typeof loadBridge>} bridge */
  const mode = (bridge) => bridge.app.pdfViewer.annotationEditorMode;

  /** @param {ReturnType<typeof loadBridge>} bridge */
  const isErasing = (bridge) => bridge.outerContainer.classes.has("pdflionErasing");

  /** @param {ReturnType<typeof loadBridge>} bridge @param {number} mode */
  const switchTool = (bridge, mode) =>
    bridge.app.eventBus.dispatch("switchannotationeditormode", { mode });

  it("adds a button after Pencil, with an option box and a circle for the pages", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const { container, button, box, line, object, size } = eraserOf(bridge);
    assert.equal(bridge.toolbar.indexOf(container), bridge.toolbar.indexOf(bridge.pencil) + 1);
    assert.equal(container.className, "toolbarButtonWithContainer");
    assert.equal(button.id, "pdflionEditorEraserButton");
    assert.equal(button.title, "Eraser");
    assert.equal(button.attributes["aria-controls"], box.id);
    assert.equal(box.className, "editorParamsToolbar hidden doorHangerRight");
    assert.deepEqual([line.value, object.value], ["line", "object"]);
    assert.equal(line.disabled, undefined);
    assert.equal(object.disabled, undefined);
    assert.deepEqual([size.min, size.max], ["2", "50"]);
    const [cursor] = bridge.outerContainer.children;
    assert.equal(cursor.id, "pdflionEraserCursor");
    assert.equal(cursor.hidden, true);
  });

  it("works whenever pdf.js's tools do", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const { button } = eraserOf(bridge);
    assert.equal(button.disabled, true);
    bridge.app.eventBus.dispatch("annotationeditormodechanged", { mode: 0 });
    assert.equal(button.disabled, false);
    bridge.app.eventBus.dispatch("annotationeditormodechanged", { mode: -1 });
    assert.equal(button.disabled, true);
  });

  it("shows the settings main keeps for every tab, and has main keep new ones", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const { object, size } = eraserOf(bridge);
    assert.equal(size.value, "24");
    assert.equal(object.checked, true);
    bridge.pdflion.toolSettingsListener?.({ eraser: { mode: "object", size: 40 }, favourites: [] });
    assert.equal(size.value, "40");

    size.value = "30";
    size.listeners.input();
    assert.deepEqual(bridge.pdflion.storedToolSettings, [], "not before the slider is let go");
    size.listeners.change();
    assert.deepEqual(bridge.pdflion.storedToolSettings, [{ eraser: { mode: "object", size: 30 } }]);
  });

  it("turns on in pdf.js's ink mode, shown as Pencil's, and off with its button", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const { button, box } = eraserOf(bridge);
    button.listeners.click();
    assert.equal(mode(bridge), 15);
    assert.ok(isErasing(bridge));
    assert.ok(button.classes.has("toggled"));
    assert.equal(button.attributes["aria-expanded"], "true");
    assert.ok(!box.classes.has("hidden"));
    assert.equal(bridge.pencilButton.attributes["aria-expanded"], "false");

    button.listeners.click();
    assert.equal(mode(bridge), 0);
    assert.ok(!isErasing(bridge));
    assert.ok(!button.classes.has("toggled"));
    assert.equal(button.attributes["aria-expanded"], "false");
    assert.ok(box.classes.has("hidden"));
  });

  it("turns on and off with Edit > Eraser, while its button works", async () => {
    const bridge = loadBridge();
    await bridge.load();
    assert.equal(bridge.run("eraser"), false);
    assert.ok(!isErasing(bridge), "not before pdf.js's tools work");

    bridge.app.eventBus.dispatch("annotationeditormodechanged", { mode: 0 });
    assert.equal(bridge.run("eraser"), true);
    assert.ok(isErasing(bridge));
    assert.equal(mode(bridge), 15);
    assert.ok(eraserOf(bridge).button.classes.has("toggled"));

    assert.equal(bridge.run("eraser"), false);
    assert.ok(!isErasing(bridge));
    assert.equal(mode(bridge), 0);
  });

  it("makes Pencil's strokes a drawing first, when Pencil is on", async () => {
    const bridge = loadBridge();
    await bridge.load();
    switchTool(bridge, 15);
    eraserOf(bridge).button.listeners.click();
    assert.ok(isErasing(bridge));
    // Once to commit Pencil's drawing session, once to unselect the drawing.
    assert.equal(named(bridge.calls, "ui.unselectAll").length, 2);
    assert.equal(mode(bridge), 15);
  });

  it("stops for another tool, and for Pencil, whose ink mode stays", async () => {
    const bridge = loadBridge();
    await bridge.load();
    const { button } = eraserOf(bridge);
    button.listeners.click();
    switchTool(bridge, 3);
    assert.ok(!isErasing(bridge));
    assert.equal(mode(bridge), 3);

    button.listeners.click();
    assert.equal(mode(bridge), 15);
    // pdf.js would turn Pencil off, since ink mode shows it on.
    const click = bridge.fire("click", { target: element("#editorInkButton") });
    assert.ok(click.stopped);
    assert.ok(!isErasing(bridge));
    assert.equal(mode(bridge), 15);
    assert.equal(bridge.pencilButton.attributes["aria-expanded"], "true");
    // Pencil works as pdf.js has it when the eraser is off.
    assert.ok(!bridge.fire("click", { target: element("#editorInkButton") }).stopped);
  });

  it("stops with Esc, unless pdf.js or the page overview used it", async () => {
    const bridge = loadBridge();
    await bridge.load();
    eraserOf(bridge).button.listeners.click();
    bridge.fire("keydown", { key: "Escape", defaultPrevented: true });
    assert.ok(isErasing(bridge));
    bridge.fire("keydown", { key: "Escape" });
    assert.ok(!isErasing(bridge));
    assert.equal(mode(bridge), 0);
  });

  /** Lets the eraser's queued work, frames and pdf.js's editors settle. */
  const settleAll = async () => {
    for (let turn = 0; turn < 10; turn++) await settle();
  };

  /**
   * Turns the eraser on over a first page at the window's top left, 792
   * points tall at 100 %, with stand-ins for pdf.js's editors on it. Like
   * pdf.js's, its layer makes adding a new drawing a step to undo.
   *
   * @param {ReturnType<typeof loadBridge>} bridge
   * @param {{ id: string, editorType: string, strokes: number[][] }[]} drawings
   * @param {{ mode: string, size: number }} [eraser]
   */
  async function erasing(bridge, drawings, eraser = { mode: "object", size: 10 }) {
    await bridge.load();
    const { app, uiManager, viewerContainer, calls } = bridge;
    const pageDiv = {
      dataset: { pageNumber: "1" },
      clientLeft: 0,
      clientTop: 0,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      /** @param {string} selector */
      closest: (selector) => (selector === "#viewerContainer .page[data-page-number]" ? pageDiv : null),
    };
    app.pdfViewer.pageDiv = pageDiv;
    app.pdfViewer.viewport = {
      scale: 1,
      convertToPdfPoint: (/** @type {number} */ x, /** @type {number} */ y) => [x, 792 - y],
    };
    /** @type {any[]} the editors on the page */
    const editors = [];
    /**
     * @param {string} id
     * @param {string} editorType
     * @param {any} data what serialize(true) gives
     */
    const editor = (id, editorType, data) => ({
      id,
      editorType,
      pageIndex: 0,
      added: true,
      data,
      serialize: (/** @type {boolean} */ isForCopying) =>
        isForCopying && editorType !== "highlight" ? data : null,
      remove() {
        calls.push(["remove", id]);
        editors.splice(editors.indexOf(this), 1);
      },
    });
    for (const { id, editorType, strokes } of drawings) {
      editors.push(
        editor(id, editorType, {
          paths: { points: strokes },
          color: [255, 0, 0],
          thickness: 2,
          opacity: 0.5,
          rotation: 0,
          rect: [1, 2, 3, 4],
        }),
      );
    }
    uiManager.getEditors = function* () {
      yield* [...editors];
    };
    /** @type {any[]} */
    const commands = [];
    uiManager.addCommands = (/** @type {any} */ command) => commands.push(command);
    let built = 0;
    class Layer {
      /** @param {any} data */
      async deserialize(data) {
        calls.push(["deserialize", data]);
        const points = data.paths.points.map((/** @type {Float32Array} */ p) => [...p]);
        // New, unlike the drawings already on the page.
        return Object.assign(editor(`built ${++built}`, "ink", { ...data, paths: { points } }), {
          added: false,
        });
      }
      /** @param {any} added */
      addOrRebuild(added) {
        calls.push(["addOrRebuild", added.id]);
        editors.push(added);
        if (!added.added) this.addUndoableEditor(added);
        added.added = true;
      }
      /** @param {any} added */
      addUndoableEditor(added) {
        commands.push({ added: added.id });
      }
    }
    const layer = new Layer();
    uiManager.getLayer = () => layer;

    app.eventBus.dispatch("annotationeditormodechanged", { mode: 0 });
    bridge.pdflion.toolSettingsListener?.({ eraser, favourites: [] });
    eraserOf(bridge).button.listeners.click();
    /** @type {any} */
    let down;
    return {
      editors,
      commands,
      /**
       * Drags pointer 7 along points in the window, which at 100 % are PDF
       * points from the top. The drag stays down unless `up`.
       *
       * @param {number[][]} points
       * @param {boolean} [up]
       */
      async drag(points, up = true) {
        const [[clientX, clientY], ...moves] = points;
        if (!down) {
          down = { target: pageDiv, button: 0, pointerId: 7, clientX, clientY, stopped: false, prevented: false };
          Object.assign(down, {
            stopPropagation: () => (down.stopped = true),
            preventDefault: () => (down.prevented = true),
          });
          viewerContainer.listeners.pointerdown(down);
        } else {
          moves.unshift([clientX, clientY]);
        }
        for (const [x, y] of moves) {
          assert.ok(bridge.fire("pointermove", { target: pageDiv, pointerId: 7, clientX: x, clientY: y }).stopped);
          await settleAll();
        }
        if (up) {
          bridge.fire("pointerup", { target: pageDiv, pointerId: 7 });
          await settleAll();
          down = undefined;
        }
        return down;
      },
      /** @returns {string[]} the ids of the editors on the page */
      ids: () => editors.map((shown) => shown.id),
    };
  }

  /** @param {any[]} calls @returns {any[]} the data each editor was built from */
  const built = (calls) => named(calls, "deserialize").map(([, data]) => data);

  it("erases the drawings it touches, whole, only Pencil's, as one step to undo", async () => {
    const bridge = loadBridge();
    const page = await erasing(bridge, [
      { id: "crossed", editorType: "ink", strokes: [[100, 700, 300, 700]] },
      { id: "missed", editorType: "ink", strokes: [[100, 500, 300, 500]] },
      { id: "signature", editorType: "signature", strokes: [[100, 700, 300, 700]] },
      { id: "highlight", editorType: "highlight", strokes: [[100, 700, 300, 700]] },
    ]);
    // Down from above the strokes at y 700, then on across them.
    const down = await page.drag([[200, 50], [200, 150]], false);
    assert.ok(down.stopped && down.prevented, "pdf.js gets no press to draw with");
    assert.deepEqual(page.ids(), ["missed", "signature", "highlight"]);
    assert.deepEqual(page.commands, [], "not before the drag ends");
    // Another pointer's events are left alone.
    assert.ok(!bridge.fire("pointerup", { target: down.target, pointerId: 8 }).stopped);
    await page.drag([[200, 150]]);

    assert.equal(page.commands.length, 1);
    const [{ cmd, undo, mustExec }] = page.commands;
    assert.equal(mustExec, false);
    undo();
    assert.deepEqual(page.ids(), ["missed", "signature", "highlight", "crossed"]);
    cmd();
    assert.deepEqual(page.ids(), ["missed", "signature", "highlight"]);
    assert.deepEqual(built(bridge.calls), []);
    // The drag is over.
    bridge.fire("pointermove", { target: down.target, pointerId: 7, clientX: 200, clientY: 300 });
    await settleAll();
    assert.deepEqual(page.ids(), ["missed", "signature", "highlight"]);

    // A drag that erases nothing is no step to undo.
    await page.drag([[200, 400], [200, 450]]);
    assert.equal(page.commands.length, 1);
  });

  it("cuts strokes in Line mode, and shows what's left, as one step to undo", async () => {
    const bridge = loadBridge();
    const page = await erasing(
      bridge,
      [{ id: "long", editorType: "ink", strokes: [[100, 700, 300, 700], [100, 500, 300, 500]] }],
      { mode: "line", size: 20 },
    );
    // Across the first stroke at x 200, which the eraser's path, a point
    // every 5, passes 2 points off at the closest. It reaches its radius, 10,
    // and half the stroke's thickness, 1, from there.
    await page.drag([[200, 50], [200, 150]], false);
    const [first] = built(bridge.calls);
    const across = Math.sqrt(11 ** 2 - 2 ** 2);
    const round = (/** @type {number} */ value) => Math.round(value * 100) / 100;
    assert.deepEqual(
      first.paths.points.map((/** @type {Float32Array} */ points) => [...points].map(round)),
      [
        [100, 700, round(200 - across), 700],
        [round(200 + across), 700, 300, 700],
        [100, 500, 300, 500],
      ],
    );
    assert.ok(first.paths.points.every((/** @type {any} */ points) => points.constructor.name === "Float32Array"));
    assert.deepEqual(
      { ...first, paths: undefined },
      { annotationType: 15, color: [255, 0, 0], thickness: 2, opacity: 0.5, paths: undefined, rect: [1, 2, 3, 4], rotation: 0 },
    );
    assert.deepEqual(page.ids(), ["built 1"]);

    // On to the right, across the first stroke again, in a later frame.
    await page.drag([[260, 150], [260, 50]]);
    assert.equal(built(bridge.calls).length, 2);
    assert.equal(built(bridge.calls)[1].paths.points.length, 4);
    assert.deepEqual(page.ids(), ["built 2"]);
    // pdf.js would make each new drawing a step to undo.
    assert.equal(page.commands.length, 1);
    const [{ cmd, undo }] = page.commands;
    undo();
    assert.deepEqual(page.ids(), ["long"]);
    cmd();
    assert.deepEqual(page.ids(), ["built 2"]);
  });

  it("removes a drawing in Line mode once nothing is left of it", async () => {
    const bridge = loadBridge();
    const page = await erasing(bridge, [{ id: "short", editorType: "ink", strokes: [[195, 700, 205, 700]] }], {
      mode: "line",
      size: 30,
    });
    await page.drag([[200, 50], [200, 150]]);
    assert.deepEqual(built(bridge.calls), []);
    assert.deepEqual(page.ids(), []);
    page.commands[0].undo();
    assert.deepEqual(page.ids(), ["short"]);
  });

  it("goes nowhere without a document to edit", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.app.pdfViewer._layerProperties.annotationEditorUIManager = null;
    eraserOf(bridge).button.listeners.click();
    assert.ok(!isErasing(bridge));
    assert.equal(mode(bridge), 0);
  });
});

describe("bridge.js Save as Favourite", () => {
  /**
   * @param {ReturnType<typeof loadBridge>} bridge
   * @param {"Highlight" | "FreeText" | "Ink"} name the tool's, in its option box's id
   */
  const buttonOf = (bridge, name) => bridge.optionBoxes[name].children.at(-1);

  /**
   * Clicks a tool's Save as Favourite.
   *
   * @param {ReturnType<typeof loadBridge>} bridge
   * @param {"Highlight" | "FreeText" | "Ink"} name
   * @returns {Promise<string>} what the button says then
   */
  const save = async (bridge, name) => {
    const button = buttonOf(bridge, name);
    button.listeners.click();
    await settle();
    return button.children[0].textContent;
  };

  const pencil = { tool: "ink", color: "#1e66f5", thickness: 5, opacity: 0.35 };

  it("goes at the end of the option boxes of Highlight, Text and Pencil, outlined", async () => {
    const bridge = loadBridge();
    await bridge.load();
    for (const name of /** @type {const} */ (["Highlight", "FreeText", "Ink"])) {
      const button = buttonOf(bridge, name);
      assert.equal(button.id, `pdflionSave${name}Favourite`);
      assert.equal(button.type, "button");
      assert.equal(button.className, "secondaryButton pdflionSaveFavourite");
      const [label] = button.children;
      assert.equal(label.textContent, "Save as Favourite");
      assert.equal(label.ariaLive, "polite", "says what a click did");
    }
  });

  it("adds each tool's settings, as its option box shows them, to main's favourites", async () => {
    const bridge = loadBridge();
    const kept = { tool: "freetext", color: "#000000", size: 30 };
    bridge.pdflion.toolSettings = { eraser: { mode: "object", size: 10 }, favourites: [kept] };
    await bridge.load();
    Object.assign(bridge.params, {
      editorInkColor: { value: "#1e66f5" },
      editorInkThickness: { valueAsNumber: 5 },
      editorInkOpacity: { valueAsNumber: 0.35 },
      editorFreeTextColor: { value: "#e64553" },
      editorFreeTextFontSize: { valueAsNumber: 24 },
      editorFreeHighlightThickness: { valueAsNumber: 16 },
    });
    bridge.document.highlightColor = "#53FFBC";

    assert.equal(await save(bridge, "Ink"), "Saved");
    const text = { tool: "freetext", color: "#e64553", size: 24 };
    assert.equal(await save(bridge, "FreeText"), "Saved");
    // pdf.js's swatches have upper-case colours.
    const highlight = { tool: "highlight", color: "#53ffbc", thickness: 16 };
    assert.equal(await save(bridge, "Highlight"), "Saved");
    assert.deepEqual(bridge.pdflion.storedToolSettings, [
      { favourites: [kept, pencil] },
      { favourites: [kept, pencil, text] },
      { favourites: [kept, pencil, text, highlight] },
    ]);

    // Main sends every tab the favourites after each change, from any tab.
    bridge.pdflion.toolSettingsListener?.({ eraser: { mode: "object", size: 10 }, favourites: [] });
    assert.equal(await save(bridge, "Ink"), "Saved");
    assert.deepEqual(bridge.pdflion.storedToolSettings.at(-1), { favourites: [pencil] });
  });

  it("adds nothing that's a favourite already, and says so", async () => {
    const bridge = loadBridge();
    const highlight = { tool: "highlight", color: "#ffff98", thickness: 12 };
    bridge.pdflion.toolSettings = {
      eraser: { mode: "object", size: 10 },
      favourites: [highlight, { ...pencil, opacity: 1 }],
    };
    await bridge.load();
    assert.equal(await save(bridge, "Highlight"), "Already a Favourite");
    Object.assign(bridge.params, {
      editorInkColor: { value: "#1e66f5" },
      editorInkThickness: { valueAsNumber: 5 },
      editorInkOpacity: { valueAsNumber: 0.35 },
    });
    assert.equal(await save(bridge, "Ink"), "Saved", "another opacity");
    assert.equal(await save(bridge, "Ink"), "Already a Favourite", "before main sends it back");
    assert.equal(bridge.pdflion.storedToolSettings.length, 1);
  });

  it("asks for a colour while Highlight shows none chosen", async () => {
    const bridge = loadBridge();
    await bridge.load();
    // As for a selected highlight from the file, in a colour of its own.
    bridge.document.highlightColor = null;
    assert.equal(await save(bridge, "Highlight"), "Choose a Colour First");
    assert.deepEqual(bridge.pdflion.storedToolSettings, []);
  });

  it("reads Pencil's opacity from its colour where pdf.js shows it there", async () => {
    const bridge = loadBridge();
    await bridge.load();
    // pdf.js removes the slider where the colour input takes an alpha channel.
    delete bridge.params.editorInkOpacity;
    const opacities = [];
    for (const value of ["#1E66F580", "#1e66f5", "#1e66f500", "#1e66f5f3"]) {
      bridge.params.editorInkColor = { value };
      await save(bridge, "Ink");
      const { color, opacity } = bridge.pdflion.storedToolSettings.at(-1).favourites.at(-1);
      assert.equal(color, "#1e66f5");
      opacities.push(opacity);
    }
    // In the slider's steps, from its least.
    assert.deepEqual(opacities, [0.5, 1, 0.05, 0.95]);

    bridge.params.editorInkColor = { value: "rgb(30, 102, 245)" };
    assert.equal(await save(bridge, "Ink"), "Choose a Colour First");
  });

  it("says what it did for two seconds, then its label again", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const bridge = loadBridge();
    await bridge.load();
    assert.equal(await save(bridge, "Ink"), "Saved");
    t.mock.timers.tick(1500);
    assert.equal(await save(bridge, "Ink"), "Already a Favourite");
    t.mock.timers.tick(1999);
    assert.equal(buttonOf(bridge, "Ink").children[0].textContent, "Already a Favourite");
    t.mock.timers.tick(1);
    assert.equal(buttonOf(bridge, "Ink").children[0].textContent, "Save as Favourite");
  });

  it("waits for main's favourites, and adds none without them", async () => {
    const bridge = loadBridge();
    const kept = { tool: "freetext", color: "#000000", size: 30 };
    /** @type {(settings: object | null) => void} */
    let answer = () => {};
    bridge.pdflion.getToolSettings = () => new Promise((resolve) => (answer = resolve));
    await bridge.load();
    const button = buttonOf(bridge, "Ink");
    button.listeners.click();
    await settle();
    assert.deepEqual(bridge.pdflion.storedToolSettings, []);
    assert.equal(button.children[0].textContent, "Save as Favourite");
    answer({ eraser: { mode: "object", size: 10 }, favourites: [kept] });
    await settle();
    assert.equal(button.children[0].textContent, "Saved");
    assert.deepEqual(bridge.pdflion.storedToolSettings, [
      { favourites: [kept, { tool: "ink", color: "#000000", thickness: 1, opacity: 1 }] },
    ]);

    const refused = loadBridge();
    refused.pdflion.getToolSettings = async () => null;
    await refused.load();
    assert.equal(await save(refused, "Ink"), "Couldn't Save");
    assert.deepEqual(refused.pdflion.storedToolSettings, []);
  });

  it("goes nowhere without pdf.js's option boxes", async () => {
    const bridge = loadBridge({ toolbar: false });
    await bridge.load();
    for (const box of Object.values(bridge.optionBoxes)) assert.deepEqual(box.children, []);
  });
});

describe("bridge.js favourites in the toolbar", () => {
  const pencil = { tool: "ink", color: "#1e66f5", thickness: 5, opacity: 0.35 };
  const text = { tool: "freetext", color: "#e64553", size: 24 };
  const highlight = { tool: "highlight", color: "#ffff98", thickness: 12 };

  /** @param {unknown} value @returns {any} a copy from this realm, to compare */
  const plain = (value) => JSON.parse(JSON.stringify(value));

  /**
   * Loads the bridge with these favourites from main, where pdf.js's drawing
   * tools work, with none on.
   *
   * @param {object[]} favourites
   */
  const withFavourites = async (favourites) => {
    const bridge = loadBridge();
    bridge.pdflion.toolSettings = { eraser: { mode: "object", size: 10 }, favourites };
    await bridge.load();
    bridge.app.eventBus.dispatch("annotationeditormodechanged", { mode: 0 });
    await settle();
    return bridge;
  };

  /** @param {ReturnType<typeof loadBridge>} bridge */
  const barOf = (bridge) => {
    const group = bridge.toolbar.find((element) => element.id === "pdflionFavourites");
    const separator = bridge.toolbar.find((element) => element.id === "pdflionFavouritesSeparator");
    const more = group.children.at(-1);
    const [moreButton, menu] = more.children;
    return {
      group,
      separator,
      buttons: group.children.slice(0, -1),
      moreButton,
      items: menu.children[0].children,
    };
  };

  /**
   * @param {any} button
   * @returns {{ pressed: string, toggled: boolean }}
   */
  const pressed = (button) => ({
    pressed: button.attributes["aria-pressed"],
    toggled: button.classes.has("toggled"),
  });

  it("go before pdf.js's drawing tools, with a divider, once there are any", async () => {
    const bridge = await withFavourites([]);
    const { group, separator } = barOf(bridge);
    const at = (/** @type {any} */ element) => bridge.toolbar.indexOf(element);
    assert.deepEqual([at(group) + 1, at(separator) + 1], [at(separator), at(bridge.editorModeButtons)]);
    assert.equal(separator.className, "verticalToolbarSeparator");
    assert.deepEqual([group.hidden, separator.hidden], [true, true]);

    bridge.pdflion.toolSettingsListener?.({ eraser: { mode: "object", size: 10 }, favourites: [pencil] });
    assert.deepEqual([group.hidden, separator.hidden], [false, false]);
    bridge.pdflion.toolSettingsListener?.({ eraser: { mode: "object", size: 10 }, favourites: [] });
    assert.deepEqual([group.hidden, separator.hidden], [true, true]);
  });

  it("show each favourite's tool, colour and size, and describe it", async () => {
    const bridge = await withFavourites([pencil, text, highlight]);
    const { buttons, items, moreButton } = barOf(bridge);
    assert.deepEqual(
      buttons.map((/** @type {any} */ button) => [
        button.title,
        button.attributes["data-tool"],
        button.attributes["data-size"],
        button.style["--pdflion-favourite-color"],
      ]),
      [
        ["Pencil, #1E66F5, 5 pt, 35 %", "ink", "5", "#1e66f5"],
        ["Text, #E64553, 24 pt", "freetext", "24", "#e64553"],
        ["Highlight, #FFFF98, 12 pt", "highlight", "12", "#ffff98"],
      ],
    );
    const [icon, label] = buttons[0].children;
    assert.equal(icon.className, "pdflionFavouriteIcon");
    assert.equal(label.textContent, "Pencil, #1E66F5, 5 pt, 35 %");
    assert.equal(buttons[0].className, "toolbarButton pdflionFavourite");

    // The ★ menu has an item for each, which shows when its button doesn't.
    assert.equal(moreButton.title, "More Favourites");
    assert.equal(moreButton.attributes["aria-controls"], "pdflionFavouritesMenu");
    assert.deepEqual(
      items.map((/** @type {any} */ item) => [
        item.className,
        item.attributes.role,
        item.tabIndex,
        item.children[1].textContent,
        item.title,
      ]),
      [
        ["toolbarButton labeled pdflionFavourite", "menuitemradio", -1, "Pencil, #1E66F5, 5 pt, 35 %", undefined],
        ["toolbarButton labeled pdflionFavourite", "menuitemradio", -1, "Text, #E64553, 24 pt", undefined],
        ["toolbarButton labeled pdflionFavourite", "menuitemradio", -1, "Highlight, #FFFF98, 12 pt", undefined],
      ],
    );
  });

  it("turn a favourite's tool on with its settings, once the selection is clear", async () => {
    const bridge = await withFavourites([pencil, text]);
    const { dispatched } = bridge.app.eventBus;
    bridge.uiManager.unselectAll = () => dispatched.push(["unselectAll", {}]);
    const [pencilButton, textButton] = barOf(bridge).buttons;

    let from = dispatched.length;
    pencilButton.listeners.click();
    assert.deepEqual(
      plain(dispatched.slice(from)).filter(([name]) => name !== "annotationeditormodechanged"),
      [
        // Pencil's open drawing becomes a drawing, then the selection clears.
        ["unselectAll", {}],
        ["unselectAll", {}],
        ["switchannotationeditormode", { source: null, mode: 15 }],
        ["switchannotationeditorparams", { source: null, type: 21, value: "#1e66f5" }],
        ["switchannotationeditorparams", { source: null, type: 22, value: 5 }],
        ["switchannotationeditorparams", { source: null, type: 23, value: 0.35 }],
        // pdf.js's option box shows them.
        [
          "annotationeditorparamschanged",
          { source: null, details: [[21, "#1e66f5"], [22, 5], [23, 0.35]] },
        ],
      ],
    );

    // With its tool on, only the settings change.
    from = dispatched.length;
    pencilButton.listeners.click();
    assert.ok(!dispatched.slice(from).some(([name]) => name === "switchannotationeditormode"));

    from = dispatched.length;
    textButton.listeners.click();
    assert.deepEqual(
      plain(dispatched.slice(from)).filter(([name]) => name.startsWith("switch")),
      [
        ["switchannotationeditormode", { source: null, mode: 3 }],
        ["switchannotationeditorparams", { source: null, type: 12, value: "#e64553" }],
        ["switchannotationeditorparams", { source: null, type: 11, value: 24 }],
      ],
    );
  });

  it("stop the eraser for a Pencil favourite, whose ink mode stays", async () => {
    const bridge = await withFavourites([pencil]);
    const eraser = bridge.toolbar.find((element) => element.id === "pdflionEditorEraser");
    eraser.children[0].listeners.click();
    assert.ok(bridge.outerContainer.classes.has("pdflionErasing"));
    const from = bridge.app.eventBus.dispatched.length;
    barOf(bridge).buttons[0].listeners.click();
    assert.ok(!bridge.outerContainer.classes.has("pdflionErasing"));
    assert.ok(bridge.pencilButton.classes.has("toggled"), "Pencil shows on");
    assert.equal(bridge.pencilButton.attributes["aria-expanded"], "false", "with its box closed");
    assert.ok(bridge.toolBoxes.Ink.classes.has("hidden"));
    const switches = bridge.app.eventBus.dispatched
      .slice(from)
      .filter(([name]) => name === "switchannotationeditormode");
    assert.deepEqual(switches, []);
  });

  it("keep the tool's option box closed, unlike pdf.js's own tool buttons", async () => {
    const bridge = await withFavourites([pencil, text]);
    const { toolButtons, toolBoxes } = bridge;
    const [pencilButton, textButton] = barOf(bridge).buttons;
    /** @param {"Ink" | "FreeText"} name */
    const shown = (name) => ({
      on: toolButtons[name].classes.has("toggled"),
      expanded: toolButtons[name].attributes["aria-expanded"],
      open: !toolBoxes[name].classes.has("hidden"),
    });

    pencilButton.listeners.click();
    assert.deepEqual(shown("Ink"), { on: true, expanded: "false", open: false });
    // Opened by hand, then the same tool's favourite again.
    toolBoxes.Ink.classList.toggle("hidden", false);
    pencilButton.listeners.click();
    assert.deepEqual(shown("Ink"), { on: true, expanded: "false", open: false });

    textButton.listeners.click();
    assert.deepEqual(shown("FreeText"), { on: true, expanded: "false", open: false });
    assert.deepEqual(shown("Ink"), { on: false, expanded: "false", open: false });

    // pdf.js's own tool buttons still open it, also the last favourite's tool.
    bridge.app.eventBus.dispatch("switchannotationeditormode", { mode: 15 });
    assert.deepEqual(shown("Ink"), { on: true, expanded: "true", open: true });
    bridge.app.eventBus.dispatch("switchannotationeditormode", { mode: 3 });
    assert.deepEqual(shown("FreeText"), { on: true, expanded: "true", open: true });
  });

  /**
   * Drags one favourite's button onto another's, and drops it there.
   *
   * @param {any} from
   * @param {any} to
   * @param {object} [options]
   * @param {boolean} [options.after] onto the far half of `to`, rather than the near one
   * @param {"x" | "y"} [options.axis] across, or down
   * @returns {{ marked: string[], dropped: boolean }} how `to` showed the
   *   drop, and whether it took it
   */
  const drag = (from, to, { after = false, axis = "x" } = {}) => {
    /** @type {string[]} */
    const types = [];
    const dataTransfer = {
      types,
      effectAllowed: "",
      dropEffect: "",
      setData: (/** @type {string} */ type) => types.push(type),
    };
    from.listeners.dragstart({ dataTransfer });
    to.getBoundingClientRect = () => ({ left: 100, top: 100, width: 40, height: 40 });
    const near = 110;
    const far = 130;
    let dropped = false;
    const event = {
      dataTransfer,
      clientX: axis === "x" && after ? far : near,
      clientY: axis === "y" && after ? far : near,
      preventDefault: () => (dropped = true),
    };
    to.listeners.dragover(event);
    const marked = [...to.classes].filter((name) => name.startsWith("pdflionDrop"));
    to.listeners.drop(event);
    from.listeners.dragend?.();
    return { marked, dropped };
  };

  it("move when dragged onto another, before or after it, for every tab", async () => {
    const bridge = await withFavourites([pencil, text, highlight]);
    const stored = () => bridge.pdflion.storedToolSettings.at(-1)?.favourites;
    const [first, , third] = barOf(bridge).buttons;
    assert.ok(first.draggable);

    assert.deepEqual(drag(first, third, { after: true }), { marked: ["pdflionDropAfter"], dropped: true });
    assert.deepEqual(stored(), [text, highlight, pencil]);
    assert.ok(!third.classes.has("pdflionDropAfter"), "no mark once dropped");
    assert.deepEqual(
      barOf(bridge).buttons.map((/** @type {any} */ button) => button.title),
      ["Text, #E64553, 24 pt", "Highlight, #FFFF98, 12 pt", "Pencil, #1E66F5, 5 pt, 35 %"],
    );

    const [textButton, , pencilButton] = barOf(bridge).buttons;
    assert.deepEqual(drag(pencilButton, textButton), { marked: ["pdflionDropBefore"], dropped: true });
    assert.deepEqual(stored(), [pencil, text, highlight]);

    // Down the ★ menu.
    const [pencilItem, textItem] = barOf(bridge).items;
    drag(pencilItem, textItem, { after: true, axis: "y" });
    assert.deepEqual(stored(), [text, pencil, highlight]);
  });

  it("move the other way across a toolbar laid out right to left", async () => {
    const bridge = await withFavourites([pencil, text]);
    bridge.document.documentElement.dir = "rtl";
    const [first, second] = barOf(bridge).buttons;
    // The near half, on the left, is after it there.
    assert.deepEqual(drag(first, second).marked, ["pdflionDropAfter"]);
    assert.deepEqual(bridge.pdflion.storedToolSettings.at(-1)?.favourites, [text, pencil]);
  });

  it("stay as they are when dropped onto themselves, and leave other drags alone", async () => {
    const bridge = await withFavourites([pencil, text]);
    const [first, second] = barOf(bridge).buttons;
    drag(first, first, { after: true });
    assert.deepEqual(bridge.pdflion.storedToolSettings, []);

    // A file dragged over them, also after a favourite's drag whose end
    // never came, as when its button went.
    first.listeners.dragstart({ dataTransfer: { types: [], setData() {} } });
    let taken = false;
    second.listeners.dragover({
      dataTransfer: { types: ["Files"] },
      clientX: 110,
      clientY: 110,
      preventDefault: () => (taken = true),
    });
    assert.equal(taken, false);
  });

  it("show as pressed while their tool is on with their settings, as its option box shows them", async () => {
    const bridge = await withFavourites([pencil, highlight]);
    const { eventBus } = bridge.app;
    const [pencilButton, highlightButton] = barOf(bridge).buttons;
    const [pencilItem] = barOf(bridge).items;
    assert.deepEqual(pressed(pencilButton), { pressed: "false", toggled: false });

    Object.assign(bridge.params, {
      editorInkColor: { value: "#1e66f5" },
      editorInkThickness: { valueAsNumber: 5 },
      editorInkOpacity: { valueAsNumber: 0.35 },
    });
    eventBus.dispatch("switchannotationeditormode", { mode: 15 });
    await settle();
    assert.deepEqual(pressed(pencilButton), { pressed: "true", toggled: true });
    assert.equal(pencilItem.attributes["aria-checked"], "true");
    assert.ok(pencilItem.classes.has("toggled"));
    assert.deepEqual(pressed(highlightButton), { pressed: "false", toggled: false });

    // The user moves a slider, which pdf.js passes on.
    bridge.params.editorInkThickness = { valueAsNumber: 6 };
    eventBus.dispatch("switchannotationeditorparams", { type: 22, value: 6 });
    await settle();
    assert.deepEqual(pressed(pencilButton), { pressed: "false", toggled: false });
    // A selected drawing's settings, which pdf.js shows.
    bridge.params.editorInkThickness = { valueAsNumber: 5 };
    eventBus.dispatch("annotationeditorparamschanged", { details: [[22, 5]] });
    await settle();
    assert.deepEqual(pressed(pencilButton), { pressed: "true", toggled: true });

    // Not while the eraser is on, in Pencil's ink mode.
    bridge.toolbar.find((element) => element.id === "pdflionEditorEraser").children[0].listeners.click();
    await settle();
    assert.deepEqual(pressed(pencilButton), { pressed: "false", toggled: false });

    eventBus.dispatch("switchannotationeditormode", { mode: 9 });
    await settle();
    assert.deepEqual(pressed(highlightButton), { pressed: "true", toggled: true });
    // pdf.js's colour picker marks the swatch it dispatched only afterwards.
    eventBus.dispatch("switchannotationeditorparams", { type: 31, value: "#53FFBC" });
    bridge.document.highlightColor = "#53FFBC";
    await settle();
    assert.deepEqual(pressed(highlightButton), { pressed: "false", toggled: false });
  });

  it("work only while pdf.js's drawing tools do", async () => {
    const bridge = loadBridge();
    bridge.pdflion.toolSettings = { eraser: { mode: "object", size: 10 }, favourites: [pencil] };
    await bridge.load();
    const { buttons, items, moreButton } = barOf(bridge);
    const disabled = () => [buttons[0].disabled, items[0].disabled, moreButton.disabled];
    assert.deepEqual(disabled(), [true, true, true]);
    bridge.app.eventBus.dispatch("annotationeditormodechanged", { mode: 0 });
    assert.deepEqual(disabled(), [false, false, false]);
    bridge.app.eventBus.dispatch("annotationeditormodechanged", { mode: -1 });
    assert.deepEqual(disabled(), [true, true, true]);

    // Favourites that come later too.
    bridge.pdflion.toolSettingsListener?.({ eraser: { mode: "object", size: 10 }, favourites: [text] });
    assert.equal(barOf(bridge).buttons[0].disabled, true);
  });

  it("open a favourite's context menu, which removes it", async () => {
    const bridge = await withFavourites([pencil, text]);
    const { buttons, items } = barOf(bridge);
    for (const button of [buttons[1], items[0]]) {
      let prevented = false;
      button.listeners.contextmenu({ preventDefault: () => (prevented = true) });
      assert.ok(prevented, "Chromium shows no menu of its own");
    }
    assert.deepEqual(bridge.pdflion.favouriteMenus, [text, pencil]);
  });

  it("follow the favourites main sends every tab", async () => {
    const bridge = await withFavourites([pencil]);
    bridge.pdflion.toolSettingsListener?.({
      eraser: { mode: "object", size: 10 },
      favourites: [text, pencil, highlight],
    });
    const { buttons, items } = barOf(bridge);
    assert.deepEqual(
      [...buttons, ...items].map((/** @type {any} */ button) => button.children[1].textContent),
      [
        "Text, #E64553, 24 pt",
        "Pencil, #1E66F5, 5 pt, 35 %",
        "Highlight, #FFFF98, 12 pt",
        "Text, #E64553, 24 pt",
        "Pencil, #1E66F5, 5 pt, 35 %",
        "Highlight, #FFFF98, 12 pt",
      ],
    );
    // Without a toolbar to measure, all show there.
    assert.deepEqual(
      [...buttons, ...items].map((/** @type {any} */ button) => button.hidden),
      [false, false, false, true, true, true],
    );
  });

  it("go nowhere without pdf.js's toolbar", async () => {
    const bridge = loadBridge({ toolbar: false });
    bridge.pdflion.toolSettings = { eraser: { mode: "object", size: 10 }, favourites: [pencil] };
    await bridge.load();
    assert.ok(!bridge.toolbar.some((element) => element.id === "pdflionFavourites"));
  });
});

describe("bridge.js Undo and Redo", () => {
  /**
   * @param {ReturnType<typeof loadBridge>} bridge
   * @returns {string[]} the editing actions dispatched to pdf.js
   */
  const actions = (bridge) =>
    bridge.app.eventBus.dispatched
      .filter(([name]) => name === "editingaction")
      .map(([, data]) => data.name);

  it("leave them to Chromium without a drawing tool", async () => {
    const bridge = loadBridge();
    await bridge.load();
    assert.equal(bridge.run("undo"), false);
    assert.equal(bridge.run("redo"), false);
    assert.deepEqual(actions(bridge), []);
  });

  it("send them to pdf.js while a drawing tool is on", async () => {
    const bridge = loadBridge();
    await bridge.load();
    bridge.app.eventBus.dispatch("switchannotationeditormode", { mode: 15 });
    assert.equal(bridge.run("undo"), true);
    assert.equal(bridge.run("redo"), true);
    // A checkbox has the focus, but no text is being typed.
    bridge.page.document.activeElement = { tagName: "INPUT", type: "checkbox" };
    assert.equal(bridge.run("undo"), true);
    assert.deepEqual(actions(bridge), ["undo", "redo", "undo"]);
  });

  for (const [description, typing] of [
    ["in a text field", { activeElement: { tagName: "INPUT", type: "text" } }],
    ["in a number field", { activeElement: { tagName: "INPUT", type: "number" } }],
    ["in a text area", { activeElement: { tagName: "TEXTAREA" } }],
    ["in editable content", { activeElement: { isContentEditable: true } }],
    ["in a Text box of pdf.js's", { isEditorHandlingKeyboard: true }],
  ]) {
    it(`leave typing ${description} to Chromium`, async () => {
      const bridge = loadBridge();
      await bridge.load();
      bridge.app.eventBus.dispatch("switchannotationeditormode", { mode: 3 });
      if ("activeElement" in typing) bridge.page.document.activeElement = typing.activeElement;
      if ("isEditorHandlingKeyboard" in typing) bridge.uiManager.isEditorHandlingKeyboard = true;
      assert.equal(bridge.run("undo"), false);
      assert.deepEqual(actions(bridge), []);
    });
  }
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

describe("bridge.js page tools of a locked document", () => {
  /** @param {object} [options] for openDocument() */
  async function withLocked(options = { info: { EncryptFilterName: "Standard" }, numPages: 2 }) {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument(options);
    await settle();
    return bridge;
  }

  for (const [description, options] of [
    ["with a password", { info: { EncryptFilterName: "Standard" } }],
    ["that are pure XFA forms", { isPureXfa: true }],
  ]) {
    it(`are hidden for documents ${description}`, async () => {
      const bridge = await withLocked(options);
      assert.ok(bridge.outerContainer.classes.has("pdflionPagesLocked"));
    });
  }

  it("show for other documents", async () => {
    const bridge = await withLocked({});
    assert.ok(!bridge.outerContainer.classes.has("pdflionPagesLocked"));
  });

  it("keep thumbnails from being dragged, but not from being clicked", async () => {
    const bridge = await withLocked();
    const image = element(THUMBNAIL_IMAGE);
    assert.ok(bridge.fire("pointerdown", { target: image }).stopped);
    assert.ok(!bridge.fire("pointerdown", { target: image, button: 2 }).stopped);
    assert.ok(!bridge.fire("click", { target: image }).stopped);
    bridge.fire("pointermove", { target: image, clientX: 50 });
    await settle();
    assert.deepEqual(bridge.pdflion.dialogs, []);
  });

  it("keep files from being dropped on the thumbnails", async () => {
    const bridge = await withLocked();
    assert.ok(bridge.fire("dragenter", { target: element(THUMBNAILS) }).stopped);
    assert.ok(!bridge.fire("dragenter", { target: element("#viewerContainer") }).stopped);
  });

  it("say why Copy, Cut and Delete can't change pages", async () => {
    const bridge = await withLocked();
    const item = element(PAGE_CHANGE_ITEMS);
    const click = bridge.fire("click", { target: item });
    assert.ok(click.stopped && click.prevented);
    await settle();
    assert.deepEqual(bridge.pdflion.dialogs, [["locked-encrypted", undefined]]);
    assert.equal(item.clicks, 0);
  });

  it("leave the pages of other documents to pdf.js", async () => {
    const bridge = await withLocked({ numPages: 2 });
    bridge.page.document.checked = true;
    assert.ok(!bridge.fire("pointerdown", { target: element(THUMBNAIL_IMAGE) }).stopped);
    assert.ok(!bridge.fire("dragenter", { target: element(THUMBNAILS) }).stopped);
    assert.ok(!bridge.fire("click", { target: element(PAGE_CHANGE_ITEMS) }).stopped);
    assert.ok(!bridge.fire("keydown", { target: element(THUMBNAILS), key: "Delete" }).stopped);
    assert.ok(!bridge.fire("change", { target: element(ADD_FILE_PICKER) }).stopped);
    assert.ok(!bridge.fire("drop", { target: element(TAKING_FILES) }).stopped);
  });
});

describe("bridge.js page tools of a signed document", () => {
  /** @param {boolean} answer what the user answers to the prompt */
  async function withSigned(answer = true) {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ info: { IsSignaturesPresent: true }, numPages: 2 });
    await settle();
    bridge.pdflion.dialogAnswer = answer;
    return bridge;
  }

  /** @param {any} bridge */
  const asked = (bridge) => bridge.pdflion.dialogs.map(([reason]) => reason);

  it("ask once a press on a thumbnail turns into a drag, which they drop", async () => {
    const bridge = await withSigned();
    const image = element(THUMBNAIL_IMAGE);
    // A click goes to its page.
    assert.ok(bridge.fire("pointerdown", { target: image, clientX: 10, clientY: 10 }).stopped);
    bridge.fire("pointermove", { clientX: 13, clientY: 15 });
    bridge.fire("pointerup", {});
    bridge.fire("pointermove", { clientX: 40, clientY: 40 });
    await settle();
    assert.deepEqual(asked(bridge), []);

    bridge.fire("pointerdown", { target: image, clientX: 10, clientY: 10 });
    bridge.fire("pointermove", { pointerId: 2, clientX: 40, clientY: 40 });
    await settle();
    assert.deepEqual(asked(bridge), []);
    bridge.fire("pointermove", { clientX: 10, clientY: 16 });
    bridge.fire("pointermove", { clientX: 10, clientY: 30 });
    await settle();
    assert.deepEqual(asked(bridge), ["signed"]);

    // The next drag moves pages.
    assert.ok(!bridge.fire("pointerdown", { target: image }).stopped);
  });

  it("keep dropping drags while the user says no", async () => {
    const bridge = await withSigned(false);
    const image = element(THUMBNAIL_IMAGE);
    bridge.fire("pointerdown", { target: image });
    bridge.fire("pointermove", { clientX: 30 });
    await settle();
    assert.ok(bridge.fire("pointerdown", { target: image }).stopped);
  });

  it("hold back Copy, Cut and Delete until the user agrees, then go ahead", async () => {
    const bridge = await withSigned();
    const item = element(PAGE_CHANGE_ITEMS);
    const click = bridge.fire("click", { target: item });
    assert.ok(click.stopped && click.prevented);
    await settle();
    assert.deepEqual(asked(bridge), ["signed"]);
    assert.equal(item.clicks, 1);
    // Only the first change asks.
    assert.ok(!bridge.fire("click", { target: item }).stopped);
  });

  it("drop Copy, Cut and Delete when the user says no", async () => {
    const bridge = await withSigned(false);
    const item = element(PAGE_CHANGE_ITEMS);
    bridge.fire("click", { target: item });
    await settle();
    assert.equal(item.clicks, 0);
    assert.ok(bridge.fire("click", { target: item }).stopped);
  });

  it("hold back the keys that change checked pages in the thumbnails", async () => {
    const bridge = await withSigned();
    const thumbnails = element(THUMBNAILS);
    for (const [key, modifiers] of [
      ["Delete", {}],
      ["c", {}],
      ["x", { altKey: true }],
    ]) {
      assert.ok(!bridge.fire("keydown", { target: thumbnails, key, ...modifiers }).stopped, key);
    }
    // Nothing checked, nothing to change.
    assert.ok(!bridge.fire("keydown", { target: thumbnails, key: "Delete" }).stopped);

    bridge.page.document.checked = true;
    assert.ok(!bridge.fire("keydown", { target: element(), key: "Delete" }).stopped);
    const keydown = bridge.fire("keydown", { target: thumbnails, key: "x", metaKey: true });
    assert.ok(keydown.stopped && keydown.prevented);
    await settle();
    assert.deepEqual(asked(bridge), ["signed"]);
    const [repeated] = thumbnails.dispatched;
    assert.equal(repeated.type, "keydown");
    assert.equal(repeated.key, "x");
    assert.equal(repeated.metaKey, true);
    assert.equal(repeated.bubbles, true);
  });

  it("hold back files chosen with Add file", async () => {
    const bridge = await withSigned();
    const picker = element(ADD_FILE_PICKER);
    assert.ok(bridge.fire("change", { target: picker }).stopped);
    await settle();
    assert.deepEqual(
      picker.dispatched.map(({ type }) => type),
      ["change"],
    );
  });

  it("forget files chosen with Add file when the user says no", async () => {
    const bridge = await withSigned(false);
    const picker = element(ADD_FILE_PICKER);
    bridge.fire("change", { target: picker });
    await settle();
    assert.deepEqual(picker.dispatched, []);
    assert.equal(picker.value, "");
  });

  for (const [answer, outcome] of [
    [true, "drop them where they were dropped"],
    [false, "end pdf.js's drag"],
  ]) {
    it(`hold back files dropped on the thumbnails, then ${outcome}`, async () => {
      const bridge = await withSigned(answer);
      const thumbnails = element(TAKING_FILES);
      const file = { name: "more.pdf" };
      const drop = bridge.fire("drop", {
        target: thumbnails,
        clientX: 20,
        clientY: 30,
        dataTransfer: { files: [file] },
      });
      assert.ok(drop.stopped && drop.prevented);
      await settle();
      const [event] = thumbnails.dispatched;
      if (answer) {
        assert.equal(event.type, "drop");
        assert.deepEqual([event.clientX, event.clientY], [20, 30]);
        assert.equal(event.dataTransfer.files[0], file);
      } else {
        assert.equal(event.type, "dragleave");
        assert.deepEqual([event.clientX, event.clientY], [-1, -1]);
      }
    });
  }

  it("ask once at a time", async () => {
    const bridge = await withSigned();
    bridge.fire("click", { target: element(PAGE_CHANGE_ITEMS) });
    bridge.fire("change", { target: element(ADD_FILE_PICKER) });
    await settle();
    assert.deepEqual(asked(bridge), ["signed"]);
  });
});

describe("bridge.js saving a new file", () => {
  /** @param {object} [options] for openDocument() */
  async function withDocument(options = {}) {
    const bridge = loadBridge();
    await bridge.load();
    bridge.openDocument({ numPages: 2, ...options });
    return bridge;
  }

  /** @param {any} bridge @param {object} [data] what Add file hands onSaveAndLoad() */
  async function addFile(bridge) {
    bridge.app.openedPages = bridge.app.pdfViewer.pagesCount + 1;
    const pageInfos = [{ document: null }, { document: new Uint8Array([5]), insertAfter: 0 }];
    assert.equal(await bridge.app.onSaveAndLoad({ data: { pageInfos, copyLevels: null } }), true);
  }

  const RICH = {
    info: { Title: "Report", Language: "de-CH" },
    holds: { metadata: {}, layers: ["7R"], pageMode: "UseOutlines", pageLabels: ["i", "ii"] },
  };

  it("asks first what the file would lose, as a single file", async () => {
    const bridge = await withDocument(RICH);
    bridge.changePages([2, 1]);
    assert.equal(await bridge.run("save"), true);
    assert.deepEqual(bridge.pdflion.dialogs, [
      ["rewrite", ["xmp", "layers", "viewer-settings", "language"]],
    ]);
    assert.equal(bridge.pdflion.writes.length, 1);
  });

  it("also names the Info dictionary and page labels after Add file", async () => {
    const bridge = await withDocument(RICH);
    await addFile(bridge);
    await bridge.run("save");
    assert.deepEqual(bridge.pdflion.dialogs, [
      ["rewrite", ["xmp", "layers", "viewer-settings", "language", "info", "page-labels"]],
    ]);
  });

  it("also names them for copied pages with typed form values", async () => {
    const bridge = await withDocument({ ...RICH, formData: true });
    bridge.changePages(
      [1, 2, 1],
      [
        { document: null, includePages: [0, 1] },
        { document: null, includePages: [0] },
      ],
    );
    await bridge.run("save");
    assert.deepEqual(bridge.pdflion.dialogs[0][1].slice(-2), ["info", "page-labels"]);
  });

  it("asks too after a page change that brought moved pages along", async () => {
    const bridge = await withDocument(RICH);
    bridge.changePages([2, 1]);
    bridge.app.openedPages = 3;
    assert.equal(await bridge.run("insertBlankPage"), true);
    assert.deepEqual(bridge.pdflion.dialogs, []);
    await bridge.run("save");
    assert.deepEqual(bridge.pdflion.dialogs, [
      ["rewrite", ["xmp", "layers", "viewer-settings", "language"]],
    ]);
  });

  it("saves nothing when the user cancels, and asks again next time", async () => {
    const bridge = await withDocument(RICH);
    bridge.changePages([2, 1]);
    bridge.pdflion.dialogAnswer = false;
    assert.equal(await bridge.run("save"), false);
    assert.deepEqual(bridge.pdflion.writes, []);
    assert.equal(bridge.pdflion.edited.at(-1), true);
    bridge.pdflion.dialogAnswer = true;
    assert.equal(await bridge.run("save"), true);
    assert.equal(bridge.pdflion.dialogs.length, 2);
  });

  it("asks about each item once", async () => {
    const bridge = await withDocument(RICH);
    bridge.changePages([2, 1]);
    // Save As, cancelled after the prompt.
    bridge.pdflion.answer = null;
    assert.equal(await bridge.run("saveAs"), false);
    bridge.pdflion.answer = "/doc/t/a.pdf";
    assert.equal(await bridge.run("save"), true);
    assert.equal(bridge.pdflion.dialogs.length, 1);
  });

  it("asks nothing when the file holds none of it", async () => {
    const bridge = await withDocument();
    bridge.changePages([2, 1]);
    await bridge.run("save");
    await addFile(bridge);
    await bridge.run("save");
    assert.deepEqual(bridge.pdflion.dialogs, []);
  });

  it("asks nothing for an inserted page, which goes after the file", async () => {
    const bridge = await withDocument(RICH);
    await bridge.run("insertBlankPage");
    assert.equal(await bridge.run("save"), true);
    assert.deepEqual(bridge.pdflion.dialogs, []);
  });

  it("asks nothing once the file is saved without it", async () => {
    const bridge = await withDocument({ holds: { metadata: {} } });
    bridge.changePages([2, 1]);
    await bridge.run("save");
    // The saved file, reopened, has no XMP metadata. Nor would this one.
    bridge.app.pdfDocument.numPages = 2;
    bridge.changePages([2, 1]);
    await bridge.run("save");
    assert.equal(bridge.pdflion.dialogs.length, 1);
  });

  for (const [item, options] of [
    ["xmp", { holds: { metadata: {} } }],
    ["layers", { holds: { layers: ["7R"] } }],
    ["scripts", { holds: { jsActions: {} } }],
    ["viewer-settings", { holds: { viewerPreferences: {} } }],
    ["viewer-settings", { holds: { openAction: { dest: [] } } }],
    ["viewer-settings", { holds: { pageMode: "FullScreen" } }],
    ["viewer-settings", { holds: { pageLayout: "TwoColumnLeft" } }],
    ["tagging", { holds: { markInfo: new Map([["Marked", true]]) } }],
    ["language", { info: { Language: "en-US" } }],
    ["info", { info: { Author: "Ada" } }],
    ["info", { info: { Keywords: "lion" } }],
    ["page-labels", { holds: { pageLabels: ["A-1"] } }],
  ]) {
    it(`finds ${item} in ${JSON.stringify(options)}`, async () => {
      const bridge = await withDocument(options);
      await addFile(bridge);
      await bridge.run("save");
      assert.deepEqual(bridge.pdflion.dialogs, [["rewrite", [item]]]);
    });
  }

  for (const [what, options] of [
    ["tags that aren't marked", { holds: { markInfo: new Map([["Marked", false]]) } }],
    ["Info entries other than the title, author, subject and keywords", { info: { Producer: "TeX" } }],
  ]) {
    it(`doesn't count ${what}`, async () => {
      const bridge = await withDocument(options);
      await addFile(bridge);
      await bridge.run("save");
      assert.deepEqual(bridge.pdflion.dialogs, []);
    });
  }
});
