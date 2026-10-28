/**
 * PDFLion's side of the viewer. protocol.js injects this classic script into
 * pdf.js's viewer.html, where it runs in the page's main world before the
 * viewer's module scripts.
 *
 * It is the only code that touches pdf.js internals (PDFViewerApplication, its
 * eventBus, AppOptions). They aren't a stable API, so every name here was
 * checked against pdf.js v6.4.299: web/app.js and web/app_options.js; for the
 * range transport src/display/api.js and src/display/transport_stream.js; for
 * page changes src/display/api.js (getMetadata, isPureXfa, extractPages,
 * pagesMapper, and what findDroppable() reads), src/core/catalog.js (what
 * those answer without an entry), src/core/editor/pdf_editor.js (what
 * extractPages() keeps), src/display/annotation_storage.js,
 * src/core/document.js (the metadata flags, and how it reads /Rotate),
 * web/pdf_thumbnail_viewer.js (getStructuralChanges, #mergeFiles, the
 * listeners guardPageTools() goes before, and the checkboxes' click),
 * src/display/pages_mapper.js, web/pdf_viewer.js (pagesCount,
 * onPagesEdited), web/pdf_page_view.js (updatePageNumber), web/menu.js,
 * web/views_manager.js, web/sidebar.js (onResizing) and web/viewer.html (the
 * toolbar, and the views manager's header, Manage menu, Add file and waiting
 * bar).
 *
 * pdf.js's page tools move, copy and delete pages in the thumbnails, and add
 * pages from other files. The page overview shows those thumbnails across the
 * viewer area. Page changes that pdf.js can't make go through
 * @cantoo/pdf-lib, which protocol.js serves at /lib/ and this script loads the
 * first time it's needed. It changes a document as an incremental update,
 * after its bytes.
 */
"use strict";

