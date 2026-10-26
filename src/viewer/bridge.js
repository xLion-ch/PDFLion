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

  /**
   * Commands main sends from the menu, mapped to pdf.js calls.
   * @type {Record<string, (app: any) => unknown>}
   */
  const COMMANDS = {
    print: (app) => app.triggerPrinting(),
    zoomIn: (app) => app.zoomIn(),
    zoomOut: (app) => app.zoomOut(),
    zoomReset: (app) => app.zoomReset(),
    find: (app) => app.findBar?.open(),
    toggleSidebar: (app) => app.viewsManager?.toggle(),
    rotateLeft: (app) => app.rotatePages(-90),
    rotateRight: (app) => app.rotatePages(90),
    presentation: (app) => app.requestPresentationMode(),
    save: (app) => save(app),
  };

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
        window.pdflion.onCommand((command) => {
          if (Object.hasOwn(COMMANDS, command)) COMMANDS[command](app);
        });
        app.eventBus.on("documentloaded", () => trackEdits(app.pdfDocument));
      });
    },
    { once: true },
  );

  /**
   * Reports unsaved changes to main, which shows them as the window's edited
   * dot. pdf.js installs its own callbacks before `documentloaded`, so wrap
   * them rather than replace them.
   *
   * @param {any} pdfDocument
   */
  function trackEdits(pdfDocument) {
    const storage = pdfDocument.annotationStorage;
    const { onSetModified, onResetModified } = storage;
    storage.onSetModified = () => {
      onSetModified?.();
      window.pdflion.setEdited(true);
    };
    storage.onResetModified = () => {
      onResetModified?.();
      window.pdflion.setEdited(false);
    };
  }

  /**
   * Saves the document with its form data and annotations. Like pdf.js's own
   * save, which downloads instead, it runs the PDF's WillSave and DidSave
   * scripts around it.
   *
   * @param {any} app
   */
  async function save(app) {
    await app.pdfScriptingManager.dispatchWillSave();
    try {
      const bytes = await app.pdfDocument.saveDocument();
      await window.pdflion.save(bytes);
    } finally {
      await app.pdfScriptingManager.dispatchDidSave();
    }
  }
})();
