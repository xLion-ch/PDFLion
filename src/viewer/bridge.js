/**
 * PDFLion's side of the viewer. protocol.js injects this classic script into
 * pdf.js's viewer.html, where it runs in the page's main world before the
 * viewer's module scripts.
 *
 * It is the only code that touches pdf.js internals (PDFViewerApplication, its
 * eventBus, AppOptions). They aren't a stable API, so every name here was
 * checked against pdf.js v6.4.299: web/app.js and web/app_options.js.
 */
"use strict";

(() => {
  /** `LinkTarget.BLANK` in web/pdf_link_service.js. */
  const LINK_TARGET_BLANK = 2;

  /** Whether the document has changes since it was opened or last saved. */
  let edited = false;

  /** Whether a save is under way. */
  let saving = false;

  /** Whether the document changed after a save under way took its bytes. */
  let editedWhileSaving = false;

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
  };

  // On macOS the page gets ⌘-key events before the native menu, and the menu
  // only gets the ones the page leaves unhandled. Capturing on window runs
  // before pdf.js's listeners, so these keys skip pdf.js and reach the menu.
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
      });

      const app = window.PDFViewerApplication;
      app.initializedPromise.then(() => {
        window.pdflion.onCommand((command) =>
          Object.hasOwn(COMMANDS, command) ? COMMANDS[command](app) : null,
        );
        app.eventBus.on("documentloaded", () => trackEdits(app.pdfDocument));
        hideChangesIndicator(app);
      });
    },
    { once: true },
  );

  /**
   * Whether a key is a shortcut of the native menu (src/main/menu.js) that
   * pdf.js also acts on: ⌘O, ⌘S, ⌘P, ⌘F, ⇧⌘F, ⌘+, ⌘=, ⌘− and ⌘0, in
   * web/app.js onKeyDown and web/pdf_print_service.js. pdf.js would open its
   * own file picker, download instead of saving, open Find on ⇧⌘F, and reset
   * the zoom after ⌘0.
   *
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  function isMenuShortcut({ key, metaKey, ctrlKey, altKey, shiftKey }) {
    if (!metaKey || ctrlKey || altKey) return false;
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
   * saveDocument() also clears the flag, as soon as it has the bytes and
   * before main has written them, so during a save save() decides instead.
   *
   * @param {any} pdfDocument
   */
  function trackEdits(pdfDocument) {
    const storage = pdfDocument.annotationStorage;
    const { onSetModified, onResetModified } = storage;
    edited = false;
    storage.onSetModified = () => {
      onSetModified?.();
      if (saving) editedWhileSaving = true;
      setEdited(true);
    };
    storage.onResetModified = () => {
      onResetModified?.();
      if (!saving) setEdited(false);
    };
  }

  /**
   * Reports unsaved changes to main, which shows them as the window's edited
   * dot and asks about them before the window closes.
   *
   * @param {boolean} value
   */
  function setEdited(value) {
    edited = value;
    window.pdflion.setEdited(value);
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
   * Saves the document with its form data and annotations. Like pdf.js's own
   * save, which downloads instead, it runs the PDF's WillSave and DidSave
   * scripts around it.
   *
   * @param {any} app
   * @param {(bytes: Uint8Array) => Promise<string | null>} write
   *   window.pdflion.save or saveAs
   * @returns {Promise<boolean>} whether the document was saved
   */
  async function save(app, write) {
    if (saving) return false;
    saving = true;
    editedWhileSaving = false;
    try {
      await app.pdfScriptingManager.dispatchWillSave();
      try {
        const { pdfDocument } = app;
        // Without form data or annotations there's nothing to add to the
        // original bytes, which is how pdf.js's own Download decides too.
        const bytes =
          pdfDocument.annotationStorage.size > 0
            ? await pdfDocument.saveDocument()
            : await pdfDocument.getData();
        const url = await write(bytes);
        if (!url) return false; // Still edited, whatever saveDocument() reported.
        setEdited(editedWhileSaving);
        if (url !== app.url) showDocumentUrl(app, url);
        return true;
      } finally {
        await app.pdfScriptingManager.dispatchDidSave();
      }
    } finally {
      saving = false;
    }
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