(() => {
  /** `LinkTarget.BLANK` in web/pdf_link_service.js. */
  const LINK_TARGET_BLANK = 2;

  /** `ViewOnLoad.INITIAL` in web/app.js. */
  const VIEW_ON_LOAD_INITIAL = 1;

  /** `SidebarView.NONE` and `THUMBS` in web/ui_utils.js: no view, the thumbnails. */
  const SIDEBAR_NONE = 0;
  const SIDEBAR_THUMBS = 1;

  /** `AnnotationEditorPrefix` in src/shared/util.js: annotations made in the viewer. */
  const EDITOR_PREFIX = "pdfjs_internal_editor_";

  /**
   * `AnnotationEditorType` in src/shared/util.js: editing turned off, no tool,
   * and Pencil, whose ink mode the eraser works in.
   */
  const EDITOR_DISABLE = -1;
  const EDITOR_NONE = 0;
  const EDITOR_INK = 15;

  /** @cantoo/pdf-lib's browser build, which defines `window.PDFLib`. */
  const PDF_LIB_URL = "/lib/pdf-lib.min.js";

  /**
   * How far a press on a thumbnail moves before pdf.js drags the page:
   * `DRAG_THRESHOLD_IN_PIXELS` in web/pdf_thumbnail_viewer.js.
   */
  const DRAG_THRESHOLD = 5;

  // Where pdf.js's page tools are, in web/viewer.html and as
  // web/pdf_thumbnail_viewer.js builds the thumbnails.
  const THUMBNAILS = "#thumbnailsView";
  const THUMBNAIL_IMAGE = `${THUMBNAILS} > .thumbnail > .thumbnailImageContainer`;
  const CURRENT_THUMBNAIL = `${THUMBNAIL_IMAGE}[aria-current="page"]`;
  const CHECKED_THUMBNAIL = `${THUMBNAILS} > .thumbnail > input:checked`;
  /** While pdf.js drags pages, which Esc cancels. */
  const DRAGGING_PAGES = `${THUMBNAILS}.isDragging`;
  /** The Manage menu's items that change pages. Export selected doesn't. */
  const PAGE_CHANGE_ITEMS = [
    "#viewsManagerStatusActionCopy",
    "#viewsManagerStatusActionCut",
    "#viewsManagerStatusActionDelete",
  ].join(", ");
  const ADD_FILE_PICKER = "#viewsManagerAddFilePicker";

  /**
   * What the file can hold that saving through extractPages() drops, in the
   * order the save prompt lists it: the items of DROPPED_ITEMS in
   * src/main/pages.js.
   */
  const DROPPABLE = [
    "xmp",
    "layers",
    "scripts",
    "viewer-settings",
    "tagging",
    "language",
    "info",
    "page-labels",
  ];

  /**
   * What extractPages() drops only when it makes the new file of several:
   * it keeps a single file's Info dictionary and page labels (`isSingleFile`
   * in src/core/editor/pdf_editor.js).
   */
  const DROPPED_FROM_SEVERAL = new Set(["info", "page-labels"]);

  /** Whether shortcuts use ⌘, as on macOS, rather than Ctrl, as on Windows. */
  const isMac = window.pdflion.platform === "darwin";

  /**
   * Whether the document has changes since it was opened or last saved, as
   * main last heard it. updateEdited() works it out.
   */
  let edited = false;

  /** Whether pdf.js's annotation storage has changes: form values, annotations. */
  let storageEdited = false;

  /** Whether a page change reopened the document from bytes that aren't saved yet. */
  let reopenedEdited = false;

  /** Whether a save or a page change is under way. Only one runs at a time. */
  let busy = false;

  /** Whether the document changed after a save under way took its bytes. */
  let editedWhileSaving = false;

  /** Whether reopen() is replacing the document with a changed version of itself. */
  let reopening = false;

  /**
   * Whether the user agreed to change the pages of this signed document. It
   * belongs to the tab, which only ever shows one document, so it outlives
   * reopen().
   */
  let signedChangesAllowed = false;

  /**
   * Whether the document's pages can't change: see lockReason(). Until the
   * document has loaded, they can't.
   */
  let locked = true;

  /** Whether the document says it's signed, once checkLocked() has read it. */
  let signed = false;

  /** @type {Promise<boolean> | null} confirmPageChange(), while it asks */
  let asking = null;

  /**
   * @type {Promise<Set<string>>} which of DROPPABLE the file holds, as it was
   * opened or last saved
   */
  let droppable = Promise.resolve(new Set());

  /**
   * Which of DROPPABLE the user agreed to lose. Like signedChangesAllowed, it
   * belongs to the tab.
   */
  const dropAgreed = new Set();

  /**
   * Whether a page change made the document anew with extractPages() since it
   * was opened or saved, and of how many files: Add file makes it of several,
   * and so do pages copied with typed form values. Pages moved, copied or
   * deleted come along with any page change, as a new file of one.
   * @type {"one" | "several" | null}
   */
  let newFile = null;

  /** @type {Promise<any> | null} @cantoo/pdf-lib, once loading it started */
  let pdfLib = null;

  /**
   * @type {HTMLButtonElement[]} the buttons that change pages: Insert Blank
   *   Page in the toolbar and the overview, and the overview's Rotate Pages
   *   Left and Right
   */
  let pageButtons = [];

  /** Whether the page overview is open: see openOverview(). */
  let overview = false;

  /** The views manager's view before the overview opened, as a `SidebarView`. */
  let viewBeforeOverview = SIDEBAR_NONE;

  /** @type {HTMLButtonElement | null} the toolbar's Page Overview button */
  let overviewButton = null;

  /**
   * @typedef {object} EraserSettings as main keeps them for every tab
   * @property {"line" | "object"} mode
   * @property {number} size the eraser's width, in points
   */

  /** @type {EraserSettings} */
  let eraser = { mode: "object", size: 10 };

  /** Whether the eraser is on: see startErasing(). */
  let erasing = false;

  /**
   * @typedef {object} EraserTool what addEraserTool() adds
   * @property {HTMLButtonElement} button
   * @property {HTMLElement} box its option box
   * @property {Record<"line" | "object", HTMLInputElement>} modes
   * @property {HTMLInputElement} size
   * @property {HTMLElement} cursor the circle that follows the pointer over pages
   */

  /** @type {EraserTool | null} */
  let eraserTool = null;

  /**
   * @typedef {object} Drawing an ink editor's strokes, read once per drag
   * @property {ArrayLike<number>[]} strokes x, y pairs in PDF coordinates
   * @property {number} thickness
   * @property {[number, number, number, number]} box around the strokes' points
   */

  /**
   * @typedef {object} Gesture a drag of the eraser
   * @property {number} pointerId
   * @property {{ pageIndex: number, point: number[] } | null} last where the
   *   eraser last was on a page
   * @property {Map<any, Drawing | null>} drawings each editor seen, and its
   *   strokes if it's Pencil's
   * @property {any[]} erased the editors it removed
   * @property {AbortController} listening for the drag's pointer events
   */

  /** @type {Gesture | null} */
  let gesture = null;

  /**
   * Commands main sends, mostly from the menu, mapped to pdf.js calls. What a
   * command returns goes back to main.
   * @type {Record<string, (app: any) => unknown>}
   */
  const COMMANDS = {
    print: (app) => app.triggerPrinting(),
    zoomIn: (app) => app.zoomIn(),
    zoomOut: (app) => app.zoomOut(),
    // pdf.js's own "Actual Size" zoom. Its zoomReset() goes to Automatic Zoom.
    actualSize: (app) => {
      app.pdfViewer.currentScaleValue = "page-actual";
    },
    find: (app) => app.findBar?.open(),
    toggleSidebar: (app) => app.viewsManager?.toggle(),
    pageOverview: (app) => toggleOverview(app),
    rotateLeft: (app) => app.rotatePages(-90),
    rotateRight: (app) => app.rotatePages(90),
    presentation: (app) => app.requestPresentationMode(),
    // An unchanged document is already saved.
    save: (app) => !edited || save(app, window.pdflion.save),
    saveAs: (app) => save(app, window.pdflion.saveAs),
    insertBlankPage: (app) => insertBlankPage(app),
    // Edit > Undo and Redo. False leaves them to Chromium, which main asks next.
    undo: (app) => editingAction(app, "undo"),
    redo: (app) => editingAction(app, "redo"),
  };

  // The page gets key events before the native menu, on macOS and Windows
  // alike, and the menu only gets the ones the page leaves unhandled.
  // Capturing on window runs before pdf.js's listeners, so these keys skip
  // pdf.js and reach the menu.
  window.addEventListener(
    "keydown",
    (event) => {
      if (isMenuShortcut(event)) event.stopImmediatePropagation();
    },
    true,
  );

  // Dispatched once the viewer's scripts have loaded, before it initialises.
  document.addEventListener(
    "webviewerloaded",
    () => {
      window.PDFViewerApplicationOptions.setAll({
        // Otherwise preferences stored by pdf.js override the options below.
        disablePreferences: true,
        // Never open pdf.js's demo PDF.
        defaultUrl: "",
        // Links go through window.open, which main's setWindowOpenHandler vets.
        externalLinkTarget: LINK_TARGET_BLANK,
        // pdf.js's page tools, which its generic build leaves off: selecting,
        // moving, copying and deleting pages in the thumbnails, and adding the
        // pages of other files.
        enableSplitMerge: true,
        enableMerge: true,
      });

      const app = window.PDFViewerApplication;
      loadDocumentsInParts(app);
      // pdf.js hasn't bound its events yet.
      addFilesAsPageChanges(app);
      // The DOM is parsed, and pdf.js hasn't bound its toolbar yet.
      overviewButton = addOverviewButton(app);
      pageButtons = [addInsertButton(app), ...addOverviewTools(app)].filter((button) => !!button);
      eraserTool = addEraserTool(app);
      guardPageTools(app);
      app.initializedPromise.then(() => {
        window.pdflion.onCommand((command) =>
          Object.hasOwn(COMMANDS, command) ? COMMANDS[command](app) : null,
        );
        // After pdf.js's own listeners, which come with the views manager.
        followOverview(app);
        // After the overview's, whose Esc comes first.
        followEraser(app);
        app.eventBus.on("documentloaded", () => {
          trackEdits(app);
          checkLocked(app);
          // A reopened document shows changes to the file, not the file.
          if (!reopening) noteDroppable(app);
        });
        // Pages moved, copied or deleted in the thumbnails, or that change undone.
        app.eventBus.on("pagesedited", () => {
          if (busy) editedWhileSaving = true;
          updateEdited(app);
          recachePages(app);
        });
        hideChangesIndicator(app);
      });
    },
    { once: true },
  );

  /**
   * pdf.js loads a document in parts only from http(s) URLs: it streams the
   * file and fetches the parts it needs sooner as byte ranges, such as the
   * cross-reference table at the end. Any other URL it reads whole before
   * showing anything (getNetworkStream in src/display/network_stream.js). So
   * for /doc/ URLs, open() gets a range transport that does what pdf.js does
   * for http(s), and the first page of a big file shows before the rest has
   * loaded. The viewer's run() calls open() for the `file` parameter.
   *
   * @param {any} app
   */
  function loadDocumentsInParts(app) {
    const { open } = app;
    /** @param {any} args */
    app.open = async function (args) {
      const range = isDocumentUrl(args?.url) ? await rangeTransport(args.url) : null;
      return open.call(this, range ? { ...args, range } : args);
    };
  }

  /**
   * @param {unknown} url
   * @returns {boolean} whether `url` is a document main serves at /doc/
   */
  function isDocumentUrl(url) {
    if (typeof url !== "string") return false;
    const parsed = URL.parse(url, location.href);
    return parsed?.origin === location.origin && parsed.pathname.startsWith("/doc/");
  }

  /**
   * Starts reading a document and makes a PDFDataRangeTransport for it, which
   * hands pdf.js the file from start to end, plus the byte ranges it asks for.
   * pdf.js stops asking for a range once the stream has brought it, so a
   * range that fails only matters if the stream fails too. Range requests
   * name the ETag of the stream, and main refuses them once the file has
   * changed, so the parts never come from different versions.
   *
   * @param {string} url a /doc/ URL
   * @returns {Promise<any>} the transport, or null to leave the document to
   *   pdf.js, which then reports what's wrong with it
   */
  async function rangeTransport(url) {
    const controller = new AbortController();
    const { signal } = controller;
    let response;
    try {
      response = await fetch(url, { signal });
    } catch {
      return null;
    }
    const length = Number(response.headers.get("Content-Length"));
    const etag = response.headers.get("ETag");
    if (!response.ok || !response.body || !etag || !Number.isSafeInteger(length)) {
      controller.abort();
      return null;
    }

    const transport = new window.pdfjsLib.PDFDataRangeTransport(length, null);
    /**
     * @param {number} begin
     * @param {number} end exclusive
     */
    transport.requestDataRange = async (begin, end) => {
      try {
        const part = await fetch(url, {
          signal,
          headers: { Range: `bytes=${begin}-${end - 1}`, "If-Match": etag },
        });
        if (part.status !== 206) throw new Error(`Unexpected response ${part.status}`);
        const chunk = new Uint8Array(await part.arrayBuffer());
        if (!signal.aborted) transport.onDataRange(begin, chunk);
      } catch (error) {
        // Not fatal while the stream is still bringing the file.
        if (!signal.aborted) console.warn(`Couldn't load bytes ${begin}–${end} of ${url}:`, error);
      }
    };
    // pdf.js aborts when the document closes.
    transport.abort = () => controller.abort();
    streamDocument(response.body.getReader(), transport, signal);
    return transport;
  }

  /**
   * Hands pdf.js a document from start to end. If reading fails, pdf.js
   * fetches the rest as ranges, once it needs them.
   *
   * @param {ReadableStreamDefaultReader<Uint8Array>} reader
   * @param {any} transport
   * @param {AbortSignal} signal
   */
  async function streamDocument(reader, transport, signal) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        transport.onDataProgressiveRead(value);
      }
    } catch (error) {
      if (signal.aborted) return;
      console.error("Couldn't read the document to its end:", error);
    }
    transport.onDataProgressiveDone();
  }

  /**
   * Whether a key is a shortcut of the native menu (src/main/menu.js) that
   * pdf.js also acts on: ⌘O, ⌘S, ⌘P, ⌘F, ⇧⌘F, ⌘+, ⌘=, ⌘− and ⌘0, in
   * web/app.js onKeyDown and web/pdf_print_service.js, with Ctrl for ⌘ on
   * Windows. pdf.js would open its own file picker, download instead of
   * saving, open Find on ⇧⌘F, and reset the zoom after ⌘0.
   *
   * On Windows also F4, Toggle Sidebar there. pdf.js toggles the sidebar on F4
   * too, without preventDefault(), so the sidebar would toggle twice.
   *
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  function isMenuShortcut({ key, metaKey, ctrlKey, altKey, shiftKey }) {
    if (key === "F4") return !isMac && !metaKey && !ctrlKey && !altKey && !shiftKey;
    const [commandKey, otherKey] = isMac ? [metaKey, ctrlKey] : [ctrlKey, metaKey];
    if (!commandKey || otherKey || altKey) return false;
    switch (key.toLowerCase()) {
      case "o":
      case "s":
      case "p":
        return !shiftKey;
      case "f": // Find, or Presentation Mode with Shift
      case "+":
      case "=":
      case "-":
      case "0":
        return true;
      default:
        return false;
    }
  }

  /**
   * Follows pdf.js's modified flag, which is set by the first change and
   * cleared when the changes are undone. pdf.js installs its own callbacks
   * before `documentloaded`, so wrap them rather than replace them.
   *
   * saveDocument() and extractPages() also clear the flag, as soon as they
   * have the bytes and before main has written them, so during a save save()
   * decides instead.
   *
   * @param {any} app
   */
  function trackEdits(app) {
    const storage = app.pdfDocument.annotationStorage;
    const { onSetModified, onResetModified } = storage;
    storageEdited = false;
    // A reopened document keeps the changes it was reopened with.
    if (!reopening) reopenedEdited = edited = false;
    storage.onSetModified = () => {
      onSetModified?.();
      if (busy) editedWhileSaving = true;
      storageEdited = true;
      updateEdited(app);
    };
    storage.onResetModified = () => {
      onResetModified?.();
      if (busy) return;
      storageEdited = false;
      updateEdited(app);
    };
  }

  /**
   * Reports unsaved changes to main, which shows them in the title or on the
   * tab, and asks about them before the tab closes: form values and
   * annotations, pages changed with pdf.js's page tools, and page changes that
   * reopened the document.
   *
   * @param {any} app
   */
  function updateEdited(app) {
    edited = storageEdited || reopenedEdited || hasPageChanges(app);
    window.pdflion.setEdited(edited);
  }

  /**
   * pdf.js caches the document's pages by their place, and getPage() answers
   * from that cache, for printing and Find among others. When a deletion is
   * undone, the pages that return to the place they had before aren't cached
   * there again, so getPage() answers with the page that took their place
   * meanwhile. Setting the number of each page shown caches it at its place.
   *
   * @param {any} app
   */
  function recachePages({ pdfViewer }) {
    for (let index = 0; index < pdfViewer.pagesCount; index++) {
      const { pdfPage } = pdfViewer.getPageView(index);
      if (pdfPage) pdfPage.pageNumber = index + 1;
    }
  }

  /**
   * Whether pages were moved, copied or deleted with pdf.js's page tools and
   * not saved yet. pdf.js's hasStructuralChanges() stays true after the first
   * change, even once it's undone, and after a Copy that was never pasted. So
   * this compares the order of the pages with the document's own.
   *
   * @param {any} app
   * @returns {boolean}
   */
  function hasPageChanges({ pdfDocument, pdfThumbnailViewer }) {
    if (!pdfDocument || !pdfThumbnailViewer?.hasStructuralChanges()) return false;
    /** @type {Uint32Array} each page's number in the document, in the order shown */
    const order = pdfDocument.pagesMapper.getMapping();
    return order.length !== pdfDocument.numPages || order.some((id, index) => id !== index + 1);
  }

  /**
   * pdf.js prefixes the title with "* " while the document has any form data
   * or annotations, and keeps it after they're saved. The window's edited dot
   * shows unsaved changes instead.
   *
   * @param {any} app
   */
  function hideChangesIndicator(app) {
    const { setTitle } = app;
    /** @param {string} [title] */
    app.setTitle = function (title) {
      setTitle.call(this, title);
      document.title = document.title.replace(/^\* /, "");
    };
  }

  /**
   * Saves the document with its form data, annotations and page changes. Like
   * pdf.js's own save, which downloads instead, it runs the PDF's WillSave and
   * DidSave scripts around it.
   *
   * Page changes made with pdf.js's page tools are written as a new file. The
   * tab then shows that file, as it's now saved, so that the document matches
   * the file and the page tools start afresh. Changes made while the file was
   * being written would be lost that way, so after those the tab keeps the
   * document as it is, edited. A new file drops some of what the old one held,
   * so the save asks first: see confirmRewrite().
   *
   * @param {any} app
   * @param {(bytes: Uint8Array) => Promise<string | null>} write
   *   window.pdflion.save or saveAs
   * @returns {Promise<boolean>} whether the document was saved
   */
  async function save(app, write) {
    if (busy) return false;
    busy = true;
    editedWhileSaving = false;
    updatePageButtons(app);
    try {
      if (!(await confirmRewrite(app))) return false;
      const pageChanges = hasPageChanges(app);
      let bytes, url;
      await app.pdfScriptingManager.dispatchWillSave();
      try {
        bytes = await currentBytes(app);
        url = await write(bytes);
      } finally {
        await app.pdfScriptingManager.dispatchDidSave();
      }
      if (!url) return false; // Still edited, whatever saveDocument() reported.
      storageEdited = editedWhileSaving;
      reopenedEdited = false;
      if (pageChanges && !editedWhileSaving) {
        try {
          const filename = documentName(url);
          await reopen(app, bytes, { page: app.page, url, filename, edited: false });
        } catch (error) {
          // The file is saved all the same.
          console.error("Couldn't show the saved document:", error);
          updateEdited(app);
        }
      } else {
        if (url !== app.url) showDocumentUrl(app, url);
        updateEdited(app);
      }
      noteDroppable(app);
      return true;
    } finally {
      busy = false;
      updatePageButtons(app);
    }
  }

  /**
   * Before a save that writes a new file, through extractPages(), asks
   * whether to drop what the file holds and the new one won't. That's a save
   * with page changes from pdf.js's page tools, or of a document a page
   * change made anew. Each item is asked about once per tab.
   *
   * @param {any} app
   * @returns {Promise<boolean>} whether to save
   */
  async function confirmRewrite(app) {
    const pageChanges = hasPageChanges(app);
    if (!pageChanges && !newFile) return true;
    const several = newFile === "several" || (pageChanges && fromSeveralCopies(app));
    const held = await droppable;
    const items = DROPPABLE.filter(
      (item) =>
        held.has(item) && !dropAgreed.has(item) && (several || !DROPPED_FROM_SEVERAL.has(item)),
    );
    if (items.length === 0) return true;
    if (!(await window.pdflion.pageDialog("rewrite", items))) return false;
    for (const item of items) dropAgreed.add(item);
    return true;
  }

  /**
   * Whether extractPages() will make the new file of several, although no
   * file was added: with typed form values, withFormValues() gives each copy
   * of a page its own copy of the document.
   *
   * @param {any} app
   * @returns {boolean}
   */
  function fromSeveralCopies({ pdfDocument, pdfThumbnailViewer }) {
    const { pageInfos } = pdfThumbnailViewer.getStructuralChanges();
    return pageInfos.length > 1 && hasFormValues(pdfDocument);
  }

  /**
   * Notes what the file holds that a new file of its pages would drop, from
   * the document shown, once it's the file as opened or saved.
   *
   * @param {any} app
   */
  function noteDroppable(app) {
    newFile = null;
    droppable = findDroppable(app.pdfDocument);
  }

  /**
   * @param {any} pdfDocument
   * @returns {Promise<Set<string>>} which of DROPPABLE the document holds
   */
  async function findDroppable(pdfDocument) {
    try {
      const { info, metadata } = await pdfDocument.getMetadata();
      /** @type {Record<string, boolean>} */
      const holds = {
        xmp: metadata !== null,
        // Its optional content groups, one for each layer.
        layers: [...(await pdfDocument.getOptionalContentConfig())].length > 0,
        // The JavaScript name tree, and the catalog's actions.
        scripts: (await pdfDocument.getJSActions()) !== null,
        // pdf.js answers with these defaults when the catalog has no entry.
        "viewer-settings":
          (await pdfDocument.getViewerPreferences()) !== null ||
          (await pdfDocument.getOpenAction()) !== null ||
          (await pdfDocument.getPageMode()) !== "UseNone" ||
          (await pdfDocument.getPageLayout()) !== "",
        // A Map, from the worker, whatever the JSDoc says.
        tagging: (await pdfDocument.getMarkInfo())?.get("Marked") === true,
        // The catalog's Lang.
        language: Boolean(info.Language),
        info: ["Title", "Author", "Subject", "Keywords"].some((key) => info[key]),
        "page-labels": (await pdfDocument.getPageLabels()) !== null,
      };
      return new Set(DROPPABLE.filter((item) => holds[item]));
    } catch (error) {
      console.warn("Couldn't read what the document holds:", error);
      return new Set();
    }
  }

  /**
   * The document as Save writes it:
   * - with page changes from pdf.js's page tools, the new file extractPages()
   *   makes of them
   * - with form data or annotations, pdf.js's saveDocument(), which adds them
   *   after the original bytes
   * - otherwise the original bytes, which is how pdf.js's own Download decides
   *
   * @param {any} app
   * @returns {Promise<Uint8Array>}
   */
  async function currentBytes(app) {
    const { pdfDocument, pdfThumbnailViewer } = app;
    if (hasPageChanges(app)) {
      const { pageInfos, copyLevels } = pdfThumbnailViewer.getStructuralChanges();
      return pdfDocument.extractPages(await withFormValues(pdfDocument, pageInfos), copyLevels);
    }
    return pdfDocument.annotationStorage.size > 0
      ? pdfDocument.saveDocument()
      : pdfDocument.getData();
  }

  /**
   * extractPages() brings along only annotations made in the viewer
   * (getNewAnnotationsMap in src/core/core_utils.js), so form values typed
   * since the last save would be lost. With any, the open document's pages
   * come from saveDocument()'s bytes, which hold them. pdf.js applies viewer
   * annotations to the open document only, so nothing is applied twice.
   *
   * @param {any} pdfDocument
   * @param {{ document: Uint8Array | null }[]} pageInfos `document: null`
   *   stands for the open document
   * @returns {Promise<object[]>}
   */
  async function withFormValues(pdfDocument, pageInfos) {
    if (!hasFormValues(pdfDocument)) return pageInfos;
    const saved = await pdfDocument.saveDocument();
    // Each gets its own copy, since posting them to the worker may detach them.
    return pageInfos.map((info) =>
      info.document === null ? { ...info, document: saved.slice() } : info,
    );
  }

  /**
   * @param {any} pdfDocument
   * @returns {boolean} whether the annotation storage holds more than
   *   annotations made in the viewer: form values
   */
  function hasFormValues(pdfDocument) {
    return [...pdfDocument.annotationStorage].some(([key]) => !key.startsWith(EDITOR_PREFIX));
  }

  /**
   * Inserts an empty page after the current one, of the size that page is
   * shown at, and goes to it. In the page overview, it goes after the last
   * checked page, if any. The page is added after the document's bytes, as
   * an incremental update, so everything the file holds stays as it was.
   *
   * @param {any} app
   * @returns {Promise<boolean>} whether the page was inserted
   */
  function insertBlankPage(app) {
    return runPageChange(app, () => {
      // The page to insert after, which is also the new page's index.
      const index = (overview && checkedPages().at(-1)) || app.page;
      const { view, rotate } = app.pdfViewer.getPageView(index - 1).pdfPage;
      const [width, height] = [view[2] - view[0], view[3] - view[1]];
      // A page shown on its side, by its /Rotate, is as wide as it's tall.
      const size = rotate % 180 === 0 ? [width, height] : [height, width];
      return changeDocument(app, index + 1, (bytes) =>
        updateDocument(bytes, (document) => document.insertPage(index, size)),
      );
    });
  }

  /**
   * Turns the pages checked in the thumbnails a quarter turn, or the current
   * page if none is. It sets their /Rotate after the document's bytes, as an
   * incremental update, like insertBlankPage(), and they stay checked.
   * View > Rotate Left and Right turn the view instead, which isn't saved.
   *
   * @param {any} app
   * @param {number} delta -90 to turn them left, 90 to turn them right
   * @returns {Promise<boolean>} whether the pages turned
   */
  function rotatePages(app, delta) {
    return runPageChange(app, () => {
      const checked = checkedPages();
      const pages = checked.length > 0 ? checked : [app.page];
      const change = (/** @type {Uint8Array} */ bytes) =>
        updateDocument(bytes, (document, { degrees }) => {
          for (const number of pages) {
            const page = document.getPage(number - 1);
            const angle = rightAngle(rightAngle(page.getRotation().angle) + delta);
            page.setRotation(degrees(angle));
          }
        });
      return changeDocument(app, app.page, change, { selection: checked });
    });
  }

  /**
   * @param {number} angle a page's /Rotate, in degrees
   * @returns {number} the angle pdf.js turns the page by: 0, 90, 180 or 270,
   *   and 0 for an angle that isn't a quarter turn (`get rotate()` in
   *   src/core/document.js)
   */
  function rightAngle(angle) {
    return angle % 90 === 0 ? ((angle % 360) + 360) % 360 : 0;
  }

  /**
   * Runs a page change, unless a save or another page change is under way,
   * or the document's pages may not change.
   *
   * @param {any} app
   * @param {() => Promise<boolean>} change
   * @returns {Promise<boolean>} whether the document changed
   */
  async function runPageChange(app, change) {
    if (busy || !app.pdfDocument) return false;
    busy = true;
    updatePageButtons(app);
    try {
      return (await confirmPageChange(app)) && (await change());
    } finally {
      busy = false;
      updatePageButtons(app);
    }
  }

  /**
   * pdf.js's Add file, and files dropped on the thumbnails, add their pages
   * through app.onSaveAndLoad(): extractPages() makes one file of the document
   * and the added files, which then replaces the document. PDFLion's own goes
   * the way of its other page changes instead:
   * - form values typed since the last save come along
   * - it doesn't run during a save or another page change
   * - a locked document says why it can't, and a signed one asks first
   * - the result counts as edited until it's saved
   * - if it has no more pages than before, or pdf.js can't show it, the
   *   document stays as it was and the user hears so
   *
   * pdf.js binds onSaveAndLoad() to its event as the viewer initialises, so
   * this must run before.
   *
   * @param {any} app
   */
  function addFilesAsPageChanges(app) {
    /** @param {{ data: { pageInfos: any[], copyLevels: Int32Array | null } }} event */
    app.onSaveAndLoad = ({ data }) => addPages(app, data);
  }

  /**
   * @param {any} app
   * @param {{ pageInfos: any[], copyLevels: Int32Array | null }} changes the
   *   document's pages, as getStructuralChanges() gives them, then those of
   *   each added file, with the index of the page to insert them after
   * @returns {Promise<boolean>} whether pages were added
   */
  async function addPages(app, { pageInfos, copyLevels }) {
    let added = false;
    if (!busy && app.pdfDocument) {
      busy = true;
      updatePageButtons(app);
      try {
        if (await confirmPageChange(app)) {
          const { pdfDocument } = app;
          const insertAfter =
            pageInfos.find((info) => Number.isInteger(info.insertAfter))?.insertAfter ?? -1;
          // Shows the first added page, which pdf.js also goes to once the
          // pages have loaded.
          added = await changeDocument(
            app,
            insertAfter + 2,
            async () =>
              pdfDocument.extractPages(await withFormValues(pdfDocument, pageInfos), copyLevels),
            { minPages: app.pdfViewer.pagesCount + 1 },
          );
          // The new document has dropped what a new file of several does.
          if (added) newFile = "several";
        }
      } finally {
        busy = false;
        updatePageButtons(app);
      }
    }
    // pdf.js waits for the new document until it's told otherwise, as its
    // waiting bar's close button does.
    if (!added) document.getElementById("viewsManagerStatusWaitingCloseButton")?.click();
    return added;
  }

  /**
   * Changes a document with @cantoo/pdf-lib, as an incremental update: the
   * change goes after its bytes, which stay as they were.
   *
   * @param {Uint8Array} bytes
   * @param {(document: any, lib: any) => void} change given a PDFDocument,
   *   and @cantoo/pdf-lib itself
   * @returns {Promise<Uint8Array>} the changed document
   */
  async function updateDocument(bytes, change) {
    const lib = await loadPdfLib();
    // updateMetadata: false keeps the Info dictionary as it is, rather than
    // stamp pdf-lib as its producer.
    const document = await lib.PDFDocument.load(bytes, {
      forIncrementalUpdate: true,
      updateMetadata: false,
    });
    change(document, lib);
    return document.save();
  }

  /**
   * Changes the document, starting from the bytes Save would write, then
   * shows the result. If the change fails, or pdf.js can't show the result, or
   * it has fewer than `minPages` pages, the user hears so and the document
   * stays as it was.
   *
   * @param {any} app
   * @param {number} page the page to show afterwards
   * @param {(bytes: Uint8Array) => Promise<Uint8Array | null>} change
   * @param {{ minPages?: number, selection?: number[] }} [options]
   *   selection: the pages to check in the thumbnails afterwards
   * @returns {Promise<boolean>} whether the document changed
   */
  async function changeDocument(app, page, change, { minPages = 1, selection = [] } = {}) {
    const wasEdited = edited;
    // A failed open() forgets them.
    const { url, _docFilename: filename, page: pageBefore } = app;
    // The bytes bring pages moved, copied or deleted along, as a new file.
    const rewrite = hasPageChanges(app) ? (fromSeveralCopies(app) ? "several" : "one") : null;
    const bytes = await currentBytes(app);
    let changed;
    try {
      changed = await change(bytes);
      // extractPages() answers null when it fails.
      if (!changed) throw new Error("No changed document");
    } catch (error) {
      console.error("Couldn't change the document:", error);
      await window.pdflion.pageDialog("failed");
      return false;
    }
    try {
      await reopen(app, changed, { page, url, filename, selection });
      const { numPages } = app.pdfDocument;
      if (numPages < minPages) throw new Error(`The changed document has ${numPages} pages`);
      return true;
    } catch (error) {
      // Back to the bytes it had, which hold every change made so far.
      console.error("Couldn't open the changed document:", error);
      const restored = { page: pageBefore, url, filename, edited: wasEdited, selection };
      await reopen(app, bytes, restored).catch(() => {});
      await window.pdflion.pageDialog("failed");
      return false;
    } finally {
      // Either way, the document shown is now that new file, which Save asks about.
      if (rewrite && newFile !== "several") newFile = rewrite;
    }
  }

  /**
   * Replaces the document with new bytes in the same tab, as pdf.js's own
   * onSaveAndLoad() does, and keeps the view: the zoom, the rotation, the
   * scroll and spread modes, and the sidebar or the page overview, at `page`.
   * The document keeps its URL and file name, and counts as edited until it's
   * saved. pdf.js forgets which thumbnails were checked, so `selection` names
   * the pages to check again.
   *
   * @param {any} app
   * @param {Uint8Array} bytes
   * @param {{ page: number, url: string, filename: string, edited?: boolean,
   *   selection?: number[] }} options
   */
  async function reopen(
    app,
    bytes,
    { page, url, filename, edited: isEdited = true, selection = [] },
  ) {
    const { eventBus, pdfViewer, viewsManager } = app;
    const { currentScaleValue, pagesRotation, scrollMode, spreadMode } = pdfViewer;
    // The thumbnails while the overview is open. It stays open, since
    // followOverview() ignores pdf.js switching views while the document loads.
    const sidebarView = viewsManager?.visibleView ?? SIDEBAR_NONE;
    // The changed document has the same fingerprint, so pdf.js would show it
    // where its browser history and its view history left the old one, rather
    // than at initialBookmark. load() reads the option before documentinit.
    const options = window.PDFViewerApplicationOptions;
    const viewOnLoad = options.get("viewOnLoad");
    options.set("viewOnLoad", VIEW_ON_LOAD_INITIAL);
    reopening = true;
    try {
      // showDocumentUrl() needs the metadata, which comes last.
      const shown = Promise.all([
        nextEvent(eventBus, "documentloaded"),
        nextEvent(eventBus, "documentinit"),
        nextEvent(eventBus, "metadataloaded"),
      ]);
      // setInitialView() shows these, and applies them again once every page
      // has loaded.
      app.initialBookmark = `page=${page}&zoom=${zoomParameter(currentScaleValue)}`;
      app.initialRotation = pagesRotation;
      await app.open({ data: bytes, filename });
      // open() resolves once pdf.js has the document, before it reads its
      // pages. pagesPromise rejects if it can't set them up, and then no
      // event comes. The page to show must load too.
      await Promise.all([shown, pdfViewer.pagesPromise, app.pdfDocument.getPage(page)]);
      pdfViewer.scrollMode = scrollMode;
      pdfViewer.spreadMode = spreadMode;
      if (sidebarView) viewsManager.switchView(sidebarView, /* forceOpen = */ true);
      else viewsManager?.close();
      // pdf.js would drag pages to where the old document's thumbnails were.
      if (sidebarView === SIDEBAR_THUMBS) relayoutThumbnails(app);
      for (const number of selection) checkThumbnail(number);
      // open() with data forgets the URL, which save() compares against.
      showDocumentUrl(app, url);
    } finally {
      options.set("viewOnLoad", viewOnLoad);
      reopening = false;
    }
    reopenedEdited = isEdited;
    updateEdited(app);
  }

  /**
   * @param {string} url `/doc/<token>/<name>`
   * @returns {string} the document's file name
   */
  function documentName(url) {
    return decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
  }

  /**
   * @param {string} scaleValue `pdfViewer.currentScaleValue`: a scale, such as
   *   "1.25", or a named zoom, such as "page-fit"
   * @returns {string} the `zoom` of a pdf.js hash: a percentage, or the name
   */
  function zoomParameter(scaleValue) {
    const scale = Number(scaleValue);
    return Number.isFinite(scale) && scale > 0 ? String(scale * 100) : scaleValue;
  }

  /**
   * @param {any} eventBus
   * @param {string} name
   * @returns {Promise<void>} settles when pdf.js next dispatches `name`
   */
  function nextEvent(eventBus, name) {
    return new Promise((resolve) => eventBus.on(name, () => resolve(), { once: true }));
  }

  /**
   * Whether the document's pages may change. A locked document says why it
   * can't. A signed document asks first, once.
   *
   * @param {any} app
   * @returns {Promise<boolean>}
   */
  async function confirmPageChange(app) {
    const { info } = await app.pdfDocument.getMetadata();
    const reason = lockReason(app.pdfDocument, info);
    if (reason) {
      await window.pdflion.pageDialog(reason);
      return false;
    }
    if (info.IsSignaturesPresent && !signedChangesAllowed) {
      if (!(await window.pdflion.pageDialog("signed"))) return false;
      signedChangesAllowed = true;
    }
    return true;
  }

  /**
   * Documents with a password (even an owner password only, which opens
   * without asking) and pure XFA forms are locked against page changes.
   * @cantoo/pdf-lib's increments to encrypted files aren't reliable, and pdf.js
   * draws pure XFA forms from their XML, not from pages.
   *
   * @param {any} pdfDocument
   * @param {any} info from getMetadata()
   * @returns {"locked-encrypted" | "locked-xfa" | null}
   */
  function lockReason(pdfDocument, info) {
    if (info.EncryptFilterName) return "locked-encrypted";
    if (pdfDocument.isPureXfa) return "locked-xfa";
    return null;
  }

  /**
   * Finds out whether the document is locked, which `pdflionPagesLocked` on
   * #outerContainer shows (see overrides.css), and whether it's signed.
   *
   * @param {any} app
   */
  async function checkLocked(app) {
    const { pdfDocument } = app;
    locked = true;
    updatePageButtons(app);
    try {
      const { info } = await pdfDocument.getMetadata();
      if (app.pdfDocument !== pdfDocument) return;
      locked = lockReason(pdfDocument, info) !== null;
      signed = Boolean(info.IsSignaturesPresent);
    } catch (error) {
      console.warn("Couldn't read the document's metadata:", error);
    }
    document.getElementById("outerContainer")?.classList.toggle("pdflionPagesLocked", locked);
    updatePageButtons(app);
  }

  /**
   * Keeps pdf.js's page tools from changing the pages of a locked document,
   * and asks before the first page change of a signed one: dragging pages,
   * Copy, Cut and Delete from the Manage menu or the keyboard, Add file, and
   * files dropped on the thumbnails. Capturing on window comes before pdf.js's
   * own listeners. A click on a thumbnail still goes to its page.
   *
   * A locked document's page tools are hidden, and its thumbnails take
   * neither drags nor files. A signed document's change waits for the user's
   * answer, and then goes ahead or is dropped. A drag can't be repeated, so
   * once the user agrees, the next drag moves pages.
   *
   * @param {any} app
   */
  function guardPageTools(app) {
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || !targetIn(event, THUMBNAIL_IMAGE)) return;
        if (!locked && !mustAsk()) return;
        // pdf.js would get ready to drag the page.
        event.stopPropagation();
        if (!locked) askOnceDragged(app, event);
      },
      true,
    );
    window.addEventListener(
      "dragenter",
      (event) => {
        // pdf.js would take files dropped on the thumbnails. PDFs dropped
        // there then open as tabs, as anywhere else (preload.cjs).
        if (locked && targetIn(event, THUMBNAILS)) event.stopPropagation();
      },
      true,
    );
    window.addEventListener(
      "drop",
      (event) => {
        const thumbnails = targetIn(event, `${THUMBNAILS}.isDraggingFile`);
        if (!thumbnails || !mustAsk()) return;
        // Only readable while the event is dispatched.
        const files = [...(event.dataTransfer?.files ?? [])];
        const { clientX, clientY } = event;
        holdBack(
          app,
          event,
          () => {
            const dataTransfer = new DataTransfer();
            for (const file of files) dataTransfer.items.add(file);
            const init = { dataTransfer, clientX, clientY, bubbles: true, cancelable: true };
            thumbnails.dispatchEvent(new DragEvent("drop", init));
          },
          // pdf.js still marks where the files would go, until they leave.
          () =>
            thumbnails.dispatchEvent(
              new DragEvent("dragleave", { clientX: -1, clientY: -1, bubbles: true }),
            ),
        );
      },
      true,
    );
    window.addEventListener(
      "click",
      (event) => {
        const item = targetIn(event, PAGE_CHANGE_ITEMS);
        if (item && mustAsk()) holdBack(app, event, () => item.click());
      },
      true,
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (!isPageChangeKey(event) || !mustAsk()) return;
        const { target, key, code, ctrlKey, metaKey, altKey, shiftKey } = event;
        const init = { key, code, ctrlKey, metaKey, altKey, shiftKey };
        holdBack(app, event, () =>
          target?.dispatchEvent(
            new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }),
          ),
        );
      },
      true,
    );
    window.addEventListener(
      "change",
      (event) => {
        const picker = targetIn(event, ADD_FILE_PICKER);
        if (!picker || !mustAsk()) return;
        holdBack(
          app,
          event,
          () => picker.dispatchEvent(new Event("change")),
          // So that picking the same files again is a change.
          () => {
            picker.value = "";
          },
        );
      },
      true,
    );
  }

  /** @returns {boolean} whether a page change must ask first, or say why it can't */
  function mustAsk() {
    return locked || (signed && !signedChangesAllowed);
  }

  /**
   * @param {Event} event
   * @param {string} selector
   * @returns {any} the event's target, or its closest ancestor, that matches
   *   `selector`, or null
   */
  function targetIn({ target }, selector) {
    return /** @type {any} */ (target)?.closest?.(selector) ?? null;
  }

  /**
   * Whether a key in the thumbnails changes pages, as pdf.js's keydown
   * listener in web/pdf_thumbnail_viewer.js decides: Copy, Cut and Delete,
   * with pages checked.
   *
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  function isPageChangeKey(event) {
    const { key, ctrlKey, metaKey } = event;
    const deletion = key === "Delete" || key === "Backspace";
    const copyOrCut = (key === "c" || key === "x") && (ctrlKey || metaKey);
    return (
      (deletion || copyOrCut) &&
      targetIn(event, THUMBNAILS) !== null &&
      document.querySelector(CHECKED_THUMBNAIL) !== null
    );
  }

  /**
   * Holds back an event that would change the pages, asks, then repeats it
   * if the user agrees.
   *
   * @param {any} app
   * @param {Event} event
   * @param {() => void} repeat
   * @param {() => void} [drop] when the user doesn't agree, or can't
   */
  function holdBack(app, event, repeat, drop = () => {}) {
    event.stopPropagation();
    event.preventDefault();
    askToChangePages(app).then((agreed) => (agreed ? repeat() : drop()));
  }

  /**
   * Asks once a press on a thumbnail turns into a drag, as far as pdf.js
   * counts it as one. A press that doesn't is a click, which goes to the page.
   *
   * @param {any} app
   * @param {PointerEvent} press
   */
  function askOnceDragged(app, { pointerId, clientX, clientY }) {
    const controller = new AbortController();
    const { signal } = controller;
    window.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== pointerId) return;
        const dx = Math.abs(event.clientX - clientX);
        const dy = Math.abs(event.clientY - clientY);
        if (dx <= DRAG_THRESHOLD && dy <= DRAG_THRESHOLD) return;
        controller.abort();
        askToChangePages(app);
      },
      { capture: true, signal },
    );
    for (const type of ["pointerup", "pointercancel"]) {
      window.addEventListener(
        type,
        (event) => {
          if (event.pointerId === pointerId) controller.abort();
        },
        { capture: true, signal },
      );
    }
  }

  /**
   * confirmPageChange(), unless it's already asking.
   *
   * @param {any} app
   * @returns {Promise<boolean>} whether the pages may change
   */
  function askToChangePages(app) {
    asking ??= confirmPageChange(app)
      .catch((error) => {
        console.error("Couldn't check whether the pages may change:", error);
        return false;
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  }

  /** @returns {Promise<any>} @cantoo/pdf-lib, loaded the first time it's needed */
  function loadPdfLib() {
    pdfLib ??= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PDF_LIB_URL;
      script.onload = () => resolve(window.PDFLib);
      script.onerror = () => {
        pdfLib = null;
        reject(new Error(`Couldn't load ${PDF_LIB_URL}`));
      };
      document.head.append(script);
    });
    return pdfLib;
  }

  /**
   * Adds Insert Blank Page to the toolbar, at the end of the editing tools.
   *
   * @param {any} app
   * @returns {HTMLButtonElement | null}
   */
  function addInsertButton(app) {
    const separator = document.getElementById("editorModeSeparator");
    if (!separator) return null;
    const button = makeButton("pdflionInsertBlankPage", "toolbarButton", "Insert Blank Page");
    button.disabled = true;
    button.addEventListener("click", () => insertBlankPage(app));
    separator.before(button);
    return button;
  }

  /**
   * Adds Page Overview to the toolbar, right of the sidebar's button.
   *
   * @param {any} app
   * @returns {HTMLButtonElement | null}
   */
  function addOverviewButton(app) {
    const sidebarButton = document.getElementById("viewsManagerToggleButton");
    if (!sidebarButton) return null;
    const button = makeButton("pdflionPageOverview", "toolbarButton", "Page Overview");
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => toggleOverview(app));
    sidebarButton.after(button);
    return button;
  }

  /**
   * Adds the overview's own page tools to the views manager's header, before
   * pdf.js's Add file: Rotate Pages Left and Right, and Insert Blank Page.
   * overrides.css shows them in the overview only, and not for a locked
   * document.
   *
   * @param {any} app
   * @returns {HTMLButtonElement[]} the buttons
   */
  function addOverviewTools(app) {
    const addFile = document.getElementById("viewsManagerAddFileButton");
    if (!addFile) return [];
    const tools = document.createElement("div");
    tools.id = "pdflionPageTools";
    const className = "toolbarButton viewsManagerButton";
    const rotateLeft = makeButton("pdflionRotatePagesLeft", className, "Rotate Pages Left");
    rotateLeft.addEventListener("click", () => rotatePages(app, -90));
    const rotateRight = makeButton("pdflionRotatePagesRight", className, "Rotate Pages Right");
    rotateRight.addEventListener("click", () => rotatePages(app, 90));
    const insert = makeButton("pdflionOverviewInsertBlankPage", className, "Insert Blank Page");
    insert.addEventListener("click", () => insertBlankPage(app));
    const buttons = [rotateLeft, rotateRight, insert];
    for (const button of buttons) button.disabled = true;
    tools.append(...buttons);
    addFile.before(tools);
    return buttons;
  }

  /**
   * A button built like pdf.js's own. overrides.css draws its icon. Its label
   * is English, like the native menus.
   *
   * @param {string} id
   * @param {string} className
   * @param {string} label
   * @returns {HTMLButtonElement}
   */
  function makeButton(id, className, label) {
    const button = document.createElement("button");
    button.id = id;
    button.className = className;
    button.type = "button";
    button.tabIndex = 0;
    button.title = label;
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    return button;
  }

  /**
   * The buttons that change pages work once a document has loaded, while
   * nothing else runs, and for documents that aren't locked.
   *
   * @param {any} app
   */
  function updatePageButtons(app) {
    for (const button of pageButtons) button.disabled = busy || locked || !app.pdfDocument;
  }

  /**
   * The page overview shows the document's pages as a grid of thumbnails
   * across the viewer area, with pdf.js's page tools. It's pdf.js's views
   * manager on its thumbnails, which overrides.css spreads out while
   * #outerContainer has `pdflionPageOverview`. Closing it shows the sidebar
   * as it was.
   *
   * @param {any} app
   * @returns {boolean} whether the overview is open now
   */
  function toggleOverview(app) {
    if (overview) closeOverview(app);
    else openOverview(app);
    return overview;
  }

  /** @param {any} app */
  function openOverview(app) {
    const { viewsManager } = app;
    if (overview || !viewsManager) return;
    viewBeforeOverview = viewsManager.visibleView;
    showOverview(true);
    viewsManager.switchView(SIDEBAR_THUMBS, /* forceOpen = */ true);
    relayoutThumbnails(app);
    // The arrow keys then go from page to page.
    document.querySelector(CURRENT_THUMBNAIL)?.focus();
  }

  /**
   * Closes the overview, and shows the sidebar as it was before, unless pdf.js
   * has closed the views manager meanwhile.
   *
   * @param {any} app
   */
  function closeOverview(app) {
    const { viewsManager, pdfViewer } = app;
    if (!overview) return;
    const focused = document.getElementById("viewsManager")?.contains(document.activeElement);
    showOverview(false);
    if (viewsManager.visibleView === SIDEBAR_THUMBS) {
      // While the thumbnails still show, in the sidebar.
      relayoutThumbnails(app);
      if (viewBeforeOverview === SIDEBAR_NONE) viewsManager.close();
      else viewsManager.switchView(viewBeforeOverview);
    }
    if (focused) pdfViewer.focus();
  }

  /**
   * Shows whether the overview is open: on #outerContainer, for
   * overrides.css, and on its toolbar button.
   *
   * @param {boolean} open
   */
  function showOverview(open) {
    overview = open;
    document.getElementById("outerContainer")?.classList.toggle("pdflionPageOverview", open);
    overviewButton?.classList.toggle("toggled", open);
    overviewButton?.setAttribute("aria-pressed", String(open));
  }

  /**
   * Keeps the overview in step with pdf.js and the window:
   * - pdf.js's sidebar button and F4 close the views manager, and the
   *   overview with it. reopen() leaves the overview open.
   * - the document stays where it was behind the overview
   * - Esc closes it, unless pdf.js's own Esc did something: closing a menu
   *   or the find bar, or cancelling a drag of pages
   * - a double-click on a page closes it, showing that page
   * - the window resizing moves the thumbnails
   *
   * @param {any} app
   */
  function followOverview(app) {
    const { eventBus, viewsManager } = app;
    if (!viewsManager) return;
    eventBus.on("sidebarviewchanged", (/** @type {{ view: number }} */ { view }) => {
      if (overview && !reopening && view !== SIDEBAR_THUMBS) showOverview(false);
    });
    // pdf.js moves the document aside by the views manager's width, which
    // onResizing() sets as the views manager resizes. The overview covers it
    // instead, so the document keeps its place and its zoom.
    const { onResizing } = viewsManager;
    viewsManager.onResizing = function (/** @type {number} */ width) {
      if (!overview) onResizing.call(this, width);
    };
    // After pdf.js's own listener, which prevents the default of what it
    // handles. This one does too, so the eraser stays on.
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !overview || event.defaultPrevented) return;
      if (document.querySelector(DRAGGING_PAGES)) return;
      closeOverview(app);
      event.preventDefault();
    });
    window.addEventListener("dblclick", (event) => {
      // The first click went to the page.
      if (overview && targetIn(event, THUMBNAIL_IMAGE)) closeOverview(app);
    });
    window.addEventListener("resize", () => {
      if (overview) relayoutThumbnails(app);
    });
  }

  /**
   * pdf.js works out where the thumbnails are, for dragging pages, when the
   * views manager says it has resized (web/pdf_thumbnail_viewer.js). They move
   * when the overview opens or closes, or the window resizes while it's open.
   *
   * @param {any} app
   */
  function relayoutThumbnails(app) {
    app.eventBus.dispatch("resize", { source: app.viewsManager });
  }

  /** @returns {number[]} the pages checked in the thumbnails, in order */
  function checkedPages() {
    const pages = [...document.querySelectorAll(CHECKED_THUMBNAIL)].map((checkbox) =>
      Number(checkbox.parentElement?.getAttribute("page-number")),
    );
    return pages.filter(Number.isInteger).sort((a, b) => a - b);
  }

  /**
   * Checks a page's thumbnail with a click, as the user would, so that pdf.js
   * selects the page too.
   *
   * @param {number} number
   */
  function checkThumbnail(number) {
    const checkbox = document.querySelector(
      `${THUMBNAILS} > .thumbnail[page-number="${number}"] > input`,
    );
    if (checkbox && !checkbox.checked) checkbox.click();
  }

  /**
   * The eraser: a tool after Pencil that erases Pencil's drawings, the file's
   * ink annotations among them. It works in pdf.js's ink mode, where pdf.js
   * turns the file's ink annotations into editors, and while it's on it takes
   * the pointer events over pages before pdf.js would draw with them. In
   * Object mode it removes every drawing it touches, whole, and a drag is one
   * step to undo. Line mode isn't in yet.
   *
   * Adds it to the toolbar after Pencil, built like pdf.js's tools: a button,
   * and an option box that shows while it's on, with Line and Object and the
   * eraser's size. overrides.css draws them, and the circle that shows the
   * eraser on the page, since the pointer's own cursor can't grow as large.
   * The labels are English, like the native menus.
   *
   * @param {any} app
   * @returns {EraserTool | null}
   */
  function addEraserTool(app) {
    const pencil = document.getElementById("editorInk");
    const outerContainer = document.getElementById("outerContainer");
    if (!pencil || !outerContainer) return null;
    const button = makeButton("pdflionEditorEraserButton", "toolbarButton", "Eraser");
    button.disabled = true;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-controls", "pdflionEditorEraserParamsToolbar");
    button.addEventListener("click", () => {
      if (erasing) stopErasing(app, EDITOR_NONE);
      else startErasing(app);
    });

    /**
     * @param {"line" | "object"} mode
     * @param {string} text
     * @param {string} title
     */
    const modeChoice = (mode, text, title) => {
      const input = createElement("input", { type: "radio", name: "pdflionEraserMode", value: mode });
      input.addEventListener("change", () => storeEraser({ ...eraser, mode }));
      return { input, label: createElement("label", { className: "pdflionEraserMode", title }, input, text) };
    };
    const line = modeChoice("line", "Line", "Erases the parts of lines under it");
    // Line mode isn't in yet.
    line.input.disabled = true;
    const object = modeChoice("object", "Object", "Erases whole drawings");
    const size = createElement("input", {
      type: "range",
      id: "pdflionEraserSize",
      className: "editorParamsSlider",
      min: "2",
      max: "50",
      step: "1",
    });
    size.addEventListener("input", () => {
      eraser = { ...eraser, size: Number(size.value) };
    });
    size.addEventListener("change", () => storeEraser(eraser));

    const box = createElement(
      "div",
      {
        id: "pdflionEditorEraserParamsToolbar",
        className: "editorParamsToolbar hidden doorHangerRight",
      },
      createElement(
        "div",
        { className: "editorParamsToolbarContainer" },
        createElement(
          "div",
          { className: "editorParamsSetter", role: "radiogroup", ariaLabel: "Erase" },
          line.label,
          object.label,
        ),
        createElement(
          "div",
          { className: "editorParamsSetter" },
          createElement("label", {
            className: "editorParamsLabel",
            htmlFor: "pdflionEraserSize",
            textContent: "Size",
          }),
          size,
        ),
      ),
    );
    pencil.after(
      createElement(
        "div",
        { id: "pdflionEditorEraser", className: "toolbarButtonWithContainer" },
        button,
        box,
      ),
    );
    const cursor = createElement("div", { id: "pdflionEraserCursor", hidden: true });
    outerContainer.append(cursor);
    return { button, box, modes: { line: line.input, object: object.input }, size, cursor };
  }

  /**
   * Keeps the eraser in step with pdf.js, main and the user:
   * - its button works whenever pdf.js's tools do
   * - another tool turns it off. Pencil's button would turn ink mode off,
   *   since the eraser leaves pdf.js showing Pencil on, so it just stops
   *   erasing. Esc turns it off, unless pdf.js or the page overview used it.
   * - its settings are main's, the same in every tab
   * - a press on a page starts erasing, and the circle follows the pointer
   *
   * @param {any} app
   */
  function followEraser(app) {
    app.eventBus.on("annotationeditormodechanged", (/** @type {{ mode: number }} */ { mode }) => {
      if (eraserTool) eraserTool.button.disabled = mode === EDITOR_DISABLE;
      if (!erasing) return;
      if (mode === EDITOR_INK) hidePencil();
      else stopErasing(app);
    });
    window.pdflion.getToolSettings().then((settings) => {
      if (settings) showEraser(settings.eraser);
    });
    window.pdflion.onToolSettingsChange((settings) => showEraser(settings.eraser));
    window.addEventListener(
      "click",
      (event) => {
        if (!erasing || !targetIn(event, "#editorInkButton")) return;
        event.stopImmediatePropagation();
        stopErasing(app, EDITOR_INK);
      },
      true,
    );
    window.addEventListener("keydown", (event) => {
      if (erasing && event.key === "Escape" && !event.defaultPrevented) {
        stopErasing(app, EDITOR_NONE);
      }
    });
    const container = document.getElementById("viewerContainer");
    container?.addEventListener("pointerdown", (event) => startGesture(app, event), true);
    container?.addEventListener("pointermove", (event) => moveCursor(app, event));
    container?.addEventListener("pointerleave", () => {
      if (eraserTool) eraserTool.cursor.hidden = true;
    });
  }

  /**
   * Turns the eraser on, in pdf.js's ink mode. Strokes Pencil has just drawn
   * become a drawing first, so that the eraser can take them.
   *
   * @param {any} app
   */
  function startErasing(app) {
    const ui = uiManager(app);
    if (erasing || !ui) return;
    erasing = true;
    showErasing(true);
    if (app.pdfViewer.annotationEditorMode === EDITOR_INK) {
      commitDrawing(ui);
      hidePencil();
    } else {
      app.eventBus.dispatch("switchannotationeditormode", { source: null, mode: EDITOR_INK });
    }
  }

  /**
   * Turns the eraser off.
   *
   * @param {any} app
   * @param {number} [mode] pdf.js's tool from now on: none, after the eraser's
   *   button or Esc, or Pencil, whose ink mode stays. Without it, pdf.js has
   *   changed tools already.
   */
  function stopErasing(app, mode) {
    if (!erasing) return;
    endGesture(app);
    erasing = false;
    showErasing(false);
    if (mode === EDITOR_NONE) {
      app.eventBus.dispatch("switchannotationeditormode", { source: null, mode: EDITOR_NONE });
    } else if (mode === EDITOR_INK) {
      // pdf.js shows Pencil on again, with its option box.
      document.getElementById("editorInkButton")?.setAttribute("aria-expanded", "true");
    }
  }

  /** @param {boolean} on whether the eraser is on */
  function showErasing(on) {
    document.getElementById("outerContainer")?.classList.toggle("pdflionErasing", on);
    if (!eraserTool) return;
    const { button, box, cursor } = eraserTool;
    button.classList.toggle("toggled", on);
    button.setAttribute("aria-expanded", String(on));
    box.classList.toggle("hidden", !on);
    if (!on) cursor.hidden = true;
  }

  /**
   * pdf.js's ink mode shows Pencil on, with its option box open. While the
   * eraser is on, overrides.css shows them off, and this says so too.
   */
  function hidePencil() {
    document.getElementById("editorInkButton")?.setAttribute("aria-expanded", "false");
  }

  /**
   * Shows the eraser's settings, as main sends them.
   *
   * @param {EraserSettings} settings
   */
  function showEraser(settings) {
    eraser = settings;
    if (!eraserTool) return;
    // The eraser erases objects whatever the setting, until Line mode is in.
    eraserTool.modes.object.checked = true;
    eraserTool.size.value = String(settings.size);
  }

  /**
   * Has main keep the eraser's settings, which it sends every tab.
   *
   * @param {EraserSettings} settings
   */
  function storeEraser(settings) {
    eraser = settings;
    window.pdflion.setToolSettings({ eraser: settings });
  }

  /**
   * Starts a drag of the eraser on a page: pdf.js gets none of its pointer
   * events, so it neither draws nor selects drawings.
   *
   * @param {any} app
   * @param {PointerEvent} event
   */
  function startGesture(app, event) {
    if (!erasing || gesture || event.button !== 0 || !placeOf(app, event)) return;
    event.stopPropagation();
    event.preventDefault();
    const listening = new AbortController();
    gesture = { pointerId: event.pointerId, last: null, drawings: new Map(), erased: [], listening };
    const options = { capture: true, signal: listening.signal };
    window.addEventListener(
      "pointermove",
      (move) => {
        if (move.pointerId !== gesture?.pointerId) return;
        move.stopPropagation();
        moveCursor(app, move);
        eraseAlong(app, move);
      },
      options,
    );
    for (const type of ["pointerup", "pointercancel"]) {
      window.addEventListener(
        type,
        (end) => {
          if (/** @type {PointerEvent} */ (end).pointerId !== gesture?.pointerId) return;
          end.stopPropagation();
          endGesture(app);
        },
        options,
      );
    }
    eraseAlong(app, event);
  }

  /**
   * Ends a drag of the eraser, as one step to undo, as pdf.js's own Delete
   * is.
   *
   * @param {any} app
   */
  function endGesture(app) {
    if (!gesture) return;
    const { erased, listening } = gesture;
    listening.abort();
    gesture = null;
    const ui = uiManager(app);
    if (!ui || erased.length === 0) return;
    ui.addCommands({
      cmd: () => {
        for (const editor of erased) editor.remove();
      },
      undo: () => {
        for (const editor of erased) restoreEditor(ui, editor);
      },
      mustExec: false,
    });
  }

  /**
   * Erases where the eraser passed since the last pointer event, at points
   * half its size apart, so that a fast drag misses nothing.
   *
   * @param {any} app
   * @param {PointerEvent} event
   */
  function eraseAlong(app, event) {
    if (!gesture) return;
    const place = placeOf(app, event);
    const { last } = gesture;
    gesture.last = place;
    if (!place) return;
    const radius = eraser.size / 2;
    const from = last?.pageIndex === place.pageIndex ? last.point : place.point;
    const path = window.PDFLionGeometry.resample([...from, ...place.point], radius / 2);
    for (let i = 0; i < path.length; i += 2) {
      eraseDrawingsAt(app, place.pageIndex, [path[i], path[i + 1]], radius);
    }
  }

  /**
   * Removes the drawings on a page that the eraser touches, centred on a
   * point.
   *
   * @param {any} app
   * @param {number} pageIndex
   * @param {number[]} center in PDF coordinates
   * @param {number} radius
   */
  function eraseDrawingsAt(app, pageIndex, center, radius) {
    const ui = uiManager(app);
    if (!ui || !gesture) return;
    for (const editor of [...ui.getEditors(pageIndex)]) {
      const drawing = drawingOf(editor);
      if (!drawing || !touches(drawing, center, radius)) continue;
      editor.remove();
      gesture.erased.push(editor);
    }
  }

  /**
   * @param {any} editor
   * @returns {Drawing | null} its strokes, if it's Pencil's: not a free
   *   highlight, nor a signature, which are drawings too
   */
  function drawingOf(editor) {
    const drawings = /** @type {Gesture} */ (gesture).drawings;
    if (!drawings.has(editor)) {
      const data = editor.editorType === "ink" ? editor.serialize(true) : null;
      drawings.set(
        editor,
        data && {
          strokes: data.paths.points,
          thickness: data.thickness,
          box: boxAround(data.paths.points),
        },
      );
    }
    return drawings.get(editor) ?? null;
  }

  /**
   * @param {Drawing} drawing
   * @param {number[]} center
   * @param {number} radius
   * @returns {boolean} whether an eraser there touches the drawing's ink
   */
  function touches({ strokes, thickness, box: [x1, y1, x2, y2] }, center, radius) {
    const reach = radius + thickness / 2;
    const [x, y] = center;
    if (x < x1 - reach || x > x2 + reach || y < y1 - reach || y > y2 + reach) return false;
    return strokes.some((stroke) =>
      window.PDFLionGeometry.hitsStroke(stroke, center, radius, thickness),
    );
  }

  /**
   * @param {ArrayLike<number>[]} strokes
   * @returns {[number, number, number, number]} the smallest box around their points
   */
  function boxAround(strokes) {
    const box = /** @type {[number, number, number, number]} */ ([
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
    ]);
    for (const stroke of strokes) {
      for (let i = 0; i + 1 < stroke.length; i += 2) {
        box[0] = Math.min(box[0], stroke[i]);
        box[1] = Math.min(box[1], stroke[i + 1]);
        box[2] = Math.max(box[2], stroke[i]);
        box[3] = Math.max(box[3], stroke[i + 1]);
      }
    }
    return box;
  }

  /**
   * Puts a removed editor back, as pdf.js's own undo of Delete does
   * (`#addEditorToLayer` in src/display/editor/tools.js).
   *
   * @param {any} ui
   * @param {any} editor
   */
  function restoreEditor(ui, editor) {
    const layer = ui.getLayer(editor.pageIndex);
    if (layer) {
      layer.addOrRebuild(editor);
    } else {
      ui.addEditor(editor);
      ui.addToAnnotationStorage(editor);
    }
  }

  /**
   * Shows the eraser's circle where the pointer is, as large as the eraser at
   * the page's zoom, or hides it off the pages.
   *
   * @param {any} app
   * @param {PointerEvent} event
   */
  function moveCursor(app, event) {
    if (!erasing || !eraserTool) return;
    const { cursor } = eraserTool;
    const place = placeOf(app, event);
    cursor.hidden = !place;
    if (!place) return;
    const diameter = `${eraser.size * place.scale}px`;
    Object.assign(cursor.style, {
      width: diameter,
      height: diameter,
      left: `${event.clientX}px`,
      top: `${event.clientY}px`,
    });
  }

  /**
   * @param {any} app
   * @param {PointerEvent} event
   * @returns {{ pageIndex: number, point: number[], scale: number } | null}
   *   the page under the pointer, the pointer's place on it in PDF
   *   coordinates, and how many pixels a point is there, or null off the pages
   */
  function placeOf(app, { target, clientX, clientY }) {
    const div = /** @type {any} */ (target)?.closest?.("#viewerContainer .page[data-page-number]");
    if (!div) return null;
    const pageIndex = Number(div.dataset.pageNumber) - 1;
    const view = app.pdfViewer.getPageView(pageIndex);
    if (view?.div !== div || !view.viewport) return null;
    const { left, top } = div.getBoundingClientRect();
    const point = view.viewport.convertToPdfPoint(
      clientX - left - div.clientLeft,
      clientY - top - div.clientTop,
    );
    return { pageIndex, point, scale: view.viewport.scale };
  }

  /**
   * Ends Pencil's drawing session, which makes its strokes one drawing, and
   * unselects the drawings. pdf.js's unselectAll() only commits the session
   * when there is one, so it runs twice.
   *
   * @param {any} ui
   */
  function commitDrawing(ui) {
    ui.unselectAll();
    ui.unselectAll();
  }

  /**
   * Edit > Undo or Redo, for pdf.js's annotations, which Chromium's undo and
   * redo don't reach. They apply while a drawing tool is on, as pdf.js's own
   * ⌘Z and ⇧⌘Z do, and not while text is being typed, which is Chromium's to
   * undo.
   *
   * @param {any} app
   * @param {"undo" | "redo"} name
   * @returns {boolean} whether pdf.js took it
   */
  function editingAction(app, name) {
    const ui = uiManager(app);
    const mode = app.pdfViewer.annotationEditorMode;
    if (!ui || mode === EDITOR_NONE || mode === EDITOR_DISABLE) return false;
    if (ui.isEditorHandlingKeyboard || isTyping()) return false;
    app.eventBus.dispatch("editingaction", { source: null, name });
    return true;
  }

  /**
   * @returns {boolean} whether the focus is where text is typed, where pdf.js
   *   leaves ⌘Z to Chromium (`textInputChecker` in src/display/editor/tools.js)
   */
  function isTyping() {
    const element = /** @type {any} */ (document.activeElement);
    if (element?.isContentEditable || element?.tagName === "TEXTAREA") return true;
    return element?.tagName === "INPUT" && (element.type === "text" || element.type === "number");
  }

  /**
   * @param {any} app
   * @returns {any} pdf.js's AnnotationEditorUIManager, once a document has
   *   loaded, as web/app.js reaches it
   */
  function uiManager(app) {
    return app.pdfViewer?._layerProperties?.annotationEditorUIManager ?? null;
  }

  /**
   * @param {string} tagName
   * @param {object} [properties]
   * @param {(Node | string)[]} children
   * @returns {any} a new element
   */
  function createElement(tagName, properties = {}, ...children) {
    const element = Object.assign(document.createElement(tagName), properties);
    element.append(...children);
    return element;
  }

  /**
   * Points pdf.js at the document's URL after Save As, so the title and
   * Document Properties show the new file name. Titles it like
   * _initializeMetadata does on load: "PDF title - file name".
   *
   * @param {any} app
   * @param {string} url `/doc/<token>/<name>`
   */
  function showDocumentUrl(app, url) {
    app.setTitleUsingUrl(url, url);
    const pdfTitle = app._docTitle;
    if (pdfTitle) app.setTitle(`${pdfTitle} - ${app._title}`);
  }
})();
