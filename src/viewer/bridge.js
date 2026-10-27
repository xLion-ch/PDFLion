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
 * pagesMapper), src/display/annotation_storage.js, src/core/document.js (the
 * metadata flags), web/pdf_thumbnail_viewer.js (getStructuralChanges and
 * #mergeFiles), src/display/pages_mapper.js, web/pdf_viewer.js (pagesCount,
 * onPagesEdited), web/pdf_page_view.js (updatePageNumber),
 * web/views_manager.js and web/viewer.html (the toolbar and the views
 * manager's waiting bar).
 *
 * pdf.js's page tools move, copy and delete pages in the thumbnails, and add
 * pages from other files. Page changes that pdf.js can't make go through
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

  /** `AnnotationEditorPrefix` in src/shared/util.js: annotations made in the viewer. */
  const EDITOR_PREFIX = "pdfjs_internal_editor_";

  /** @cantoo/pdf-lib's browser build, which defines `window.PDFLib`. */
  const PDF_LIB_URL = "/lib/pdf-lib.min.js";

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

  /** @type {Promise<any> | null} @cantoo/pdf-lib, once loading it started */
  let pdfLib = null;

  /** @type {HTMLButtonElement | null} the toolbar's Insert Blank Page button */
  let insertButton = null;

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
    rotateLeft: (app) => app.rotatePages(-90),
    rotateRight: (app) => app.rotatePages(90),
    presentation: (app) => app.requestPresentationMode(),
    // An unchanged document is already saved.
    save: (app) => !edited || save(app, window.pdflion.save),
    saveAs: (app) => save(app, window.pdflion.saveAs),
    insertBlankPage: (app) => insertBlankPage(app),
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
      insertButton = addInsertButton(app);
      app.initializedPromise.then(() => {
        window.pdflion.onCommand((command) =>
          Object.hasOwn(COMMANDS, command) ? COMMANDS[command](app) : null,
        );
        app.eventBus.on("documentloaded", () => {
          trackEdits(app);
          checkLocked(app);
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
   * document as it is, edited.
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
    updateInsertButton(app);
    try {
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
      return true;
    } finally {
      busy = false;
      updateInsertButton(app);
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
    const keys = [...pdfDocument.annotationStorage].map(([key]) => key);
    if (!keys.some((key) => !key.startsWith(EDITOR_PREFIX))) return pageInfos;
    const saved = await pdfDocument.saveDocument();
    // Each gets its own copy, since posting them to the worker may detach them.
    return pageInfos.map((info) =>
      info.document === null ? { ...info, document: saved.slice() } : info,
    );
  }

  /**
   * Inserts an empty page after the current one, of the size the current page
   * is shown at, and goes to it. The page is added after the document's bytes,
   * as an incremental update, so everything the file holds stays as it was.
   *
   * @param {any} app
   * @returns {Promise<boolean>} whether the page was inserted
   */
  async function insertBlankPage(app) {
    if (busy || !app.pdfDocument) return false;
    busy = true;
    updateInsertButton(app);
    try {
      if (!(await confirmPageChange(app))) return false;
      const index = app.page; // right after the current page, counting from 0
      const { view, rotate } = app.pdfViewer.getPageView(index - 1).pdfPage;
      const [width, height] = [view[2] - view[0], view[3] - view[1]];
      // A page shown on its side, by its /Rotate, is as wide as it's tall.
      const size = rotate % 180 === 0 ? [width, height] : [height, width];
      return await changeDocument(app, index + 1, (bytes) =>
        updateDocument(bytes, (document) => document.insertPage(index, size)),
      );
    } finally {
      busy = false;
      updateInsertButton(app);
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
      updateInsertButton(app);
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
            app.pdfViewer.pagesCount + 1,
          );
        }
      } finally {
        busy = false;
        updateInsertButton(app);
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
   * @param {(document: any) => void} change given a PDFDocument
   * @returns {Promise<Uint8Array>} the changed document
   */
  async function updateDocument(bytes, change) {
    const { PDFDocument } = await loadPdfLib();
    // updateMetadata: false keeps the Info dictionary as it is, rather than
    // stamp pdf-lib as its producer.
    const document = await PDFDocument.load(bytes, {
      forIncrementalUpdate: true,
      updateMetadata: false,
    });
    change(document);
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
   * @param {number} [minPages]
   * @returns {Promise<boolean>} whether the document changed
   */
  async function changeDocument(app, page, change, minPages = 1) {
    const wasEdited = edited;
    // A failed open() forgets them.
    const { url, _docFilename: filename, page: pageBefore } = app;
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
      await reopen(app, changed, { page, url, filename });
      const { numPages } = app.pdfDocument;
      if (numPages < minPages) throw new Error(`The changed document has ${numPages} pages`);
      return true;
    } catch (error) {
      // Back to the bytes it had, which hold every change made so far.
      console.error("Couldn't open the changed document:", error);
      await reopen(app, bytes, { page: pageBefore, url, filename, edited: wasEdited }).catch(
        () => {},
      );
      await window.pdflion.pageDialog("failed");
      return false;
    }
  }

  /**
   * Replaces the document with new bytes in the same tab, as pdf.js's own
   * onSaveAndLoad() does, and keeps the view: the zoom, the rotation, the
   * scroll and spread modes and the sidebar, at `page`. The document keeps its
   * URL and file name, and counts as edited until it's saved.
   *
   * @param {any} app
   * @param {Uint8Array} bytes
   * @param {{ page: number, url: string, filename: string, edited?: boolean }} options
   */
  async function reopen(app, bytes, { page, url, filename, edited: isEdited = true }) {
    const { eventBus, pdfViewer, viewsManager } = app;
    const { currentScaleValue, pagesRotation, scrollMode, spreadMode } = pdfViewer;
    const sidebarView = viewsManager?.visibleView ?? 0; // `SidebarView.NONE`
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

  /** @param {any} app */
  async function checkLocked(app) {
    const { pdfDocument } = app;
    locked = true;
    updateInsertButton(app);
    try {
      const { info } = await pdfDocument.getMetadata();
      if (app.pdfDocument !== pdfDocument) return;
      locked = lockReason(pdfDocument, info) !== null;
    } catch (error) {
      console.warn("Couldn't read the document's metadata:", error);
    }
    updateInsertButton(app);
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
   * Adds Insert Blank Page to the toolbar, at the end of the editing tools,
   * built like pdf.js's own buttons. overrides.css draws its icon. Its label
   * is English, like the native menus.
   *
   * @param {any} app
   * @returns {HTMLButtonElement | null}
   */
  function addInsertButton(app) {
    const separator = document.getElementById("editorModeSeparator");
    if (!separator) return null;
    const button = document.createElement("button");
    button.id = "pdflionInsertBlankPage";
    button.className = "toolbarButton";
    button.type = "button";
    button.tabIndex = 0;
    button.title = "Insert Blank Page";
    button.disabled = true;
    const label = document.createElement("span");
    label.textContent = "Insert Blank Page";
    button.append(label);
    button.addEventListener("click", () => insertBlankPage(app));
    separator.before(button);
    return button;
  }

  /**
   * The button works once a document has loaded, while nothing else runs,
   * and for documents that aren't locked.
   *
   * @param {any} app
   */
  function updateInsertButton(app) {
    if (insertButton) insertButton.disabled = busy || locked || !app.pdfDocument;
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
