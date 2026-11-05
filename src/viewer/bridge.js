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
 * toolbar, the drawing tools' option boxes, and the views manager's header,
 * Manage menu, Add file and waiting bar); for favourites
 * web/annotation_editor_params.js and src/display/editor/color_picker.js
 * (what the option boxes show), src/display/editor/tools.js (updateMode,
 * updateParams), src/display/editor/draw.js (updateDefaultParams),
 * src/shared/util.js (the editor and parameter types) and web/viewer.css (the
 * toolbar's groups, and the steps it takes as a window narrows); for a pen's
 * eraser end src/display/editor/tools.js (updateMode enables the layers
 * before web/pdf_viewer.js dispatches annotationeditormodechanged) and
 * src/display/editor/annotation_editor_layer.js (presses other than button 0
 * draw nothing); for Home's thumbnails src/display/api.js (getPage,
 * getViewport, and render's annotationMode and background) and
 * web/base_pdf_page_view.js (pagerendered); for pen-only drawing
 * src/display/editor/annotation_editor_layer.js (where presses reach the
 * layers), src/display/editor/draw.js (startDrawing, which cancels a pen's
 * touchmoves and ignores a pointer of another type),
 * src/display/touch_manager.js (pinching follows touch events on window) and
 * web/text_layer_builder.css (Highlight's touch-action).
 *
 * pdf.js's page tools move, copy and delete pages in the thumbnails, and add
 * pages from other files. The page overview shows those thumbnails across the
 * viewer area. Page changes that pdf.js can't make go through
 * @cantoo/pdf-lib, which protocol.js serves at /lib/ and this script loads the
 * first time it's needed. It changes a document as an incremental update,
 * after its bytes.
 *
 * It works out /lib/ and /doc/ from where the viewer is, at /viewer/web/, so
 * that it works below another path than the origin's root too.
 *
 * The host, which gives it `window.pdflion`, is the desktop's preload, or the
 * web app's src/web/viewer-host.js, in a frame of the web app's shell. What
 * the host offers decides what it adds: Share and the "not in Files" status
 * for `share` and `onSaveStatus`, Open…, New and About in the ⋮ menu for
 * `showOpenPanel`, `newDocument` and `showAbout`, and Undo and Redo buttons
 * without `nativeMenu`. With
 * `autosave`, it saves by itself, after changes and when the page is hidden.
 * A host's `closeMenu` closes the menu a long press opened, once its
 * favourite is dragged. A host's `setView` hears where the document is
 * shown, so that it can show it there again, as the web app does after a
 * tab slept or the app was ended.
 */
"use strict";

(() => {
  /**
   * PDFLion's texts (src/shared/texts.js, which the host page loads first),
   * in the language pdf.js picks for the viewer too.
   */
  const t = /** @type {any} */ (globalThis).PDFLionTexts.translator(navigator.languages);

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

  /** `ScrollMode.PAGE` in web/ui_utils.js: one page at a time. */
  const SCROLL_MODE_PAGE = 3;

  /**
   * A finger's swipe that turns a page in Page Scrolling: at least this far
   * across, in CSS pixels, and at most this long, in ms.
   */
  const SWIPE_DISTANCE = 50;
  const SWIPE_TIME = 800;

  /** `AnnotationEditorType.HIGHLIGHT` in src/shared/util.js. */
  const EDITOR_HIGHLIGHT = 9;

  /**
   * The tools in which only a pen draws while pen-only drawing is on, and
   * fingers scroll and zoom: Pencil, whose ink mode the eraser is in too,
   * and Highlight.
   */
  const PEN_TOOLS = new Set([EDITOR_INK, EDITOR_HIGHLIGHT]);

  /**
   * `AnnotationEditorParamsType.DRAW_STEP` in src/shared/util.js: a stroke
   * added to Pencil's open drawing, which becomes an annotation only once the
   * drawing ends (endDrawing() in src/display/editor/draw.js).
   */
  const DRAW_STEP = 41;

  /**
   * A page's editing layer while a stroke is being drawn on it
   * (toggleDrawing() in src/display/editor/annotation_editor_layer.js).
   */
  const DRAWING_LAYER = ".annotationEditorLayer.drawing";

  /**
   * A pen's eraser end, as Pointer Events number its button: a press with it
   * is a `pen` pointer's, with `button` 5.
   */
  const PEN_ERASER_BUTTON = 5;

  /**
   * A long press with a finger or a pen, which opens a favourite's menu, as
   * iPadOS sends no contextmenu for one: this long, in ms, moving at most
   * this far, in CSS pixels.
   */
  const LONG_PRESS_TIME = 500;
  const LONG_PRESS_SLOP = 10;

  /** A page of the document, as pdf.js shows it. */
  const PAGE = "#viewerContainer .page[data-page-number]";

  /** @cantoo/pdf-lib's browser build, which defines `window.PDFLib`. */
  const PDF_LIB_URL = new URL("../../lib/pdf-lib.min.js", location.href).href;

  /** Where main serves opened documents: `/doc/<token>/<name>`. */
  const DOCUMENTS_PATH = new URL("../../doc/", location.href).pathname;

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

  /**
   * @typedef {object} FavouriteTool a drawing tool that has favourites
   * @property {string} name in the ids of its button and option box in
   *   web/viewer.html, such as `#editor<name>ParamsToolbar`
   * @property {string} label in PDFLion's language
   * @property {number} mode its `AnnotationEditorType` in src/shared/util.js
   * @property {Record<string, number>} params the `AnnotationEditorParamsType`
   *   there of each of its settings
   */

  /** @type {Record<string, FavouriteTool>} by pdf.js's name for each */
  const FAVOURITE_TOOLS = {
    highlight: {
      name: "Highlight",
      label: t("highlight"),
      mode: EDITOR_HIGHLIGHT,
      params: { color: 31, thickness: 32 },
    },
    freetext: { name: "FreeText", label: t("text"), mode: 3, params: { color: 12, size: 11 } },
    ink: {
      name: "Ink",
      label: t("pencil"),
      mode: EDITOR_INK,
      params: { color: 21, thickness: 22, opacity: 23 },
    },
  };

  /** The drag data type of a favourite dragged to another place among them. */
  const FAVOURITE_DRAG_TYPE = "application/x-pdflion-favourite";

  /**
   * The toolbar's steps for narrower windows, as classes of #toolbarContainer
   * that overrides.css styles: 32 px buttons, then pdf.js's medium view,
   * which hides Print, its small view, which hides the previous and next page
   * buttons, its hidden zoom menu, and the drawing tools in one button with
   * a menu.
   * Then, narrower than a desktop window gets, Find, Page Overview and Insert
   * Blank Page go into the ⋮ menu, the zoom buttons and the status go, and
   * last Undo and Redo go into the tools' menu. Each step keeps those before
   * it. layoutToolbar() takes the first at which the toolbar fits.
   */
  const TOOLBAR_STEPS = [
    "pdflionToolbarCompact",
    "pdflionToolbarMedium",
    "pdflionToolbarSmall",
    "pdflionToolbarNarrow",
    "pdflionToolbarTools",
    "pdflionToolbarTiny",
    "pdflionToolbarWithoutZoom",
    "pdflionToolbarMinimal",
  ];

  /**
   * pdf.js's own steps, by the widths at which web/viewer.css takes them, as
   * how many of TOOLBAR_STEPS they amount to, the narrowest first.
   * @type {[string, number][]}
   */
  const PDFJS_STEPS = [
    ["(max-width: 560px)", 4],
    ["(max-width: 690px)", 3],
    ["(max-width: 750px)", 2],
  ];

  /**
   * Home's thumbnail of a document: its first page, fitting this many CSS
   * pixels at the screen's pixel ratio, and at most THUMBNAIL_MAX_PIXELS each
   * way and THUMBNAIL_MAX_BYTES, as src/shared/thumbnail.js checks it.
   */
  const THUMBNAIL_BOX = { width: 180, height: 240 };
  const THUMBNAIL_MAX_PIXELS = 512;
  const THUMBNAIL_MAX_BYTES = 256 * 1024;

  /**
   * `AnnotationMode.ENABLE_STORAGE` in src/shared/util.js: form values and
   * annotations as they are.
   */
  const ANNOTATIONS_AS_THEY_ARE = 3;

  /** The step of pdf.js's medium view, from which all favourites are in the ★ menu. */
  const MEDIUM_STEP = 2;

  /** The swatch Highlight's colour picker shows as chosen (src/display/editor/color_picker.js). */
  const HIGHLIGHT_SWATCH = '#editorHighlightColorPicker [role="option"][aria-selected="true"]';

  /** Save as Favourite's label, and for how long it says what a click did instead, in ms. */
  const SAVE_FAVOURITE = t("saveAsFavourite");
  const FAVOURITE_NOTE_TIME = 2000;

  /**
   * How long autosave waits after the last change to form values or
   * annotations, in ms: longer for larger documents, since each save writes
   * the whole file, by AUTOSAVE_DELAY_PER_10_MB for every 10 MB, up to
   * AUTOSAVE_MAX_DELAY.
   */
  const AUTOSAVE_DELAY = 2000;
  const AUTOSAVE_DELAY_PER_10_MB = 1000;
  const AUTOSAVE_MAX_DELAY = 30_000;

  /**
   * How long autosave waits after the last change with pdf.js's page tools,
   * in ms. Saving them reopens the document, which ends their undo.
   */
  const PAGE_CHANGES_DELAY = 30_000;

  /** pdf.js's bar that offers to undo a page change (web/viewer.html). */
  const UNDO_BAR = "viewsManagerStatusUndo";

  /** How often the host hears where the document is shown, at most, in ms. */
  const VIEW_INTERVAL = 500;

  /**
   * Whether shortcuts use ⌘, as on macOS and iPad keyboards, rather than
   * Ctrl, as on Windows and Linux, whose menus also have F4.
   */
  const usesCommandKey = window.pdflion.commandKey === "meta";

  /**
   * Whether a native menu has the shortcuts that pdf.js also binds, as on
   * the desktop. The web app has none, so pdf.js keeps them there, and the
   * toolbar gets Undo and Redo.
   */
  const hasNativeMenu = window.pdflion.nativeMenu !== false;

  /** Whether the document saves by itself, as in the web app, rather than with Save. */
  const autosaves = window.pdflion.autosave === true;

  /**
   * Whether the document has changes since it was opened or last saved, as
   * main last heard it. updateEdited() works it out.
   */
  let edited = false;

  /** Whether pdf.js's annotation storage has changes: form values, annotations. */
  let storageEdited = false;

  /** Whether a page change reopened the document from bytes that aren't saved yet. */
  let reopenedEdited = false;

  /** Whether the document was saved since it was opened, with its annotations. */
  let savedSinceOpened = false;

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
   * @typedef {object} Drawing a Pencil drawing or a highlight a drag of the
   *   eraser came to, read once
   * @property {any} editor the editor it was
   * @property {boolean} highlight whether it's a highlight, which the eraser
   *   erases whole, also in Line mode
   * @property {ArrayLike<number>[]} quads a text highlight's boxes, as x1, y1,
   *   x2, y2 in PDF coordinates, and none for a drawing
   * @property {any} data what `editor.serialize(true)` gave: its colour,
   *   opacity, rotation and place, for what replaces it
   * @property {ArrayLike<number>[]} strokes as the eraser has left them, x, y
   *   pairs in PDF coordinates
   * @property {number} thickness
   * @property {[number, number, number, number]} box around the strokes'
   *   points as they were
   * @property {any[]} shown the editors on the page for it: the drawing's
   *   own, or one for each stroke left of it, which is a drawing of its own
   *   from then on, or none once it's erased
   * @property {boolean} cut whether its strokes changed since `shown` was built
   */

  /**
   * @typedef {object} Gesture a drag of the eraser
   * @property {number} pointerId
   * @property {"line" | "object"} mode
   * @property {{ pageIndex: number, point: number[] } | null} last where the
   *   eraser last was on a page
   * @property {Map<any, Drawing | null>} drawings each editor the drag found,
   *   and its drawing if it's Pencil's
   * @property {Map<any, Drawing>} replacements each editor built for a drawing,
   *   and that drawing
   * @property {boolean} redrawing whether a redraw waits for the next frame
   * @property {AbortController} listening for the drag's pointer events
   * @property {boolean} inPlace whether it's a pen's eraser end, erasing while
   *   another tool is on, which stays on
   */

  /** @type {Gesture | null} */
  let gesture = null;

  /**
   * The eraser's work, one step after the other: pdf.js builds editors
   * asynchronously, and a drag mustn't see a drawing while its replacement
   * is being built.
   */
  let erasingDone = Promise.resolve();

  /**
   * @typedef {object} Favourite a drawing tool with its settings, as main
   *   keeps them for every tab (src/shared/tools.js)
   * @property {"highlight" | "freetext" | "ink"} tool pdf.js's name for it
   * @property {string} color `#rrggbb`, in lower case
   * @property {number} [thickness] for highlight and ink
   * @property {number} [opacity] for ink
   * @property {number} [size] for freetext
   */

  /** @type {Favourite[] | null} as main last sent them, or null until it has */
  let favourites = null;

  /** Settles once main has first sent the tool settings: see followToolSettings(). */
  let toolSettingsLoaded = Promise.resolve();

  /**
   * @typedef {object} FavouritesBar what addFavouritesBar() adds to the toolbar
   * @property {HTMLElement} group the favourites' buttons, then the ★ menu's
   * @property {HTMLElement} separator after the group
   * @property {HTMLElement} more the ★ menu's button and the menu
   * @property {HTMLButtonElement} moreButton
   * @property {HTMLElement} items the menu's items' container
   * @property {() => void} closeMenu
   */

  /** @type {FavouritesBar | null} */
  let favouritesBar = null;

  /**
   * @type {{ favourite: Favourite, button: HTMLButtonElement, item: HTMLButtonElement }[]}
   *   each favourite, with its button in the toolbar and its item in the ★
   *   menu, of which layoutToolbar() shows one
   */
  let favouriteButtons = [];

  /** Whether pdf.js's drawing tools work, and the favourites with them. */
  let toolsEnabled = false;

  /**
   * The tool a favourite turned on, as an `AnnotationEditorType`, until
   * pdf.js has switched to it: its option box stays closed (useFavourite()).
   * @type {number | null}
   */
  let favouriteMode = null;

  /**
   * The favourite being dragged to another place among them, and where it
   * would go: before or after the favourite it's over.
   * @type {{ favourite: Favourite, over: HTMLElement | null, after: boolean } | null}
   */
  let favouriteDrag = null;

  /**
   * The favourite each of the favourites' buttons and ★ menu items stands
   * for, and whether it's an item of the ★ menu.
   * @type {WeakMap<Element, { favourite: Favourite, inMenu: boolean }>}
   */
  const favouriteOf = new WeakMap();

  /**
   * Which of DROPPABLE the file holds, once `droppable` has found out, for
   * deciding at once whether a page change must ask first.
   * @type {Set<string>}
   */
  let droppableHeld = new Set();

  /** The document's size in bytes, as loaded or last saved, for autosave's delay. */
  let documentSize = 0;

  /** @type {ReturnType<typeof setTimeout> | null} the next autosave */
  let autosaveTimer = null;

  /** @type {HTMLButtonElement[]} Undo and Redo, while a drawing tool is on */
  let undoButtons = [];

  /**
   * Whether only a pen draws in PEN_TOOLS, while fingers scroll and zoom, and
   * whether that was ever chosen, as main keeps them: see followPen().
   */
  let penOnly = false;
  let penOnlyChosen = false;

  /** @type {HTMLButtonElement | null} pen-only drawing's item in the ⋮ menu */
  let penOnlyItem = null;

  /**
   * The pointer of the pen that's down on a page with one of PEN_TOOLS on,
   * or its eraser end with any tool, while it is.
   * @type {number | null}
   */
  let penDown = null;

  /**
   * @typedef {object} ToolsMenu what addToolsMenu() adds: one button for the
   *   drawing tools, which shows the one that's on, with a menu of them
   * @property {HTMLButtonElement} button
   * @property {HTMLElement} items the menu's items' container
   * @property {() => void} closeMenu
   */

  /** @type {ToolsMenu | null} */
  let toolsMenu = null;

  /**
   * @typedef {object} ZoomMenu what addZoomMenu() adds in place of pdf.js's
   *   zoom select: a narrow button, which shows the zoom's icon or its
   *   percentage, with a menu of the select's choices
   * @property {HTMLButtonElement} button
   * @property {HTMLElement} items the menu's items' container
   */

  /** @type {ZoomMenu | null} */
  let zoomMenu = null;

  /** The zoom select's named choices, which the zoom button shows as icons. */
  const ZOOM_NAMES = ["auto", "page-actual", "page-fit", "page-width"];

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
    // As its button, which works only while pdf.js's tools do.
    eraser: (app) => (eraserTool && !eraserTool.button.disabled ? toggleEraser(app) : false),
    // Edit > Undo and Redo. False leaves them to Chromium, which main asks next.
    undo: (app) => editingAction(app, "undo"),
    redo: (app) => editingAction(app, "redo"),
    // The web app's: Share, and saving at once, as before a tab closes.
    share: (app) => share(app),
    saveNow: (app) => saveNow(app),
  };

  // The page gets key events before the native menu, on macOS and Windows
  // alike, and the menu only gets the ones the page leaves unhandled.
  // Capturing on window runs before pdf.js's listeners, so these keys skip
  // pdf.js and reach the menu.
  window.addEventListener(
    "keydown",
    (event) => {
      if (hasNativeMenu && isMenuShortcut(event)) event.stopImmediatePropagation();
    },
    true,
  );

  // Dispatched once the viewer's scripts have loaded, before it initialises,
  // at the document of the page that embeds the viewer, if pdf.js can reach
  // it, as it can from the web app's frames, and else at the viewer's own
  // (web/viewer.js).
  document.addEventListener("webviewerloaded", onViewerLoaded, { once: true });
  const embedder = embeddingDocument();
  embedder?.addEventListener("webviewerloaded", onViewerLoaded);

  /**
   * @returns {Document | null} the document of the page the viewer is in,
   *   if it's in a frame of one it can reach
   */
  function embeddingDocument() {
    try {
      return window.parent && window.parent !== window ? window.parent.document : null;
    } catch {
      return null; // another origin's
    }
  }

  /** Whether the viewer has initialised. */
  let initialised = false;

  /**
   * @param {Event} [event] at the embedding page, from any of its frames'
   *   viewers, each of which names its window as the event's source
   */
  function onViewerLoaded(event) {
    const source = /** @type {CustomEvent | undefined} */ (event)?.detail?.source;
    if ((source && source !== window) || initialised) return;
    initialised = true;
    embedder?.removeEventListener("webviewerloaded", onViewerLoaded);
    initialise();
  }

  /** Sets pdf.js's options, and adds PDFLion's parts to the viewer. */
  function initialise() {
    window.PDFViewerApplicationOptions.setAll({
      // Otherwise preferences stored by pdf.js override the options below.
      disablePreferences: true,
      // Never open pdf.js's demo PDF.
      defaultUrl: "",
      // Links open in a new window, which main's setWindowOpenHandler vets,
      // or in the web app viewer-host.js.
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
    addSaveFavouriteButtons();
    favouritesBar = addFavouritesBar();
    undoButtons = addUndoButtons(app);
    toolsMenu = addToolsMenu(app);
    zoomMenu = addZoomMenu(app);
    addShareButtons(app);
    addSaveStatus(app);
    addAppMenuItems(app);
    // At the top, before Open… and New, below what the narrowest steps add.
    penOnlyItem = addPenOnlyItem(app);
    pageButtons.push(...addNarrowMenuItems(app));
    toolSettingsLoaded = followToolSettings(app);
    followToolbarWidth();
    guardPageTools(app);
    app.initializedPromise.then(() => {
      window.pdflion.onCommand((command) =>
        Object.hasOwn(COMMANDS, command) ? COMMANDS[command](app) : null,
      );
      // After pdf.js's own listeners, which come with the views manager.
      followOverview(app);
      // After the overview's, whose Esc comes first.
      followEraser(app);
      followPen(app);
      followPageTurns(app);
      followTrackpadPinch(app);
      followFavourites(app);
      followToolsMenu(app);
      followZoomMenu(app);
      followEditorChanges(app);
      followPencilStrokes(app);
      app.eventBus.on("documentloaded", () => {
        trackEdits(app);
        checkLocked(app);
        // A reopened document shows changes to the file, not the file.
        if (!reopening) {
          noteDroppable(app);
          thumbnailOnceShown(app);
        }
      });
      // Pages moved, copied or deleted in the thumbnails, or that change undone.
      app.eventBus.on("pagesedited", () => {
        if (busy) editedWhileSaving = true;
        updateEdited(app);
        recachePages(app);
      });
      hideChangesIndicator(app);
      if (!hasNativeMenu) followUndoButtons(app);
      if (autosaves) followAutosave(app);
      if (typeof window.pdflion.setView === "function") followView(app);
    });
  }

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
    return parsed?.origin === location.origin && parsed.pathname.startsWith(DOCUMENTS_PATH);
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

    documentSize = length;
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
    if (key === "F4") return !usesCommandKey && !metaKey && !ctrlKey && !altKey && !shiftKey;
    const [commandKey, otherKey] = usesCommandKey ? [metaKey, ctrlKey] : [ctrlKey, metaKey];
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
    if (!reopening) reopenedEdited = edited = savedSinceOpened = false;
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
    if (autosaves) scheduleAutosave(app);
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
    endPencilDrawing(app);
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
      documentSize = bytes.length;
      savedSinceOpened = true;
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
      sendThumbnail(app);
      return true;
    } finally {
      busy = false;
      updatePageButtons(app);
    }
  }

  /**
   * pdf.js's annotation storage counts as changed when an annotation joins
   * it, but not when one in it changes: a drawing moved or recoloured, or a
   * change undone or redone. Pencil's strokes join it only once its drawing
   * ends, when the user leaves it. Once the document is saved, all those
   * would go unsaved. Every such change goes through the editors' UI
   * manager, whose addCommands(), undo() and redo() this follows, for each
   * document's UI manager.
   *
   * @param {any} app
   */
  function followEditorChanges(app) {
    app.eventBus.on("annotationeditoruimanager", (/** @type {{ uiManager: any }} */ { uiManager: ui }) => {
      for (const name of ["addCommands", "undo", "redo"]) {
        const original = ui[name];
        if (typeof original !== "function") continue;
        ui[name] = function (/** @type {any[]} */ ...args) {
          const result = original.apply(this, args);
          editorChanged(app, name === "addCommands" && args[0]?.type === DRAW_STEP);
          return result;
        };
      }
    });
  }

  /**
   * An annotation changed. Before the first save, a document whose storage
   * is empty again, as after undoing every change, is as it was opened,
   * unless Pencil's drawing is open.
   *
   * @param {any} app
   * @param {boolean} stroke whether it's a stroke of Pencil's open drawing
   */
  function editorChanged(app, stroke) {
    const storage = app.pdfDocument?.annotationStorage;
    if (!storage || (!stroke && storage.size === 0 && !savedSinceOpened)) return;
    if (busy) editedWhileSaving = true;
    storageEdited = true;
    updateEdited(app);
  }

  /**
   * Makes each of Pencil's strokes a drawing of its own as it ends, rather
   * than a stroke of an open drawing that joins the annotations only once
   * another tool is chosen. So the eraser's Object mode erases a stroke
   * alone, and Undo and Redo take a stroke at a time, as pdf.js's own steps
   * of adding a drawing. pdf.js ends a stroke on a pointerup it listens for
   * on window from the stroke's start, after this listener, so the drawing
   * ends a task later, unless another stroke has started meanwhile, and
   * is left unselected, as overrides.css shows Pencil's drawings meanwhile.
   *
   * @param {any} app
   */
  function followPencilStrokes(app) {
    window.addEventListener("pointerup", () => {
      if (app.pdfViewer?.annotationEditorMode !== EDITOR_INK || erasing) return;
      setTimeout(() => {
        if (app.pdfViewer?.annotationEditorMode === EDITOR_INK && !isDrawing()) {
          endPencilDrawing(app);
          // pdf.js selects the new drawing, with its box and toolbar.
          uiManager(app)?.unselectAll();
        }
      }, 0);
    });
  }

  /**
   * Ends Pencil's open drawing, whose strokes join the annotations only
   * then, as unselectAll() does first, but without unselecting anything
   * (commitOrRemove() in src/display/editor/annotation_editor_layer.js).
   *
   * @param {any} app
   */
  function endPencilDrawing(app) {
    const ui = uiManager(app);
    if (!ui || !app.pdfDocument) return;
    for (let index = 0; index < app.pdfViewer.pagesCount; index++) {
      ui.getLayer(index)?.commitOrRemove();
    }
  }

  /**
   * Saves by itself, for a host that keeps the document, as the web app's
   * does: a while after each change (scheduleAutosave()), and at once when
   * the page is hidden, as when the app is left, since iPadOS may end it
   * then.
   *
   * @param {any} app
   */
  function followAutosave(app) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveNow(app);
    });
    window.addEventListener("pagehide", () => saveNow(app));
  }

  /**
   * Tells the host where the document is shown, at most every
   * VIEW_INTERVAL: the page, the zoom, and the point at the view's top left,
   * as pdf.js's location has them, which pdf.js shows a document at again
   * from its viewer's hash. Not before pdf.js has shown the document where
   * it opens, nor in Presentation Mode, whose zoom fits the screen.
   *
   * @param {any} app
   */
  function followView(app) {
    /** @type {any} pdf.js's last location */
    let location = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    app.eventBus.on("updateviewarea", (/** @type {any} */ event) => {
      if (!app.isInitialViewSet || app.pdfViewer.isInPresentationMode) return;
      location = event.location;
      timer ??= setTimeout(() => {
        timer = null;
        const { pageNumber, scale, left, top } = location;
        window.pdflion.setView({ page: pageNumber, zoom: scale, left, top });
      }, VIEW_INTERVAL);
    });
  }

  /**
   * Saves a while after the last change: after AUTOSAVE_DELAY for form
   * values, annotations and inserted or rotated pages, longer for larger
   * documents, and after PAGE_CHANGES_DELAY for changes with pdf.js's page
   * tools, which saving ends the undo of, and never while pdf.js offers to
   * undo one.
   *
   * @param {any} app
   */
  function scheduleAutosave(app) {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    autosaveTimer = null;
    if (!edited) return;
    const delay = hasPageChanges(app)
      ? PAGE_CHANGES_DELAY
      : Math.min(
          AUTOSAVE_MAX_DELAY,
          AUTOSAVE_DELAY + Math.floor(documentSize / 10_000_000) * AUTOSAVE_DELAY_PER_10_MB,
        );
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      // Not in the middle of a stroke, which saving would end.
      const later = (hasPageChanges(app) && isUndoBarShown()) || isDrawing();
      if (later) scheduleAutosave(app);
      else saveNow(app);
    }, delay);
  }

  /** @returns {boolean} whether a stroke is being drawn */
  function isDrawing() {
    return document.querySelector(DRAWING_LAYER) !== null;
  }

  /** @returns {boolean} whether pdf.js offers to undo a page change */
  function isUndoBarShown() {
    const bar = document.getElementById(UNDO_BAR);
    return !!bar && !bar.classList.contains("hidden");
  }

  /**
   * Saves the document now, if it has changes, as before its tab closes or
   * when the page is hidden. It waits for a save or a page change under way.
   *
   * @param {any} app
   * @returns {Promise<boolean>} whether the document is saved now
   */
  async function saveNow(app) {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    autosaveTimer = null;
    while (busy) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!edited || !app.pdfDocument) return true;
    return save(app, window.pdflion.save);
  }

  /**
   * Shares the document through the host, which shows the share sheet. It's
   * saved first, so that what's shared is what the host keeps, as it keeps
   * it. Only if that fails does the host get the document as it is here.
   *
   * @param {any} app
   * @returns {Promise<boolean>} whether it was shared
   */
  async function share(app) {
    if (!app.pdfDocument || typeof window.pdflion.share !== "function") return false;
    try {
      const saved = (await saveNow(app)) && !edited;
      return (await window.pdflion.share(saved ? null : await currentBytes(app))) === true;
    } catch (error) {
      console.error("Couldn't share the document:", error);
      return false;
    }
  }

  /**
   * Has Home's thumbnail made once the viewer has shown a page, so that it
   * doesn't hold up the first one.
   *
   * @param {any} app
   */
  function thumbnailOnceShown(app) {
    if (typeof window.pdflion.setThumbnail !== "function") return;
    const { pdfDocument } = app;
    app.eventBus.on(
      "pagerendered",
      () => {
        if (app.pdfDocument === pdfDocument) sendThumbnail(app);
      },
      { once: true },
    );
  }

  /**
   * Renders the first page for Home, as a PNG, with its form values and
   * annotations as they are, and hands it to the host, which keeps it for a
   * document with a file. A PNG too large to keep is rendered smaller.
   *
   * @param {any} app
   */
  async function sendThumbnail(app) {
    const { pdfDocument } = app;
    if (typeof window.pdflion.setThumbnail !== "function" || !pdfDocument) return;
    try {
      const page = await pdfDocument.getPage(1);
      const { width, height } = page.getViewport({ scale: 1 });
      const ratio = window.devicePixelRatio || 1;
      let scale = Math.min(
        Math.min(THUMBNAIL_BOX.width * ratio, THUMBNAIL_MAX_PIXELS) / width,
        Math.min(THUMBNAIL_BOX.height * ratio, THUMBNAIL_MAX_PIXELS) / height,
      );
      for (let attempt = 0; attempt < 3; attempt++, scale *= 0.7) {
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        // Rounded, not floored, since 612 × (180 / 612) is a hair under 180.
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
          annotationMode: ANNOTATIONS_AS_THEY_ARE,
          background: "white",
        }).promise;
        /** @type {Blob | null} */
        const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        // Another document may have come meanwhile.
        if (app.pdfDocument !== pdfDocument || !png) return;
        if (png.size <= THUMBNAIL_MAX_BYTES) {
          window.pdflion.setThumbnail(new Uint8Array(await png.arrayBuffer()));
          return;
        }
      }
    } catch (error) {
      console.warn("Couldn't make the thumbnail:", error);
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
    return askToDrop(newFile === "several" || (pageChanges && fromSeveralCopies(app)));
  }

  /**
   * Asks whether to drop what the file holds and a new file of its pages
   * won't, unless the user agreed to already.
   *
   * @param {boolean} several whether the new file is made of several
   * @returns {Promise<boolean>} whether to go ahead
   */
  async function askToDrop(several) {
    const items = toDrop(await droppable, several);
    if (items.length === 0) return true;
    if (!(await window.pdflion.pageDialog("rewrite", items))) return false;
    for (const item of items) dropAgreed.add(item);
    return true;
  }

  /**
   * @param {Set<string>} held which of DROPPABLE the file holds
   * @param {boolean} several whether the new file is made of several
   * @returns {string[]} what a new file would drop that the user hasn't
   *   agreed to lose yet
   */
  function toDrop(held, several) {
    return DROPPABLE.filter(
      (item) =>
        held.has(item) && !dropAgreed.has(item) && (several || !DROPPED_FROM_SEVERAL.has(item)),
    );
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
    const found = findDroppable(app.pdfDocument);
    droppable = found;
    droppableHeld = new Set();
    found.then((held) => {
      if (droppable === found) droppableHeld = held;
    });
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
   * shown at, and goes to it. From the thumbnails' header, in the sidebar or
   * the page overview, it goes after the last checked page, if any. The page is added after the document's bytes, as
   * an incremental update, so everything the file holds stays as it was.
   *
   * @param {any} app
   * @param {boolean} [fromThumbnails] whether the thumbnails' header asked
   * @returns {Promise<boolean>} whether the page was inserted
   */
  function insertBlankPage(app, fromThumbnails = false) {
    return runPageChange(app, () => {
      // The page to insert after, which is also the new page's index.
      const index = ((overview || fromThumbnails) && checkedPages().at(-1)) || app.page;
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
        if (await confirmPageChange(app, "several")) {
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
      documentSize = bytes.length;
      // open() resolves once pdf.js has the document, before it reads its
      // pages. pagesPromise rejects if it can't set them up, and then no
      // event comes. The page to show must load too.
      await Promise.all([shown, pdfViewer.pagesPromise, app.pdfDocument.getPage(page)]);
      pdfViewer.scrollMode = scrollMode;
      pdfViewer.spreadMode = spreadMode;
      // The overview may have opened meanwhile, which needs the thumbnails.
      const view = overview ? SIDEBAR_THUMBS : sidebarView;
      if (view) viewsManager.switchView(view, /* forceOpen = */ true);
      else viewsManager?.close();
      // pdf.js would drag pages to where the old document's thumbnails were.
      if (view === SIDEBAR_THUMBS) relayoutThumbnails(app);
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
   * can't. A signed document asks first, once. With autosave, a change with
   * pdf.js's page tools also asks first what saving it drops, since it saves
   * without asking (see confirmRewrite()).
   *
   * @param {any} app
   * @param {Rewrite} [rewrite] for a change with pdf.js's page tools, whose
   *   saving writes a new file
   * @returns {Promise<boolean>}
   */
  async function confirmPageChange(app, rewrite = null) {
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
    return !autosaves || !rewrite || askToDrop(rewrite === "several");
  }

  /**
   * @typedef {"one" | "several" | null} Rewrite the new file a change with
   *   pdf.js's page tools makes when it's saved: of the document alone, as
   *   for moving, copying and deleting pages, or of several, as for Add file
   */

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
        if (!locked && !mustAsk("one")) return;
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
        if (!thumbnails || !mustAsk("several")) return;
        // Only readable while the event is dispatched.
        const files = [...(event.dataTransfer?.files ?? [])];
        const { clientX, clientY } = event;
        holdBack(
          app,
          event,
          "several",
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
        if (item && mustAsk("one")) holdBack(app, event, "one", () => item.click());
      },
      true,
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (!isPageChangeKey(event) || !mustAsk("one")) return;
        const { target, key, code, ctrlKey, metaKey, altKey, shiftKey } = event;
        const init = { key, code, ctrlKey, metaKey, altKey, shiftKey };
        holdBack(app, event, "one", () =>
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
        if (!picker || !mustAsk("several")) return;
        holdBack(
          app,
          event,
          "several",
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

  /**
   * @param {Rewrite} rewrite
   * @returns {boolean} whether a change with pdf.js's page tools must ask
   *   first, or say why it can't
   */
  function mustAsk(rewrite) {
    return (
      locked ||
      (signed && !signedChangesAllowed) ||
      (autosaves && toDrop(droppableHeld, rewrite === "several").length > 0)
    );
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
   * @param {Rewrite} rewrite
   * @param {() => void} repeat
   * @param {() => void} [drop] when the user doesn't agree, or can't
   */
  function holdBack(app, event, rewrite, repeat, drop = () => {}) {
    event.stopPropagation();
    event.preventDefault();
    askToChangePages(app, rewrite).then((agreed) => (agreed ? repeat() : drop()));
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
        askToChangePages(app, "one");
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
   * @param {Rewrite} rewrite
   * @returns {Promise<boolean>} whether the pages may change
   */
  function askToChangePages(app, rewrite) {
    asking ??= confirmPageChange(app, rewrite)
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
    const button = makeButton("pdflionInsertBlankPage", "toolbarButton", t("insertBlankPage"));
    button.disabled = true;
    button.addEventListener("click", () => insertBlankPage(app));
    separator.before(button);
    return button;
  }

  /**
   * Adds Share, for a host that shares documents, where pdf.js's Download
   * button is, which overrides.css hides: in the toolbar, and in the ⋮ menu
   * from pdf.js's medium view on, as Download is.
   *
   * @param {any} app
   */
  function addShareButtons(app) {
    if (typeof window.pdflion.share !== "function") return;
    const download = document.getElementById("downloadButton");
    if (download) {
      const button = makeButton("pdflionShareButton", "toolbarButton", t("shareButton"));
      button.addEventListener("click", () => share(app));
      download.before(button);
    }
    const secondaryDownload = document.getElementById("secondaryDownload");
    if (secondaryDownload) {
      const item = makeButton("pdflionSecondaryShare", "toolbarButton labeled", t("share"));
      item.addEventListener("click", () => {
        app.secondaryToolbar?.close();
        share(app);
      });
      secondaryDownload.before(item);
    }
  }

  /**
   * Adds the status a host can show of the document, such as the web app's
   * "Not in Files", at the start of the toolbar's right group. A click
   * shares the document, which ends that status.
   *
   * @param {any} app
   */
  function addSaveStatus(app) {
    if (typeof window.pdflion.onSaveStatus !== "function") return;
    const right = document.getElementById("toolbarViewerRight");
    if (!right) return;
    const button = makeButton("pdflionSaveStatus", "toolbarButton", "");
    button.hidden = true;
    button.addEventListener("click", () => share(app));
    right.prepend(button);
    window.pdflion.onSaveStatus((/** @type {string | null} */ status) => {
      button.hidden = !status;
      /** @type {HTMLElement} */ (button.firstElementChild).textContent = status ?? "";
      button.title = status ? t("saveStatus", { status }) : "";
      layoutToolbar();
    });
  }

  /**
   * Adds Undo and Redo before the drawing tools, for a host without a native
   * menu, as on an iPad without a keyboard. They show while a drawing tool
   * is on, as Edit > Undo and Redo work for pdf.js then.
   *
   * @param {any} app
   * @returns {HTMLButtonElement[]}
   */
  function addUndoButtons(app) {
    const tools = document.getElementById("editorModeButtons");
    if (hasNativeMenu || !tools) return [];
    const undo = makeButton("pdflionUndo", "toolbarButton", t("undo"));
    const redo = makeButton("pdflionRedo", "toolbarButton", t("redo"));
    undo.addEventListener("click", () => editingAction(app, "undo"));
    redo.addEventListener("click", () => editingAction(app, "redo"));
    const group = createElement(
      "div",
      { id: "pdflionUndoRedo", className: "toolbarHorizontalGroup", hidden: true },
      undo,
      redo,
    );
    tools.before(group);
    return [undo, redo];
  }

  /**
   * Shows Undo and Redo while a drawing tool is on.
   *
   * @param {any} app
   */
  function followUndoButtons(app) {
    app.eventBus.on("annotationeditormodechanged", (/** @type {{ mode: number }} */ { mode }) => {
      const group = undoButtons[0]?.parentElement;
      if (!group) return;
      const hidden = mode === EDITOR_NONE || mode === EDITOR_DISABLE;
      if (group.hidden === hidden) return;
      group.hidden = hidden;
      layoutToolbar();
    });
  }

  /**
   * Adds the host's Open…, New and About to the ⋮ menu: Open… and New at
   * the top, where pdf.js's Open is, which overrides.css hides, and About at
   * the end. Open… must run in the click, since iPadOS opens the file picker
   * only then.
   *
   * @param {any} app
   */
  function addAppMenuItems(app) {
    const container = document.getElementById("secondaryToolbarButtonContainer");
    if (!container) return;
    /**
     * @param {string} id
     * @param {string} label
     * @param {() => void} action
     */
    const item = (id, label, action) => {
      const button = makeButton(id, "toolbarButton labeled", label);
      button.addEventListener("click", () => {
        action();
        app.secondaryToolbar?.close();
      });
      return button;
    };
    const { showOpenPanel, newDocument, showAbout } = window.pdflion;
    const top = [];
    if (typeof showOpenPanel === "function") {
      top.push(item("pdflionSecondaryOpen", t("openFile"), () => window.pdflion.showOpenPanel()));
    }
    if (typeof newDocument === "function") {
      top.push(item("pdflionSecondaryNew", t("new"), () => window.pdflion.newDocument()));
    }
    if (top.length > 0) {
      container.prepend(...top, createElement("div", { className: "horizontalToolbarSeparator" }));
    }
    if (typeof showAbout === "function") {
      container.append(
        createElement("div", { className: "horizontalToolbarSeparator" }),
        item("pdflionSecondaryAbout", t("aboutPdflion"), () => window.pdflion.showAbout()),
      );
    }
  }

  /**
   * Adds to the top of the ⋮ menu what the toolbar's narrow steps take from
   * it, which overrides.css shows only then: Find…, Page Overview and Insert
   * Blank Page, once they go.
   *
   * @param {any} app
   * @returns {HTMLButtonElement[]} the items that change pages
   */
  function addNarrowMenuItems(app) {
    const container = document.getElementById("secondaryToolbarButtonContainer");
    if (!container) return [];
    /**
     * @param {string} id
     * @param {string} label
     * @param {() => void} action
     */
    const item = (id, label, action) => {
      const button = makeButton(id, "toolbarButton labeled", label);
      button.addEventListener("click", () => {
        app.secondaryToolbar?.close();
        action();
      });
      return button;
    };
    const insert = item("pdflionSecondaryInsertBlankPage", t("insertBlankPage"), () =>
      insertBlankPage(app),
    );
    insert.disabled = true;
    const tiny = createElement(
      "div",
      { className: "pdflionVisibleTiny" },
      item("pdflionSecondaryFind", t("find"), () => app.findBar?.open()),
      item("pdflionSecondaryPageOverview", t("pageOverview"), () => toggleOverview(app)),
      insert,
      createElement("div", { className: "horizontalToolbarSeparator" }),
    );
    container.prepend(tiny);
    return [insert];
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
    const button = makeButton("pdflionPageOverview", "toolbarButton", t("pageOverview"));
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => toggleOverview(app));
    sidebarButton.after(button);
    return button;
  }

  /**
   * Adds PDFLion's own page tools to the views manager's header, before
   * pdf.js's Add file: Rotate Pages Left and Right, and Insert Blank Page.
   * overrides.css shows them with Add file, in the sidebar's thumbnails and
   * the overview, and not for a locked document.
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
    const rotateLeft = makeButton("pdflionRotatePagesLeft", className, t("rotatePagesLeft"));
    rotateLeft.addEventListener("click", () => rotatePages(app, -90));
    const rotateRight = makeButton("pdflionRotatePagesRight", className, t("rotatePagesRight"));
    rotateRight.addEventListener("click", () => rotatePages(app, 90));
    const insert = makeButton("pdflionOverviewInsertBlankPage", className, t("insertBlankPage"));
    insert.addEventListener("click", () => insertBlankPage(app, true));
    const buttons = [rotateLeft, rotateRight, insert];
    for (const button of buttons) button.disabled = true;
    tools.append(...buttons);
    addFile.before(tools);
    return buttons;
  }

  /**
   * A button built like pdf.js's own. overrides.css draws its icon.
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
    showSidebarButton(app);
    relayoutThumbnails(app);
    // The arrow keys then go from page to page.
    document.querySelector(CURRENT_THUMBNAIL)?.focus();
  }

  /**
   * Closes the overview, and shows the sidebar as it was before, unless pdf.js
   * has closed the views manager meanwhile.
   *
   * @param {any} app
   * @param {{ toSidebar?: boolean }} [options] toSidebar: to show the sidebar,
   *   as toggling it does, which then shows the thumbnails if it was closed
   *   before
   */
  function closeOverview(app, { toSidebar = false } = {}) {
    const { viewsManager, pdfViewer } = app;
    if (!overview) return;
    const focused = document.getElementById("viewsManager")?.contains(document.activeElement);
    showOverview(false);
    if (viewsManager.visibleView === SIDEBAR_THUMBS) {
      // While the thumbnails still show, in the sidebar.
      relayoutThumbnails(app);
      if (viewBeforeOverview !== SIDEBAR_NONE) viewsManager.switchView(viewBeforeOverview);
      else if (!toSidebar) viewsManager.close();
    }
    showSidebarButton(app);
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
   * pdf.js shows its sidebar button on while the views manager is open
   * (`toggleExpandedBtn()` in web/ui_utils.js), as it is for the overview.
   * While the overview is open, only the overview's own button shows on.
   *
   * @param {any} app
   */
  function showSidebarButton(app) {
    const button = document.getElementById("viewsManagerToggleButton");
    const open = !overview && !!app.viewsManager?.isOpen;
    button?.classList.toggle("toggled", open);
    button?.setAttribute("aria-expanded", String(open));
  }

  /**
   * Keeps the overview in step with pdf.js and the window:
   * - pdf.js's sidebar button shows off while it's open, so toggling the
   *   sidebar, with that button, F4 or View > Toggle Sidebar, closes the
   *   overview and shows the sidebar
   * - pdf.js closing the views manager closes it too. reopen() leaves it open.
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
      // pdf.js has shown its sidebar button as the views manager is.
      showSidebarButton(app);
    });
    // F4 and View > Toggle Sidebar call toggle(). pdf.js's sidebar button had
    // it bound before this replaced it (web/sidebar.js), so its clicks come
    // here first.
    const { toggle } = viewsManager;
    viewsManager.toggle = function (/** @type {unknown[]} */ ...args) {
      if (overview) closeOverview(app, { toSidebar: true });
      else toggle.apply(this, args);
    };
    window.addEventListener(
      "click",
      (event) => {
        if (!overview || !targetIn(event, "#viewsManagerToggleButton")) return;
        event.stopImmediatePropagation();
        viewsManager.toggle();
      },
      true,
    );
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
    // A click on a page opens it, once pdf.js has gone to it from the
    // thumbnails' own listener, which stops the click. pdf.js stops the click
    // that ends a drag of pages on window, before it reaches the thumbnails.
    document.querySelector(THUMBNAILS)?.addEventListener(
      "click",
      (event) => {
        if (!overview || !targetIn(event, THUMBNAIL_IMAGE)) return;
        setTimeout(() => {
          if (overview) closeOverview(app);
        }, 0);
      },
      true,
    );
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
   * Object mode it removes every drawing it touches, whole. In Line mode it
   * cuts away the parts of strokes under it, and replaces each drawing it
   * cuts with one of what's left, once per frame. A drag is one step to undo.
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
    const button = makeButton("pdflionEditorEraserButton", "toolbarButton", t("eraser"));
    button.disabled = true;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-controls", "pdflionEditorEraserParamsToolbar");
    button.addEventListener("click", () => toggleEraser(app));

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
    const line = modeChoice("line", t("eraseLine"), t("eraseLineTitle"));
    const object = modeChoice("object", t("eraseObject"), t("eraseObjectTitle"));
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
          { className: "editorParamsSetter", role: "radiogroup", ariaLabel: t("erase") },
          line.label,
          object.label,
        ),
        createElement(
          "div",
          { className: "editorParamsSetter" },
          createElement("label", {
            className: "editorParamsLabel",
            htmlFor: "pdflionEraserSize",
            textContent: t("size"),
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
   * - a press on a page starts erasing, and the circle follows the pointer. A
   *   pen's eraser end erases whatever tool is on (startGesture())
   *
   * Its settings are main's, the same in every tab: see followToolSettings().
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
   * Turns the eraser on, or off to no tool: its button, and Edit > Eraser.
   *
   * @param {any} app
   * @returns {boolean} whether it's on now
   */
  function toggleEraser(app) {
    if (erasing) stopErasing(app, EDITOR_NONE);
    else startErasing(app);
    return erasing;
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
    updateFavouritesPressed(app);
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
    updateFavouritesPressed(app);
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
    showActiveTool();
  }

  /**
   * pdf.js's ink mode shows Pencil on, with its option box open. While the
   * eraser is on, overrides.css shows them off, and this says so too.
   */
  function hidePencil() {
    document.getElementById("editorInkButton")?.setAttribute("aria-expanded", "false");
  }

  /**
   * Follows the tool settings main keeps for every tab, which it sends each
   * tab after every change: the eraser's, pen-only drawing, and the
   * favourites.
   *
   * @param {any} app
   * @returns {Promise<void>} once main has first sent them
   */
  function followToolSettings(app) {
    /**
     * @param {{ eraser: EraserSettings, penOnly: boolean, penOnlyChosen: boolean,
     *   favourites: Favourite[] }} settings
     */
    const show = (settings) => {
      showEraser(settings.eraser);
      showPenOnly(settings);
      favourites = settings.favourites;
      showFavourites(app);
    };
    window.pdflion.onToolSettingsChange(show);
    return window.pdflion.getToolSettings().then((settings) => {
      if (settings) show(settings);
    });
  }

  /**
   * Shows the eraser's settings, as main sends them.
   *
   * @param {EraserSettings} settings
   */
  function showEraser(settings) {
    eraser = settings;
    if (!eraserTool) return;
    eraserTool.modes[settings.mode].checked = true;
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
   * events, so it neither draws nor selects drawings. Where the pointer is on
   * the page is read as each event comes, and erasing there waits its turn.
   *
   * A pen's eraser end erases too, with the eraser's settings, whatever tool
   * is on, and that tool stays on: pdf.js has the file's drawings as editors
   * while any of its tools is. With no tool on, the eraser end turns the
   * eraser on, and erases once ink mode has them as editors. It stays on, for
   * Undo, which pdf.js takes only while a tool is on.
   *
   * @param {any} app
   * @param {PointerEvent} event
   */
  function startGesture(app, event) {
    const eraserEnd = event.pointerType === "pen" && event.button === PEN_ERASER_BUTTON;
    if (gesture || !(eraserEnd || (erasing && event.button === 0))) return;
    if (isFingerKeptOff(app, event)) return;
    const ui = uiManager(app);
    const place = placeOf(app, event);
    const tool = app.pdfViewer.annotationEditorMode;
    if (!ui || !place || tool === EDITOR_DISABLE) return;
    event.stopPropagation();
    event.preventDefault();
    const inPlace = !erasing && tool !== EDITOR_NONE;
    if (inPlace) {
      commitDrawing(ui);
    } else if (!erasing) {
      const inkMode = new Promise((resolve) => {
        app.eventBus.on("annotationeditormodechanged", resolve, { once: true });
      });
      startErasing(app);
      afterErasing(() => inkMode);
    }
    const listening = new AbortController();
    const started = /** @type {Gesture} */ ({
      pointerId: event.pointerId,
      mode: eraser.mode,
      last: null,
      drawings: new Map(),
      replacements: new Map(),
      redrawing: false,
      listening,
      inPlace,
    });
    gesture = started;
    moveCursor(app, event);
    const options = { capture: true, signal: listening.signal };
    window.addEventListener(
      "pointermove",
      (move) => {
        if (move.pointerId !== started.pointerId) return;
        move.stopPropagation();
        moveCursor(app, move);
        const next = placeOf(app, move);
        afterErasing(() => eraseTo(app, started, next));
      },
      options,
    );
    for (const type of ["pointerup", "pointercancel"]) {
      window.addEventListener(
        type,
        (end) => {
          if (/** @type {PointerEvent} */ (end).pointerId !== started.pointerId) return;
          end.stopPropagation();
          endGesture(app);
        },
        options,
      );
    }
    afterErasing(() => eraseTo(app, started, place));
  }

  /**
   * Ends a drag of the eraser. Once what it erased shows, it's one step to
   * undo, as pdf.js's own Delete is: undoing puts each drawing back as it
   * was, and redoing shows what the eraser left of it again.
   *
   * @param {any} app
   */
  function endGesture(app) {
    if (!gesture) return;
    const ended = gesture;
    ended.listening.abort();
    gesture = null;
    if (ended.inPlace && !erasing && eraserTool) eraserTool.cursor.hidden = true;
    afterErasing(async () => {
      await redraw(app, ended);
      const ui = uiManager(app);
      const changed = [...ended.drawings.values()].filter(
        (drawing) =>
          drawing !== null && !(drawing.shown.length === 1 && drawing.shown[0] === drawing.editor),
      );
      if (!ui || changed.length === 0) return;
      ui.addCommands({
        cmd: () => {
          for (const { editor, shown } of changed) {
            editor.remove();
            for (const piece of shown) restoreEditor(ui, piece);
          }
        },
        undo: () => {
          for (const { editor, shown } of changed) {
            for (const piece of shown) piece.remove();
            restoreEditor(ui, editor);
          }
        },
        mustExec: false,
      });
    });
  }

  /**
   * Runs a step of the eraser's work once the steps before it are done.
   *
   * @param {() => unknown} step
   */
  function afterErasing(step) {
    erasingDone = erasingDone.then(step).catch((error) => {
      console.error("Couldn't erase:", error);
    });
  }

  /**
   * Erases where the eraser passed since it was last on the page, at points
   * half its size apart, so that a fast drag misses nothing.
   *
   * @param {any} app
   * @param {Gesture} drag
   * @param {{ pageIndex: number, point: number[] } | null} place where the
   *   eraser is now, from placeOf()
   */
  function eraseTo(app, drag, place) {
    const { last } = drag;
    drag.last = place;
    if (!place) return;
    const radius = eraser.size / 2;
    const from = last?.pageIndex === place.pageIndex ? last.point : place.point;
    const path = window.PDFLionGeometry.resample([...from, ...place.point], radius / 2);
    for (let i = 0; i < path.length; i += 2) {
      eraseAt(app, drag, place.pageIndex, [path[i], path[i + 1]], radius);
    }
  }

  /**
   * Erases what the eraser touches on a page, centred on a point: the
   * drawings, in Object mode, or the parts of their strokes, in Line mode,
   * which a frame later show as a drawing of what's left.
   *
   * @param {any} app
   * @param {Gesture} drag
   * @param {number} pageIndex
   * @param {number[]} center in PDF coordinates
   * @param {number} radius
   */
  function eraseAt(app, drag, pageIndex, center, radius) {
    const ui = uiManager(app);
    if (!ui) return;
    const { cutStroke, hitsStroke } = window.PDFLionGeometry;
    for (const editor of [...ui.getEditors(pageIndex)]) {
      const drawing = drag.replacements.get(editor) ?? drawingOf(drag, editor);
      if (!drawing || !touches(drawing, center, radius)) continue;
      if (drag.mode === "object" || drawing.highlight) {
        editor.remove();
        drawing.shown = drawing.shown.filter((piece) => piece !== editor);
        continue;
      }
      // A stroke's round ends reach half its thickness past its points.
      const { thickness } = drawing;
      drawing.strokes = drawing.strokes.flatMap((stroke) =>
        hitsStroke(stroke, center, radius, thickness)
          ? cutStroke(stroke, center, radius + thickness / 2)
          : [stroke],
      );
      drawing.cut = true;
      redrawSoon(app, drag);
    }
  }

  /**
   * Shows the drawings a drag has cut at the next frame, rather than at
   * every pointer event.
   *
   * @param {any} app
   * @param {Gesture} drag
   */
  function redrawSoon(app, drag) {
    if (drag.redrawing) return;
    drag.redrawing = true;
    requestAnimationFrame(() => {
      drag.redrawing = false;
      afterErasing(() => redraw(app, drag));
    });
  }

  /**
   * Replaces each drawing the drag cut since it last showed with a drawing
   * for each stroke left of it, with the same colour, thickness and opacity,
   * so that each piece of a cut line is a drawing of its own, which the
   * eraser's Object mode erases alone. A drawing with nothing left goes.
   *
   * @param {any} app
   * @param {Gesture} drag
   */
  async function redraw(app, drag) {
    const ui = uiManager(app);
    if (!ui) return;
    for (const drawing of drag.drawings.values()) {
      if (!drawing?.cut) continue;
      drawing.cut = false;
      const { editor, data, strokes } = drawing;
      const layer = ui.getLayer(editor.pageIndex);
      /** @type {any[]} */
      const pieces = [];
      for (const stroke of layer ? strokes : []) {
        const piece = await layer.deserialize({
          annotationType: EDITOR_INK,
          color: data.color,
          thickness: data.thickness,
          opacity: data.opacity,
          paths: { points: [Float32Array.from(stroke)] },
          // pdf.js replaces it with the box around the stroke.
          rect: data.rect,
          rotation: data.rotation,
        });
        if (piece) pieces.push(piece);
      }
      for (const piece of drawing.shown) piece.remove();
      for (const piece of pieces) {
        addWithoutUndo(layer, piece);
        drag.replacements.set(piece, drawing);
      }
      drawing.shown = pieces;
    }
  }

  /**
   * Adds an editor the eraser built to its page. pdf.js makes adding a new
   * drawing a step to undo of its own (`onceAdded()` in
   * src/display/editor/draw.js, through the layer's addUndoableEditor()), but
   * the eraser's drag is one step, which endGesture() adds.
   *
   * @param {any} layer
   * @param {any} editor
   */
  function addWithoutUndo(layer, editor) {
    layer.addUndoableEditor = () => {};
    try {
      layer.addOrRebuild(editor);
    } finally {
      delete layer.addUndoableEditor;
    }
  }

  /**
   * @param {Gesture} drag
   * @param {any} editor
   * @returns {Drawing | null} its drawing, if it's Pencil's or a highlight:
   *   not a signature, which is a drawing too
   */
  function drawingOf(drag, editor) {
    const { drawings } = drag;
    if (!drawings.has(editor)) {
      drawings.set(editor, editor.editorType === "highlight" ? highlightOf(editor) : inkOf(editor));
    }
    return drawings.get(editor) ?? null;
  }

  /**
   * @param {any} editor
   * @returns {Drawing | null} a Pencil drawing's strokes and look
   */
  function inkOf(editor) {
    const data = editor.editorType === "ink" ? editor.serialize(true) : null;
    if (!data) return null;
    const strokes = data.paths.points;
    return {
      editor,
      data,
      highlight: false,
      quads: [],
      strokes,
      thickness: data.thickness,
      box: boxAround(strokes),
      shown: [editor],
      cut: false,
    };
  }

  /**
   * A highlight's place, which pdf.js serializes only to save it: a free
   * highlight's line, and a text highlight's boxes, in PDF coordinates, as
   * `serialize()` in src/display/editor/highlight.js works them out.
   *
   * @param {any} editor
   * @returns {Drawing | null}
   */
  function highlightOf(editor) {
    const outlines = editor._drawOutlines;
    if (!outlines || editor.isEmpty?.()) return null;
    /** @type {ArrayLike<number>[]} */
    let strokes = [];
    /** @type {ArrayLike<number>[]} */
    const quads = [];
    let thickness = 0;
    if (outlines.isFree) {
      // Its line, as a list of strokes of x, y pairs.
      strokes = [...outlines.serialize(editor.getPDFRect(), editor._drawRotation).points];
      thickness = editor._drawingOptions?.thickness ?? 0;
    } else {
      const points = outlines.serializeQuadPoints(editor.pageTranslation, editor.pageDimensions);
      // Each box's corners: top left, top right, bottom left, bottom right.
      for (let i = 0; i + 7 < points.length; i += 8) {
        quads.push([
          Math.min(points[i], points[i + 2]),
          Math.min(points[i + 1], points[i + 5]),
          Math.max(points[i], points[i + 2]),
          Math.max(points[i + 1], points[i + 5]),
        ]);
      }
    }
    const box = boxAround([...strokes, ...quads]);
    return {
      editor,
      data: null,
      highlight: true,
      quads,
      strokes,
      thickness,
      box,
      shown: [editor],
      cut: false,
    };
  }

  /**
   * @param {Drawing} drawing
   * @param {number[]} center
   * @param {number} radius
   * @returns {boolean} whether an eraser there touches the drawing's ink, or
   *   a text highlight's boxes
   */
  function touches({ strokes, quads, thickness, box: [x1, y1, x2, y2] }, center, radius) {
    const reach = radius + thickness / 2;
    const [x, y] = center;
    if (x < x1 - reach || x > x2 + reach || y < y1 - reach || y > y2 + reach) return false;
    const inQuad = quads.some(([left, bottom, right, top]) => {
      const dx = Math.max(left - x, 0, x - right);
      const dy = Math.max(bottom - y, 0, y - top);
      return dx * dx + dy * dy <= radius * radius;
    });
    return (
      inQuad ||
      strokes.some((stroke) => window.PDFLionGeometry.hitsStroke(stroke, center, radius, thickness))
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
   * the page's zoom, or hides it off the pages: while the eraser is on, and
   * while a pen's eraser end erases with another tool on. A pen hovering
   * over the page moves it too, but not a finger kept off the pages.
   *
   * @param {any} app
   * @param {PointerEvent} event
   */
  function moveCursor(app, event) {
    if (!(erasing || gesture?.inPlace) || !eraserTool || isFingerKeptOff(app, event)) return;
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
    const div = /** @type {any} */ (target)?.closest?.(PAGE);
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
   * Adds pen-only drawing's item to the top of the ⋮ menu, as a setting
   * of its own that applies to every tool, rather than a switch in some
   * tools' option boxes, which looked as if it applied to that tool alone.
   * Choosing it turns it on or off, and the web app's Home has it too.
   *
   * @param {any} app
   * @returns {HTMLButtonElement | null}
   */
  function addPenOnlyItem(app) {
    const container = document.getElementById("secondaryToolbarButtonContainer");
    if (!container) return null;
    const button = makeButton("pdflionSecondaryPenOnly", "toolbarButton labeled", t("drawOnlyWithPen"));
    button.setAttribute("role", "menuitemcheckbox");
    button.setAttribute("aria-checked", String(penOnly));
    button.classList.toggle("toggled", penOnly);
    button.addEventListener("click", () => {
      storePenOnly(!penOnly);
      app.secondaryToolbar?.close();
    });
    container.prepend(button, createElement("div", { className: "horizontalToolbarSeparator" }));
    return button;
  }

  /**
   * Shows whether only a pen draws, as main sends it: on its ⋮ menu item, and on
   * #outerContainer, where overrides.css lets fingers scroll the pages under
   * the eraser and Highlight.
   *
   * @param {{ penOnly?: boolean, penOnlyChosen?: boolean }} settings
   */
  function showPenOnly(settings) {
    penOnly = settings.penOnly === true;
    penOnlyChosen = settings.penOnlyChosen === true;
    document.getElementById("outerContainer")?.classList.toggle("pdflionPenOnly", penOnly);
    penOnlyItem?.setAttribute("aria-checked", String(penOnly));
    // As pdf.js shows the scroll mode chosen, for one.
    penOnlyItem?.classList.toggle("toggled", penOnly);
  }

  /**
   * Has main keep whether only a pen draws, which it sends every tab, and
   * which counts as chosen from then on.
   *
   * @param {boolean} on
   */
  function storePenOnly(on) {
    showPenOnly({ penOnly: on, penOnlyChosen: true });
    window.pdflion.setToolSettings({ penOnly: on });
  }

  /**
   * Pen-only drawing, as iPadOS's "Only Draw with Apple Pencil": the first
   * pen to press on a page turns it on, unless it was ever turned on or off
   * before, and its item in the ⋮ menu turns it off. While it's on and Pencil, Highlight
   * or the eraser is on, a finger's press on a page never reaches pdf.js's
   * layers, which would draw, select or erase with it. Its default stays, so
   * the browser scrolls, and pdf.js's TouchManager, which follows touch
   * events, pinches. The eraser and its circle leave such fingers alone too.
   *
   * While a pen is down on a page with one of those tools on, or its eraser
   * end with any, a resting palm scrolls nothing: every touchmove is
   * cancelled where it still can be, as pdf.js cancels the pen's own, which
   * Safari sends too. Nor does a palm start pdf.js's pinch then, which would
   * end the stroke, nor does the pen's own touch with a palm already down.
   *
   * @param {any} app
   */
  function followPen(app) {
    const container = document.getElementById("viewerContainer");
    if (!container) return;
    container.addEventListener(
      "pointerdown",
      (event) => {
        if (!(/** @type {any} */ (event.target)?.closest?.(PAGE))) return;
        if (event.pointerType === "pen") pressedWithPen(app, event);
        else if (isFingerKeptOff(app, event)) event.stopPropagation();
      },
      true,
    );
    for (const type of ["pointerup", "pointercancel"]) {
      window.addEventListener(
        type,
        (event) => {
          if (/** @type {PointerEvent} */ (event).pointerId === penDown) penDown = null;
        },
        true,
      );
    }
    window.addEventListener(
      "touchstart",
      (event) => {
        // Touch.touchType is Safari's, which has a pen's touches as `stylus`.
        const stylus = [...event.changedTouches].every(
          (touch) => /** @type {any} */ (touch).touchType === "stylus",
        );
        const tool = app.pdfViewer?.annotationEditorMode;
        if (penDown !== null || (stylus && PEN_TOOLS.has(tool))) event.stopPropagation();
      },
      true,
    );
    window.addEventListener(
      "touchmove",
      (event) => {
        if (penDown !== null && event.cancelable) event.preventDefault();
      },
      { capture: true, passive: false },
    );
  }

  /**
   * A pen pressed on a page: the first ever turns pen-only drawing on.
   *
   * @param {any} app
   * @param {PointerEvent} event
   */
  function pressedWithPen(app, event) {
    if (!penOnly && !penOnlyChosen) storePenOnly(true);
    const tool = app.pdfViewer.annotationEditorMode;
    const eraserEnd = event.button === PEN_ERASER_BUTTON && tool !== EDITOR_DISABLE;
    if (PEN_TOOLS.has(tool) || eraserEnd) penDown = event.pointerId;
  }

  /**
   * @param {any} app
   * @param {PointerEvent} event
   * @returns {boolean} whether it's a finger that only scrolls and zooms:
   *   pen-only drawing is on, and so is Pencil, Highlight or the eraser
   */
  function isFingerKeptOff(app, event) {
    return (
      penOnly && event.pointerType === "touch" && PEN_TOOLS.has(app.pdfViewer?.annotationEditorMode)
    );
  }

  /**
   * Zooms the document for a pinch on a trackpad in Safari, as pdf.js does
   * for Chromium's, which comes as wheel events with ctrlKey. Safari sends
   * it as gesture events alone, without touches, so pdf.js's TouchManager
   * never sees it, and Safari would zoom the whole page. A pinch with
   * fingers on the screen, which brings gesture events too, stays
   * TouchManager's, and so does a pinch that comes as wheel events after all.
   *
   * @param {any} app
   */
  function followTrackpadPinch(app) {
    const container = document.getElementById("viewerContainer");
    if (!container) return;
    /** How many fingers are on the screen, as the last touch event said. */
    let touches = 0;
    /** @param {TouchEvent} event */
    const countTouches = (event) => {
      touches = event.touches?.length ?? 0;
    };
    for (const type of ["touchstart", "touchend", "touchcancel"]) {
      window.addEventListener(type, /** @type {EventListener} */ (countTouches), true);
    }
    /**
     * The pinch, from the scale it started at.
     * @type {{ scale: number, byWheel: boolean } | null}
     */
    let pinch = null;
    window.addEventListener(
      "wheel",
      (event) => {
        if (pinch && event.ctrlKey) pinch.byWheel = true;
      },
      true,
    );
    container.addEventListener("gesturestart", (event) => {
      pinch = null;
      if (touches > 0 || app.pdfViewer?.isInPresentationMode) return;
      event.preventDefault();
      pinch = { scale: app.pdfViewer.currentScale, byWheel: false };
    });
    container.addEventListener("gesturechange", (event) => {
      if (!pinch) return;
      event.preventDefault();
      const { scale, clientX, clientY } = /** @type {any} */ (event);
      if (pinch.byWheel || !(scale > 0)) return;
      // From where it started, so that pdf.js's rounding doesn't add up.
      const factor = (pinch.scale * scale) / app.pdfViewer.currentScale;
      if (Math.abs(factor - 1) >= 0.005) app.updateZoom(null, factor, [clientX, clientY]);
    });
    container.addEventListener("gestureend", (event) => {
      if (!pinch) return;
      event.preventDefault();
      pinch = null;
    });
  }

  /**
   * In Page Scrolling, where pdf.js shows one page at a time, turns pages as
   * a book app does: a tap or click beside the page, on the viewer's dark
   * background, goes to the previous page on the left and the next on the
   * right, and so does a finger's swipe to the right or left. A swipe is
   * left alone where it would draw, with a drawing tool on that fingers draw
   * with, and where the page is wider than the view, which it scrolls.
   *
   * @param {any} app
   */
  function followPageTurns(app) {
    const container = document.getElementById("viewerContainer");
    if (!container) return;
    const isPageMode = () => app.pdfViewer?.scrollMode === SCROLL_MODE_PAGE;
    /** @param {number} delta 1 for the next page, -1 for the previous */
    const turn = (delta) => {
      if (delta > 0) app.pdfViewer.nextPage();
      else app.pdfViewer.previousPage();
    };

    container.addEventListener("click", (event) => {
      const target = /** @type {Element | null} */ (event.target);
      if (!isPageMode() || !target || target.closest(".page")) return;
      const page = app.pdfViewer.getPageView(app.page - 1)?.div;
      if (!page) return;
      const { left, right } = page.getBoundingClientRect();
      if (event.clientX < left) turn(-1);
      else if (event.clientX > right) turn(1);
    });

    // Touch events, which go on while the browser pans, where it cancels
    // the pointer's events. A pen's own touches, as Safari marks them, are
    // left out.
    /** @type {{ x: number, y: number, time: number } | null} */
    let swipe = null;
    container.addEventListener(
      "touchstart",
      (event) => {
        const [touch] = event.touches;
        const mode = app.pdfViewer?.annotationEditorMode;
        const drawsWithFingers =
          mode !== EDITOR_NONE &&
          mode !== EDITOR_DISABLE &&
          !isFingerKeptOff(app, /** @type {any} */ ({ pointerType: "touch" }));
        swipe =
          event.touches.length === 1 &&
          /** @type {any} */ (touch).touchType !== "stylus" &&
          isPageMode() &&
          !drawsWithFingers &&
          !erasing
            ? { x: touch.clientX, y: touch.clientY, time: event.timeStamp }
            : null;
      },
      { capture: true, passive: true },
    );
    container.addEventListener(
      "touchend",
      (event) => {
        const start = swipe;
        swipe = null;
        const [touch] = event.changedTouches;
        if (!start || !touch || event.touches.length > 0) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        const wider = container.scrollWidth > container.clientWidth + 1;
        if (
          !wider &&
          Math.abs(dx) >= SWIPE_DISTANCE &&
          Math.abs(dx) > 2 * Math.abs(dy) &&
          event.timeStamp - start.time <= SWIPE_TIME
        ) {
          turn(dx < 0 ? 1 : -1);
        }
      },
      { capture: true, passive: true },
    );
    container.addEventListener("touchcancel", () => (swipe = null), { capture: true, passive: true });
  }

  /**
   * Adds Save as Favourite to the end of the option boxes of Highlight, Text
   * and Pencil, as an outlined button. A click has main keep the tool's
   * settings for every tab, and the button says for a moment what it did.
   */
  function addSaveFavouriteButtons() {
    for (const [tool, { name }] of Object.entries(FAVOURITE_TOOLS)) {
      const container = document.querySelector(
        `#editor${name}ParamsToolbar > .editorParamsToolbarContainer`,
      );
      if (!container) continue;
      const label = createElement("span", { textContent: SAVE_FAVOURITE, ariaLive: "polite" });
      const button = createElement(
        "button",
        {
          type: "button",
          id: `pdflionSave${name}Favourite`,
          className: "secondaryButton pdflionSaveFavourite",
        },
        label,
      );
      let timer = 0;
      button.addEventListener("click", async () => {
        label.textContent = await saveFavourite(/** @type {Favourite["tool"]} */ (tool));
        clearTimeout(timer);
        timer = setTimeout(() => {
          label.textContent = SAVE_FAVOURITE;
        }, FAVOURITE_NOTE_TIME);
      });
      container.append(button);
    }
  }

  /**
   * Has main keep a tool's settings, as its option box shows them, as a
   * favourite, unless they're one already. Main drops repeats too.
   *
   * @param {Favourite["tool"]} tool
   * @returns {Promise<string>} what happened, for the button to say
   */
  async function saveFavourite(tool) {
    const favourite = readFavourite(tool);
    if (!favourite) return t("chooseColourFirst");
    await toolSettingsLoaded;
    if (!favourites) return t("couldntSave");
    if (favourites.some((other) => sameFavourite(other, favourite))) return t("alreadyFavourite");
    favourites = [...favourites, favourite];
    window.pdflion.setToolSettings({ favourites });
    return t("saved");
  }

  /**
   * Reads a tool's settings from its option box, where pdf.js shows those it
   * draws with, or the selected drawing's (`annotationeditorparamschanged`
   * in web/annotation_editor_params.js). Highlight's colour is the swatch its
   * colour picker shows as chosen.
   *
   * @param {Favourite["tool"]} tool
   * @returns {Favourite | null} null if the box shows no colour, as for a
   *   selected highlight whose colour none of the swatches has
   */
  function readFavourite(tool) {
    const input = (/** @type {string} */ id) =>
      /** @type {HTMLInputElement} */ (document.getElementById(id));
    if (tool === "highlight") {
      const color = document.querySelector(HIGHLIGHT_SWATCH)?.getAttribute("data-color");
      if (!color) return null;
      return {
        tool,
        color: color.toLowerCase(),
        thickness: input("editorFreeHighlightThickness").valueAsNumber,
      };
    }
    if (tool === "freetext") {
      return {
        tool,
        color: input("editorFreeTextColor").value,
        size: input("editorFreeTextFontSize").valueAsNumber,
      };
    }
    const ink = inkColor(input("editorInkColor").value, input("editorInkOpacity"));
    if (!ink) return null;
    return {
      tool,
      color: ink.color,
      thickness: input("editorInkThickness").valueAsNumber,
      opacity: ink.opacity,
    };
  }

  /**
   * Pencil's colour and opacity. pdf.js shows the opacity in a slider of its
   * own, or where the colour input takes an alpha channel, in the colour, and
   * removes the slider (web/annotation_editor_params.js). The colour's value
   * then comes in the browser's own format: `#rrggbbaa`, or Safari's and
   * Firefox's `color(srgb r g b / a)`, which pdf.js reads with getRGBA() in
   * src/display/display_utils.js, as this does.
   *
   * @param {string} value the colour input's
   * @param {HTMLInputElement | null} slider the opacity's, if there is one
   * @returns {{ color: string, opacity: number } | null}
   */
  function inkColor(value, slider) {
    const rgba = colorValues(value.trim());
    if (!rgba) return null;
    const [r, g, b, alpha] = rgba;
    const color = `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
    // As the slider would have it: in steps of 0.05, from 0.05.
    const steps = Math.max(1, Math.round(alpha * 20));
    return { color, opacity: slider?.valueAsNumber ?? steps / 20 };
  }

  /**
   * @param {string} value a colour input's
   * @returns {[number, number, number, number] | null} its red, green and
   *   blue, from 0 to 255, and its alpha, from 0 to 1
   */
  function colorValues(value) {
    const clamp = (/** @type {number} */ part) => Math.min(255, Math.max(0, Math.round(part)));
    const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
    if (hex) {
      const [, rgb, alpha = "ff"] = hex;
      return [0, 2, 4]
        .map((at) => parseInt(rgb.slice(at, at + 2), 16))
        .concat(parseInt(alpha, 16) / 255);
    }
    const number = String.raw`(-?[\d.]+(?:e-?\d+)?)`;
    const srgb = new RegExp(
      String.raw`^color\(srgb\s+${number}\s+${number}\s+${number}(?:\s*\/\s*(${number.slice(1, -1)}%?|none))?\)$`,
      "i",
    ).exec(value);
    if (srgb) {
      const [, r, g, b, alpha] = srgb;
      const opacity =
        alpha === undefined || alpha === "none"
          ? 1
          : alpha.endsWith("%")
            ? parseFloat(alpha) / 100
            : parseFloat(alpha);
      return [
        ...[r, g, b].map((part) => clamp(parseFloat(part) * 255)),
        Math.min(1, Math.max(0, opacity)),
      ];
    }
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value);
    if (rgb) {
      const [, r, g, b, alpha = "1"] = rgb;
      const opacity = alpha.endsWith("%") ? parseFloat(alpha) / 100 : parseFloat(alpha);
      return [...[r, g, b].map((part) => clamp(parseFloat(part))), Math.min(1, opacity)];
    }
    return null;
  }

  /**
   * @param {Favourite} a
   * @param {Favourite} b
   * @returns {boolean} whether they're the same tool with the same settings.
   *   Favourites of one tool have the same fields.
   */
  function sameFavourite(a, b) {
    const [first, second] = /** @type {Record<string, unknown>[]} */ ([a, b]);
    return Object.keys(first).every((key) => first[key] === second[key]);
  }

  /**
   * Adds the favourites' group to the toolbar, before pdf.js's drawing tools,
   * followed by a divider: a button for each favourite that fits, then a ★
   * button whose menu has the rest. showFavourites() fills it, and it shows
   * once there are any. overrides.css draws it.
   *
   * @returns {FavouritesBar | null}
   */
  function addFavouritesBar() {
    const tools = document.getElementById("editorModeButtons");
    if (!tools) return null;
    const moreButton = makeButton(
      "pdflionFavouritesMoreButton",
      "toolbarButton",
      t("moreFavourites"),
    );
    moreButton.disabled = true;
    moreButton.setAttribute("aria-expanded", "false");
    moreButton.setAttribute("aria-haspopup", "true");
    moreButton.setAttribute("aria-controls", "pdflionFavouritesMenu");
    const items = createElement("div", { className: "menuContainer", role: "menu" });
    // Built like pdf.js's Stamp menu, #editorStampParamsToolbar in web/viewer.html.
    const menu = createElement(
      "div",
      { id: "pdflionFavouritesMenu", className: "editorParamsToolbar hidden doorHangerRight menu" },
      items,
    );
    const more = createElement(
      "div",
      { id: "pdflionFavouritesMore", className: "toolbarButtonWithContainer", hidden: true },
      moreButton,
      menu,
    );
    const group = createElement(
      "div",
      { id: "pdflionFavourites", className: "toolbarHorizontalGroup", hidden: true },
      more,
    );
    const separator = createElement("div", {
      id: "pdflionFavouritesSeparator",
      className: "verticalToolbarSeparator",
      hidden: true,
    });
    tools.before(group);
    tools.before(separator);
    const closeMenu = followMenu(moreButton, menu, items);
    return { group, separator, more, moreButton, items, closeMenu };
  }

  /**
   * Makes the ★ menu work like pdf.js's menus (web/menu.js): its button opens
   * and closes it, the arrow keys, Home, End and an item's first letter move
   * through it, and Esc, choosing an item, or a press or the focus outside it
   * closes it.
   *
   * @param {HTMLButtonElement} button
   * @param {HTMLElement} menu
   * @param {HTMLElement} items the menu's items' container
   * @returns {() => void} what closes it
   */
  function followMenu(button, menu, items) {
    /** @type {AbortController | null} while it's open */
    let open = null;
    const close = () => {
      if (!open) return;
      open.abort();
      open = null;
      menu.classList.toggle("hidden", true);
      button.setAttribute("aria-expanded", "false");
      if (menu.contains(document.activeElement)) button.focus();
    };
    const choices = () =>
      /** @type {HTMLButtonElement[]} */ ([...items.children]).filter(
        (item) => item.tagName === "BUTTON" && !item.hidden && !item.disabled,
      );
    /** @param {"first" | "last"} [focus] which item takes the focus */
    const show = (focus) => {
      if (!open) {
        open = new AbortController();
        const { signal } = open;
        menu.classList.toggle("hidden", false);
        button.setAttribute("aria-expanded", "true");
        window.addEventListener(
          "pointerdown",
          ({ target }) => {
            if (!button.contains(target) && !menu.contains(target)) close();
          },
          { signal },
        );
        window.addEventListener("blur", close, { signal });
      }
      if (focus) choices().at(focus === "first" ? 0 : -1)?.focus();
    };
    /**
     * @param {EventTarget | null} from the item with the focus
     * @param {1 | -1} step
     * @param {(item: HTMLElement) => boolean} [check]
     */
    const moveFocus = (from, step, check = () => true) => {
      const list = choices();
      const start = list.indexOf(/** @type {any} */ (from));
      for (let i = 1; i <= list.length; i++) {
        const item = list[(((start + step * i) % list.length) + list.length) % list.length];
        if (check(item)) {
          item.focus();
          return;
        }
      }
    };
    /** @param {Event} event */
    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    button.addEventListener("click", () => (open ? close() : show()));
    button.addEventListener("keydown", (event) => {
      /** @type {Record<string, "first" | "last">} */
      const opening = { " ": "first", Enter: "first", ArrowDown: "first", Home: "first" };
      const focus = opening[event.key] ?? (["ArrowUp", "End"].includes(event.key) ? "last" : null);
      if (focus) show(focus);
      else if (event.key === "Escape" && open) close();
      else return;
      stop(event);
    });
    menu.addEventListener(
      "keydown",
      (event) => {
        const { key, target } = event;
        if (key === "Escape") close();
        else if (key === "ArrowDown") moveFocus(target, 1);
        else if (key === "ArrowUp") moveFocus(target, -1);
        else if (key === "Home" || key === "End") show(key === "Home" ? "first" : "last");
        else if (/^\p{L}$/u.test(key)) {
          const letter = key.toLocaleLowerCase();
          moveFocus(target, 1, (item) => item.textContent.toLocaleLowerCase().startsWith(letter));
        } else return;
        stop(event);
      },
      true,
    );
    // Before the item's own click, which uses its favourite.
    menu.addEventListener("click", close, true);
    for (const element of [button, menu]) {
      element.addEventListener("focusout", (/** @type {FocusEvent} */ { relatedTarget }) => {
        const to = /** @type {Node | null} */ (relatedTarget);
        if (!button.contains(to) && !menu.contains(to)) close();
      });
    }
    return close;
  }

  /**
   * Fills the favourites' group with main's favourites: a button each in the
   * toolbar and an item each in the ★ menu, of which layoutToolbar()
   * shows one.
   *
   * @param {any} app
   */
  function showFavourites(app) {
    if (!favouritesBar) return;
    const { group, more, items } = favouritesBar;
    favouriteButtons = (favourites ?? []).map((favourite) => ({
      favourite,
      button: favouriteButton(app, favourite, false),
      item: favouriteButton(app, favourite, true),
    }));
    group.replaceChildren(...favouriteButtons.map(({ button }) => button), more);
    items.replaceChildren(...favouriteButtons.map(({ item }) => item));
    layoutToolbar();
    updateFavouritesPressed(app);
  }

  /**
   * A favourite's button: its tool's icon in its colour, which overrides.css
   * draws, and its size. A click uses it, a drag onto another favourite moves
   * it there, and its context menu, also after a long press, removes it. A
   * finger or a pen drags it once it has held it long enough for the menu
   * (dragFavourite()).
   *
   * @param {any} app
   * @param {Favourite} favourite
   * @param {boolean} inMenu whether it's an item of the ★ menu, which shows
   *   its description, rather than a button of the toolbar
   * @returns {HTMLButtonElement}
   */
  function favouriteButton(app, favourite, inMenu) {
    const description = describeFavourite(favourite);
    const button = createElement(
      "button",
      {
        type: "button",
        className: `toolbarButton${inMenu ? " labeled" : ""} pdflionFavourite`,
        tabIndex: inMenu ? -1 : 0,
        disabled: !toolsEnabled,
      },
      createElement("span", { className: "pdflionFavouriteIcon", ariaHidden: "true" }),
      createElement("span", { textContent: description }),
    );
    if (inMenu) button.setAttribute("role", "menuitemradio");
    else button.title = description;
    button.setAttribute("data-tool", favourite.tool);
    button.setAttribute("data-size", String(favourite.size ?? favourite.thickness));
    button.style.setProperty("--pdflion-favourite-color", favourite.color);
    button.addEventListener("click", () => useFavourite(app, favourite));
    button.addEventListener("contextmenu", (/** @type {Event} */ event) => {
      event.preventDefault();
      window.pdflion.showFavouriteMenu(favourite);
    });
    favouriteOf.set(button, { favourite, inMenu });
    addLongPress(button, (down) => dragFavourite(app, favourite, button, down));
    button.draggable = true;
    // A finger or a pen drags it through dragFavourite() alone: iPadOS would
    // start a drag of its own with the long press that opens the menu.
    button.addEventListener("pointerdown", ({ pointerType, pointerId }) => {
      if (pointerType === "mouse") return;
      button.draggable = false;
      const pressing = new AbortController();
      /** @param {PointerEvent} event */
      const ended = (event) => {
        if (event.pointerId !== pointerId) return;
        button.draggable = true;
        pressing.abort();
      };
      const options = { capture: true, signal: pressing.signal };
      window.addEventListener("pointerup", ended, options);
      window.addEventListener("pointercancel", ended, options);
    });
    button.addEventListener("dragstart", (/** @type {DragEvent} */ event) => {
      favouriteDrag = { favourite, over: null, after: false };
      const { dataTransfer } = event;
      if (dataTransfer) {
        dataTransfer.effectAllowed = "move";
        dataTransfer.setData(FAVOURITE_DRAG_TYPE, "");
      }
      button.classList.toggle("pdflionDragged", true);
    });
    button.addEventListener("dragover", (/** @type {DragEvent} */ event) => {
      if (!favouriteDrag || !event.dataTransfer?.types.includes(FAVOURITE_DRAG_TYPE)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      showFavouriteDrop(button, isDropAfter(button, inMenu, event));
    });
    button.addEventListener("dragleave", (/** @type {DragEvent} */ event) => {
      const to = /** @type {Node | null} */ (event.relatedTarget);
      if (favouriteDrag?.over === button && !button.contains(to)) showFavouriteDrop(null, false);
    });
    button.addEventListener("drop", (/** @type {DragEvent} */ event) => {
      if (!favouriteDrag?.over) return;
      event.preventDefault();
      const { favourite: moved, after } = favouriteDrag;
      // The moved favourite's button goes, and with it maybe its dragend.
      showFavouriteDrop(null, false);
      favouriteDrag = null;
      moveFavourite(app, moved, favourite, after);
    });
    button.addEventListener("dragend", () => {
      button.classList.toggle("pdflionDragged", false);
      showFavouriteDrop(null, false);
      favouriteDrag = null;
    });
    return button;
  }

  /**
   * Whether a favourite dragged to a place goes after the favourite there,
   * rather than before it: across the toolbar, which pdf.js lays out right to
   * left for some languages, or down the ★ menu.
   *
   * @param {HTMLElement} over the favourite's button or ★ menu item
   * @param {boolean} inMenu whether it's an item of the ★ menu
   * @param {{ clientX: number, clientY: number }} at
   */
  function isDropAfter(over, inMenu, { clientX, clientY }) {
    const box = over.getBoundingClientRect();
    return inMenu
      ? clientY > box.top + box.height / 2
      : (clientX > box.left + box.width / 2) !== (document.documentElement.dir === "rtl");
  }

  /**
   * Drags a favourite with a finger or a pen, once a long press has opened
   * its menu, as iPadOS's own context menus do: moving on closes the menu,
   * and lifting over another favourite, in the toolbar or the ★ menu, moves
   * it there. Meanwhile the browser neither scrolls nor zooms.
   *
   * @param {any} app
   * @param {Favourite} favourite
   * @param {HTMLElement} button
   * @param {PointerEvent} down the press
   */
  function dragFavourite(app, favourite, button, down) {
    const following = new AbortController();
    const { signal } = following;
    let dragging = false;
    window.addEventListener(
      "touchmove",
      (event) => {
        if (event.cancelable) event.preventDefault();
      },
      { capture: true, passive: false, signal },
    );
    /** @param {PointerEvent} event */
    const moved = (event) => {
      if (event.pointerId !== down.pointerId) return;
      if (!dragging) {
        const far =
          Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) > LONG_PRESS_SLOP;
        if (!far) return;
        dragging = true;
        if (typeof window.pdflion.closeMenu === "function") window.pdflion.closeMenu();
        favouriteDrag = { favourite, over: null, after: false };
        button.classList.toggle("pdflionDragged", true);
      }
      const at = document.elementFromPoint(event.clientX, event.clientY);
      const over = /** @type {HTMLElement | null} */ (at?.closest(".pdflionFavourite") ?? null);
      const there = over ? favouriteOf.get(over) : undefined;
      if (over && there) showFavouriteDrop(over, isDropAfter(over, there.inMenu, event));
      else showFavouriteDrop(null, false);
    };
    /** @param {PointerEvent} event */
    const ended = (event) => {
      if (event.pointerId !== down.pointerId) return;
      following.abort();
      if (!dragging || !favouriteDrag) return;
      const { over, after } = favouriteDrag;
      button.classList.toggle("pdflionDragged", false);
      showFavouriteDrop(null, false);
      favouriteDrag = null;
      const target = over ? favouriteOf.get(over)?.favourite : undefined;
      if (event.type === "pointerup" && target) moveFavourite(app, favourite, target, after);
    };
    window.addEventListener("pointermove", moved, { capture: true, signal });
    window.addEventListener("pointerup", ended, { capture: true, signal });
    window.addEventListener("pointercancel", ended, { capture: true, signal });
  }

  /**
   * Opens an element's context menu after a long press with a finger or a
   * pen, of LONG_PRESS_TIME without moving more than LONG_PRESS_SLOP, which
   * iPadOS doesn't: it sends a contextmenu event where the press is. The
   * browser's own, as Chromium sends after a touch's long press, and a click
   * after the press, are dropped. A drag after it closes the host's menu,
   * since iPadOS starts one with a long press too. The same as in
   * src/tabs/tabs.js and src/home/home.js.
   *
   * @param {HTMLElement} element
   * @param {(down: PointerEvent) => void} [held] called once the menu has
   *   opened, while the press goes on
   */
  function addLongPress(element, held) {
    /** Whether the last press opened the menu, until the next. */
    let opened = false;
    element.addEventListener("pointerdown", (down) => {
      opened = false;
      if (down.pointerType === "mouse" || down.button !== 0) return;
      const pressing = new AbortController();
      const { signal } = pressing;
      const stop = () => pressing.abort();
      const timer = setTimeout(() => {
        stop();
        opened = true;
        const { clientX, clientY } = down;
        const menu = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        });
        element.dispatchEvent(menu);
        held?.(down);
      }, LONG_PRESS_TIME);
      signal.addEventListener("abort", () => clearTimeout(timer));
      /** @param {PointerEvent} event */
      const moved = ({ pointerId, clientX, clientY }) => {
        const far = Math.hypot(clientX - down.clientX, clientY - down.clientY) > LONG_PRESS_SLOP;
        if (pointerId === down.pointerId && far) stop();
      };
      /** @param {PointerEvent} event */
      const ended = ({ pointerId }) => {
        if (pointerId === down.pointerId) stop();
      };
      window.addEventListener("pointermove", moved, { signal });
      window.addEventListener("pointerup", ended, { signal });
      window.addEventListener("pointercancel", ended, { signal });
      element.addEventListener("dragstart", stop, { signal });
      element.addEventListener("contextmenu", (event) => event.isTrusted && stop(), { signal });
    });
    // Before the element's own listeners.
    element.addEventListener(
      "contextmenu",
      (event) => {
        if (!event.isTrusted || !opened) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    element.addEventListener(
      "click",
      (event) => {
        if (!opened) return;
        opened = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    element.addEventListener("keydown", () => {
      opened = false;
    });
    element.addEventListener("dragstart", () => {
      if (opened && typeof window.pdflion.closeMenu === "function") window.pdflion.closeMenu();
    });
  }

  /**
   * Shows where a dragged favourite would go, before or after another, which
   * overrides.css marks.
   *
   * @param {HTMLElement | null} over the favourite it's over, or none
   * @param {boolean} after
   */
  function showFavouriteDrop(over, after) {
    if (!favouriteDrag) return;
    favouriteDrag.over?.classList.toggle("pdflionDropBefore", false);
    favouriteDrag.over?.classList.toggle("pdflionDropAfter", false);
    over?.classList.toggle(after ? "pdflionDropAfter" : "pdflionDropBefore", true);
    Object.assign(favouriteDrag, { over, after });
  }

  /**
   * Moves a favourite before or after another, and has main keep the new
   * order, which it sends every tab.
   *
   * @param {any} app
   * @param {Favourite} moved
   * @param {Favourite} target
   * @param {boolean} after
   */
  function moveFavourite(app, moved, target, after) {
    if (!favourites || moved === target) return;
    const order = favourites.filter((favourite) => favourite !== moved);
    const index = order.indexOf(target);
    if (index === -1 || order.length !== favourites.length - 1) return;
    order.splice(index + (after ? 1 : 0), 0, moved);
    favourites = order;
    window.pdflion.setToolSettings({ favourites });
    showFavourites(app);
  }

  /**
   * @param {Favourite} favourite
   * @returns {string} what it is, such as "Pencil, #1E66F5, 1 pt, 100 %"
   */
  function describeFavourite({ tool, color, thickness, size, opacity }) {
    const parts = [
      FAVOURITE_TOOLS[tool].label,
      color.toUpperCase(),
      t("points", { size: size ?? thickness }),
    ];
    if (opacity !== undefined) parts.push(t("percent", { percent: Math.round(opacity * 100) }));
    return parts.join(", ");
  }

  /**
   * Turns a favourite's tool on with its settings, for what's drawn next, as
   * pdf.js's own tool buttons and option boxes would. Pencil's open drawing
   * is committed and the selection cleared first, or pdf.js would give them
   * the settings too (`updateParams()` in src/display/editor/tools.js, and
   * `updateDefaultParams()` in src/display/editor/draw.js). Switching tools
   * clears the selection only later, and not at all for the same tool.
   *
   * The tool's option box stays closed, since the favourite chose its
   * settings. pdf.js opens it as it switches tools, which followFavourites()
   * undoes then.
   *
   * @param {any} app
   * @param {Favourite} favourite
   */
  function useFavourite(app, favourite) {
    const ui = uiManager(app);
    if (!ui) return;
    const { mode, params } = FAVOURITE_TOOLS[favourite.tool];
    commitDrawing(ui);
    // The favourite that's on turns its tool off, as the tool's own button does.
    if (isFavouriteOn(app, favourite)) {
      app.eventBus.dispatch("switchannotationeditormode", { source: null, mode: EDITOR_NONE });
      return;
    }
    if (erasing && mode === EDITOR_INK) stopErasing(app, EDITOR_INK);
    if (app.pdfViewer.annotationEditorMode !== mode) {
      favouriteMode = mode;
      app.eventBus.dispatch("switchannotationeditormode", { source: null, mode });
    } else {
      closeOptionBox(favourite.tool);
    }
    const values = /** @type {Record<string, unknown>} */ (favourite);
    const details = Object.entries(params).map(([name, type]) => [type, values[name]]);
    for (const [type, value] of details) {
      app.eventBus.dispatch("switchannotationeditorparams", { source: null, type, value });
    }
    // pdf.js updates its option boxes for a selected drawing's settings, not
    // for settings that didn't come from them.
    app.eventBus.dispatch("annotationeditorparamschanged", { source: null, details });
  }

  /**
   * @param {any} app
   * @returns {Favourite | null} the tool that's on with its settings, as its
   *   option box shows them, and none while the eraser is on
   */
  function currentFavourite(app) {
    const mode = app.pdfViewer?.annotationEditorMode;
    const tool = Object.keys(FAVOURITE_TOOLS).find((name) => FAVOURITE_TOOLS[name].mode === mode);
    return tool && !erasing ? readFavourite(/** @type {Favourite["tool"]} */ (tool)) : null;
  }

  /**
   * @param {any} app
   * @param {Favourite} favourite
   * @returns {boolean} whether its tool is on with its settings
   */
  function isFavouriteOn(app, favourite) {
    const current = currentFavourite(app);
    return !!current && sameFavourite(favourite, current);
  }

  /**
   * Shows as pressed the favourites whose tool is on with their settings,
   * as its option box shows them, and none while the eraser is on. It reads
   * them once pdf.js has shown a change: Highlight's colour picker marks the
   * chosen swatch only after dispatching it (src/display/editor/color_picker.js).
   *
   * @param {any} app
   */
  function updateFavouritesPressed(app) {
    Promise.resolve().then(() => {
      const current = currentFavourite(app);
      for (const { favourite, button, item } of favouriteButtons) {
        const on = !!current && sameFavourite(favourite, current);
        button.classList.toggle("toggled", on);
        button.setAttribute("aria-pressed", String(on));
        item.classList.toggle("toggled", on);
        item.setAttribute("aria-checked", String(on));
      }
    });
  }

  /**
   * Fits the toolbar into the window, giving up as little as it can, in this
   * order: the 32 px buttons, then favourites, which move into the ★ menu
   * from the last, then pdf.js's own steps, from whose medium view on all
   * favourites are in the menu. It takes none of them before pdf.js does at
   * the window's width. As the window narrows, the toolbar only ever loses
   * more.
   */
  function layoutToolbar() {
    const count = favouriteButtons.length;
    if (favouritesBar) {
      const { group, separator } = favouritesBar;
      group.hidden = separator.hidden = count === 0;
    }
    const container = document.getElementById("toolbarContainer");
    const viewer = document.getElementById("toolbarViewer");
    if (!container || !viewer) {
      // Nothing to measure: the favourites all show in the toolbar.
      showInToolbar(count);
      return;
    }
    const fits = () => toolbarOverflow(viewer) <= 0;
    let step = PDFJS_STEPS.find(([query]) => window.matchMedia(query).matches)?.[1] ?? 0;
    showToolbarStep(container, step);
    if (step < MEDIUM_STEP) {
      showInToolbar(count);
      while (step < MEDIUM_STEP - 1 && !fits()) showToolbarStep(container, ++step);
      if (fits() || fitFavourites(viewer)) return;
      step = MEDIUM_STEP;
      showToolbarStep(container, step);
    }
    showInToolbar(0);
    while (step < TOOLBAR_STEPS.length && !fits()) showToolbarStep(container, ++step);
  }

  /**
   * Moves favourites into the ★ menu, from the last, until the rest fit.
   *
   * @param {HTMLElement} viewer #toolbarViewer
   * @returns {boolean} whether the toolbar fits, with the ★ button at least
   */
  function fitFavourites(viewer) {
    const count = favouriteButtons.length;
    if (!favouritesBar || count === 0) return false;
    const over = toolbarOverflow(viewer);
    const width = favouriteButtons[0].button.getBoundingClientRect().width;
    const room = width + parseFloat(getComputedStyle(favouritesBar.group).columnGap);
    // The ★ button takes a favourite's room.
    showInToolbar(Math.max(0, count - 1 - Math.ceil(over / room)));
    return toolbarOverflow(viewer) <= 0;
  }

  /**
   * @param {HTMLElement} container #toolbarContainer
   * @param {number} step how many of TOOLBAR_STEPS it takes
   */
  function showToolbarStep(container, step) {
    TOOLBAR_STEPS.forEach((name, index) => container.classList.toggle(name, index < step));
  }

  /** @param {number} shown how many favourites, from the first, the toolbar shows */
  function showInToolbar(shown) {
    if (!favouritesBar) return;
    favouriteButtons.forEach(({ button, item }, index) => {
      button.hidden = index >= shown;
      item.hidden = index < shown;
    });
    const all = shown === favouriteButtons.length;
    if (all) favouritesBar.closeMenu();
    favouritesBar.more.hidden = all;
  }

  /**
   * @param {HTMLElement} viewer #toolbarViewer, whose groups keep their width
   *   (web/viewer.css)
   * @returns {number} by how much its groups, with the gaps between them, are
   *   wider than it, in pixels
   */
  function toolbarOverflow(viewer) {
    const width = (/** @type {Element} */ element) => element.getBoundingClientRect().width;
    const groups = [...viewer.children];
    // #toolbarViewer is a .toolbarHorizontalGroup too, with its gap (overrides.css).
    const gaps = (groups.length - 1) * (parseFloat(getComputedStyle(viewer).columnGap) || 0);
    const used = groups.reduce((sum, group) => sum + width(group), gaps);
    // Less than half a pixel is rounding.
    return used - width(viewer) - 0.5;
  }

  /**
   * Fits the toolbar into the window again whenever the room in it changes:
   * with the window's width, or with what pdf.js's groups show, such as the
   * number of pages, the zoom menu's labels, or a signed document's button.
   * The first time is before the toolbar is first shown.
   */
  function followToolbarWidth() {
    // Not #toolbarViewerRight, which holds the favourites, and changes as they move.
    const resizing = new ResizeObserver(() => layoutToolbar());
    for (const id of ["toolbarViewer", "toolbarViewerLeft", "toolbarViewerMiddle"]) {
      const element = document.getElementById(id);
      if (element) resizing.observe(element);
    }
    const tools = document.getElementById("editorModeButtons");
    if (tools) resizing.observe(tools);
  }

  /**
   * Closes a drawing tool's option box, which pdf.js opens with its tool
   * (`toggleExpandedBtn()` in web/toolbar.js). The tool's button still shows
   * the tool on.
   *
   * @param {Favourite["tool"]} tool
   */
  function closeOptionBox(tool) {
    const { name } = FAVOURITE_TOOLS[tool];
    document.getElementById(`editor${name}Button`)?.setAttribute("aria-expanded", "false");
    document.getElementById(`editor${name}ParamsToolbar`)?.classList.toggle("hidden", true);
  }

  /**
   * Keeps the favourites in step with pdf.js: they work whenever its drawing
   * tools do, and show as pressed while their tool is on with their settings.
   * A tool a favourite turned on keeps its option box closed, which pdf.js
   * opened just before, since its event bus calls other listeners after its
   * own (web/event_utils.js).
   *
   * @param {any} app
   */
  function followFavourites(app) {
    app.eventBus.on("annotationeditormodechanged", (/** @type {{ mode: number }} */ { mode }) => {
      toolsEnabled = mode !== EDITOR_DISABLE;
      if (favouritesBar) favouritesBar.moreButton.disabled = !toolsEnabled;
      if (toolsMenu) toolsMenu.button.disabled = !toolsEnabled;
      for (const { button, item } of favouriteButtons) {
        button.disabled = item.disabled = !toolsEnabled;
      }
      const tool = Object.keys(FAVOURITE_TOOLS).find((name) => FAVOURITE_TOOLS[name].mode === mode);
      if (tool && mode === favouriteMode) closeOptionBox(/** @type {Favourite["tool"]} */ (tool));
      favouriteMode = null;
      updateFavouritesPressed(app);
    });
    // The settings pdf.js shows change: the user's, a selected drawing's or a favourite's.
    for (const name of ["switchannotationeditorparams", "annotationeditorparamschanged"]) {
      app.eventBus.on(name, () => updateFavouritesPressed(app));
    }
  }

  /**
   * Adds one button for the drawing tools, before them, for the toolbar's
   * step that has no room for them (`pdflionToolbarTools`), which
   * overrides.css shows it at, with their buttons out of sight. It shows the
   * tool that's on, and its menu has them all. The tools' option boxes still
   * open from their own places, which are then at its right.
   *
   * @param {any} app
   * @returns {ToolsMenu | null}
   */
  function addToolsMenu(app) {
    const tools = document.getElementById("editorModeButtons");
    if (!tools) return null;
    const button = makeButton("pdflionToolsButton", "toolbarButton", t("drawingTools"));
    button.disabled = true;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-controls", "pdflionToolsMenu");
    const items = createElement("div", { className: "menuContainer", role: "menu" });
    const menu = createElement(
      "div",
      { id: "pdflionToolsMenu", className: "editorParamsToolbar hidden doorHangerRight menu" },
      items,
    );
    tools.before(
      createElement(
        "div",
        { id: "pdflionTools", className: "toolbarButtonWithContainer" },
        button,
        menu,
      ),
    );
    // Before followMenu()'s own listeners, which open it.
    button.addEventListener("click", () => fillToolsMenu(app));
    button.addEventListener("keydown", () => fillToolsMenu(app));
    return { button, items, closeMenu: followMenu(button, menu, items) };
  }

  /**
   * Adds a narrow button in place of pdf.js's zoom select, #scaleSelect,
   * which overrides.css hides. The button shows an icon for a named zoom,
   * such as Page Width, and the percentage for any other. Its menu lists the
   * select's choices, in pdf.js's words, the named ones with their icons, and
   * choosing one picks it in the select, whose change pdf.js follows.
   *
   * @param {any} app
   * @returns {ZoomMenu | null}
   */
  function addZoomMenu(app) {
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById("scaleSelect"));
    const container = document.getElementById("scaleSelectContainer");
    if (!select || !container) return null;
    const button = makeButton("pdflionZoomButton", "toolbarButton", t("zoom"));
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-controls", "pdflionZoomMenu");
    const items = createElement("div", { className: "menuContainer", role: "menu" });
    const menu = createElement(
      "div",
      { id: "pdflionZoomMenu", className: "editorParamsToolbar hidden doorHanger menu" },
      items,
    );
    container.after(
      createElement(
        "div",
        { id: "pdflionZoom", className: "toolbarButtonWithContainer" },
        button,
        menu,
      ),
    );
    // Before followMenu()'s own listeners, which open it.
    button.addEventListener("click", () => fillZoomMenu(app));
    button.addEventListener("keydown", () => fillZoomMenu(app));
    followMenu(button, menu, items);
    return { button, items };
  }

  /**
   * Fills the zoom menu with the zoom select's choices, the chosen one
   * checked. pdf.js translates their labels, so they're read each time.
   *
   * @param {any} app
   */
  function fillZoomMenu(app) {
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById("scaleSelect"));
    if (!zoomMenu || !select) return;
    const entries = [...select.options]
      .filter((option) => !option.hidden && !option.disabled)
      .map((option) => {
        const label = option.textContent?.trim() || option.value;
        const item = makeButton(
          `pdflionZoom-${option.value}`,
          "toolbarButton labeled pdflionZoomItem",
          label,
        );
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(option.selected));
        item.setAttribute("data-zoom", option.value);
        item.tabIndex = -1;
        item.addEventListener("click", () => {
          select.value = option.value;
          select.dispatchEvent(new Event("change"));
          app.pdfViewer?.focus();
        });
        return item;
      });
    zoomMenu.items.replaceChildren(...entries);
  }

  /**
   * Keeps the zoom button showing the zoom: a named zoom's icon, and else
   * the percentage, as pdf.js shows it in its select.
   *
   * @param {any} app
   */
  function followZoomMenu(app) {
    const show = () => {
      if (!zoomMenu) return;
      const { button } = zoomMenu;
      const value = app.pdfViewer?.currentScaleValue;
      const scale = app.pdfViewer?.currentScale;
      const named = typeof value === "string" && ZOOM_NAMES.includes(value);
      const percent = `${Math.round((scale || 1) * 100)}%`;
      const select = /** @type {HTMLSelectElement | null} */ (
        document.getElementById("scaleSelect")
      );
      const label = named
        ? select?.selectedOptions[0]?.textContent?.trim() || value
        : percent;
      if (named) button.setAttribute("data-zoom", value);
      else button.removeAttribute("data-zoom");
      button.classList.toggle("pdflionZoomPercent", !named);
      const text = /** @type {HTMLElement} */ (button.firstElementChild);
      text.textContent = named ? label : percent;
      button.title = named ? `${label} (${percent})` : percent;
    };
    app.eventBus.on("scalechanging", () => show());
    app.eventBus.on("pagesinit", () => show());
    show();
  }

  /**
   * Fills the drawing tools' menu with the tools pdf.js shows, the one that's
   * on checked. Choosing one clicks its button. At the toolbar's last step,
   * Undo and Redo come first, while a tool is on.
   *
   * @param {any} app
   */
  function fillToolsMenu(app) {
    if (!toolsMenu) return;
    /** @type {HTMLElement[]} */
    const entries = [];
    const undoGroup = undoButtons[0]?.parentElement;
    const last = document
      .getElementById("toolbarContainer")
      ?.classList.contains("pdflionToolbarMinimal");
    if (last && undoGroup && !undoGroup.hidden) {
      for (const button of undoButtons) {
        const item = makeButton(`${button.id}Item`, "toolbarButton labeled", button.title);
        item.setAttribute("role", "menuitem");
        item.tabIndex = -1;
        item.addEventListener("click", () => button.click());
        entries.push(item);
      }
      entries.push(createElement("div", { className: "horizontalToolbarSeparator" }));
    }
    for (const tool of toolButtons()) {
      const label = tool.textContent?.trim() || tool.title;
      const item = makeButton(`${tool.id}Item`, "toolbarButton labeled pdflionToolItem", label);
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(isToolOn(tool)));
      item.setAttribute("data-tool", tool.id);
      item.tabIndex = -1;
      item.disabled = tool.disabled;
      item.addEventListener("click", () => tool.click());
      entries.push(item);
    }
    toolsMenu.items.replaceChildren(...entries);
  }

  /**
   * @returns {HTMLButtonElement[]} the drawing tools' buttons pdf.js shows,
   *   the eraser's among them, but not a signed document's, which stays
   */
  function toolButtons() {
    const containers = document.querySelectorAll(
      "#editorModeButtons > .toolbarButtonWithContainer:not(#signatureProperties, [hidden])",
    );
    return /** @type {HTMLButtonElement[]} */ (
      [...containers]
        .map((container) => container.querySelector(":scope > .toolbarButton"))
        .filter(
          (button) => button?.tagName === "BUTTON" && !(/** @type {HTMLElement} */ (button).hidden),
        )
    );
  }

  /**
   * @param {HTMLButtonElement} tool
   * @returns {boolean} whether it's on: pdf.js shows Pencil on while the
   *   eraser is
   */
  function isToolOn(tool) {
    return erasing ? tool === eraserTool?.button : tool.classList.contains("toggled");
  }

  /** Shows the tool that's on on the tools' button, which overrides.css draws. */
  function showActiveTool() {
    if (!toolsMenu) return;
    const on = toolButtons().find(isToolOn);
    const { button } = toolsMenu;
    if (on) button.setAttribute("data-tool", on.id);
    else button.removeAttribute("data-tool");
    button.classList.toggle("toggled", !!on);
  }

  /**
   * Keeps the tools' button showing the tool that's on, after pdf.js has
   * shown it on its own button.
   *
   * @param {any} app
   */
  function followToolsMenu(app) {
    app.eventBus.on("annotationeditormodechanged", () => showActiveTool());
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
