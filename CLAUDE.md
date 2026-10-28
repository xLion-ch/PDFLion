# PDFLion

A PDF viewer for macOS (Apple silicon and Intel), Windows and Linux (Ubuntu and Linux Mint): Mozilla's [pdf.js](https://github.com/mozilla/pdf.js) generic viewer wrapped in Electron. The shell stays thin. pdf.js does the rendering and provides the viewer UI. Electron adds what a browser tab can't: opening files from Finder, Explorer and Linux file managers, native menus and shortcuts, tabs that move between windows, saving in place, and packaging as a Mac app, a Windows installer and a Linux package.

[README.md](README.md) covers installing, building, and the checks to do by hand before a release.

## Ground rules

- **Never commit.** Not even when a plan or task says to. Leave the changes in the working tree, stage them if asked, and suggest a commit message. The user commits.
- **Never edit `vendor/pdf.js/`.** It is a git submodule pinned to an upstream release tag. All customisation happens outside it:
  - `src/viewer/bridge.js` is a main-world script that sets `PDFViewerApplicationOptions` and drives `PDFViewerApplication`.
  - `src/viewer/overrides.css` restyles the viewer UI in Material Design 3, with Material Symbols icons from `src/viewer/icons/`.
  - `src/viewer/geometry.js` is a main-world script with the eraser's geometry, for `bridge.js`. It touches nothing in pdf.js.
  - The `pdflion://` protocol handler (`src/main/protocol.js`) injects them into `viewer.html` as it serves it.

  If something seems to need a pdf.js patch, look for a way through those first. If there really is none, stop and ask.
- Prefer pdf.js's built-in behaviour over reimplementing it.
- `bridge.js` is the only code that touches pdf.js internals (`PDFViewerApplication`, its `eventBus`, `AppOptions`). These are not a stable API and change between releases. For example, `pdfSidebar` became `viewsManager`, and `isEvalSupported` was removed. Check names against `vendor/pdf.js/web/app.js` and `web/app_options.js` for the pinned version, never from memory.
- The app runs on macOS, Windows and Linux (Ubuntu and Linux Mint) and follows each platform's conventions. On all three, each document gets its own tab, in PDFLion's own tab strip, and opens in the frontmost window.
  - macOS: the menu bar, ⌘ shortcuts, and the app keeps running after its last window closes.
  - Windows: a menu bar in each window, Ctrl shortcuts, and the app quits when its last window closes. A PDF opened while PDFLion runs goes to the running process.
  - Linux: like Windows, except for File > Quit with Ctrl+Q where Windows has Exit, GTK's About dialog, and GNOME's button order in the save prompt, with Save rightmost.

  Branch on `process.platform === "darwin"` in the module concerned, and on `"win32"` or `"linux"` where those two differ. Before relying on an Electron API, check its `@platform` in `node_modules/electron/electron.d.ts`. Many window and menu APIs, such as `isDocumentEdited()` and the `recentDocuments` role, are macOS only. Others leave out Linux, such as `app.addRecentDocument()`, `setAppUserModelId()`, a window's `moved`, `resized` and `query-session-end` events, and the About panel's `credits`.
- Code is written on a Mac. Anything Windows- or Linux-specific stays unverified until it has run on a Windows PC or a Linux PC, so say so when reporting it.

## Stack

- Electron (latest stable), main process as ES modules (`"type": "module"`).
- Plain JavaScript with JSDoc. No TypeScript, no bundler, no UI framework, because the UI is pdf.js's.
- The preload is CommonJS (`preload.cjs`), because sandboxed preloads can't be ES modules.
- [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib), an MIT fork of pdf-lib, the one production dependency, pinned to an exact version. It runs only in the sandboxed viewer, never in main, since it parses the documents. `bridge.js` loads its browser build, `dist/pdf-lib.min.js`, from `/lib/` the first time a page change needs it. That build bundles its own dependencies. When updating it, check what it bundles against the "@cantoo/pdf-lib includes" group in `credits.js` and README's Credits.
- electron-builder for packaging: a `.dmg` and `.zip` for each Mac architecture (arm64, x64), an NSIS installer for Windows (x64), and a `.deb` for Linux (x64). Nothing is signed with a certificate or notarized, by choice. Mac builds are signed ad hoc, because Apple silicon runs only signed code.
- Node 24 LTS (`.nvmrc`). The pdf.js build requires Node `>=22.22.3 || >=24.15.0 || >=26.0`.

## Layout


```
src/main/        main process: one module per concern
  main.js        app lifecycle, open-file queue, single-instance lock (Windows and Linux)
  arguments.js   files from the command line and from a second instance, as paths or file:// URIs (Electron-free, unit tested)
  protocol.js    pdflion:// scheme handler
  routes.js      pdflion:// URL layout: viewer URLs, /doc/ tokens, mount paths. Electron-free so unit tests can import it
  ranges.js      Range headers for /doc/ (Electron-free, unit tested)
  documents.js   token registry for opened files and untitled documents, atomic writes (Electron-free, unit tested)
  blank.js       the blank PDF File > New opens, and its paper size by region (Electron-free, unit tested)
  saving.js      Save and Save As: dialogs and error alerts
  pages.js       the alerts and prompts about changing pages, from fixed lists (pdflion:page-dialog)
  unsaved.js     save prompts when an edited tab or window closes, the app quits, a Windows session ends, or Linux shuts down
  windows.js     document windows: where they open, which is in front, opening documents as tabs, the Open panel, moving tabs to new windows
  tabs.js        one tab per document, File > New's untitled ones too: its WebContentsView, edited state and navigation guards, the window's layout and title, the strip's state
  tablist.js     each window's tabs in order and its active tab (Electron-free, unit tested)
  strip.js       the tab strip's messages (sender and payload checks), its context menu, dragging tabs between windows
  placement.js   where a new window opens: the last window's place, on screen, cascaded (Electron-free, unit tested)
  state.js       userData/state.json: the last window placement, the tool settings and, on Windows and Linux, recent documents
  tools.js       the tool settings PDFLion remembers, checked: the eraser's mode and size, and favourites (Electron-free, unit tested)
  toolsettings.js  keeps the tool settings in state.json for every tab: the viewer's channels for them, and a favourite's context menu
  recent.js      recent documents, plus PDFLion's own list for File > Open Recent on Windows and Linux
  ipc.js         the viewer's IPC handlers (sender and payload checks), runCommand() to a tab's bridge.js
  permissions.js web permission handlers: deny all but full screen and clipboard writes
  menu.js        native menu, with items for macOS only or for Windows and Linux, and the About panel
  credits.js     the third-party projects the About panel lists (Electron-free, unit tested)
  paths.js       the only place that knows dev vs packaged locations
src/preload/
  preload.cjs    contextBridge API exposed as window.pdflion, to the viewer
  tabs.cjs       contextBridge API exposed as window.pdflionTabs, to the tab strip
src/tabs/        served at pdflion://app/tabs/: tabs.html, tabs.css, tabs.js, each window's tab strip
src/viewer/      served at pdflion://app/pdflion/, injected into viewer.html
  bridge.js
  geometry.js    the eraser's geometry: strokes as x, y pairs, cut by a circle (pdf.js-free, unit tested)
  overrides.css  Material Design 3 theme, mostly through the variables viewer.css reads
  icons/         Material Symbols (Apache-2.0) for the toolbar and menus
resources/       icon, entitlements (electron-builder buildResources); about-icon.png also ships in the app
scripts/
  update-pdfjs.js  plain Node, so it runs on Windows too
  build.js         tests, then every app version this machine can build, into dist/
test/unit/       node --test, files named *.test.js
test/e2e/        Playwright against the dev app, each launch with its own --user-data-dir
vendor/pdf.js/   submodule, never edit
electron-builder.yml  packaging: targets, file associations, Electron fuses
```

## Commands

```sh
git clone --recurse-submodules https://github.com/xLion-ch/PDFLion.git
npm install
npm run pdfjs:build      # build the pinned pdf.js viewer (once per clone and after each update)
npm start                # run in dev; npm start -- path/to/file.pdf opens a file
npm test                 # unit tests
npm run test:e2e         # end-to-end tests: they open windows and take focus while they run
npm run build            # tests, then every version this machine can build, in dist/ (no CI: run it on a Mac, on Windows and on Linux)
npm run dist             # installers for this platform in dist/: Mac .dmg/.zip (arm64 and x64), the Windows .exe, or the Linux .deb
npm run dist -- --dir    # just the apps in dist/, without installers
```

## pdf.js

- The submodule at `vendor/pdf.js` uses full history on purpose. pdf.js computes its version from git history, so a shallow clone builds as `x.y.0`.
- `scripts/update-pdfjs.js` manages it. Run it through npm (`pdfjs:check`, `pdfjs:update`, `pdfjs:build`):
  - With no argument, it switches to the latest release tag, builds it and stages the submodule.
  - With `vX.Y.Z`, it switches to that release.
  - `--check` prints the pinned and latest versions and changes nothing.
  - `--build` rebuilds the pinned release.
  - `--build-if-missing` builds it only if there is no build yet. `npm start` runs this first.
- The build output is `vendor/pdf.js/build/generic/`, plus `build/version.json`. pdf.js's own `.gitignore` covers it, so the submodule stays clean. In dev the app serves it from there. Packaged builds copy it to `pdfjs` in the app's resources directory: `Contents/Resources/` on macOS, `resources\` on Windows, `/opt/PDFLion/resources/` on Linux.
- Updating to a new release:
  1. Run `npm run pdfjs:update`.
  2. Read the upstream release notes.
  3. Check `bridge.js` and `overrides.css` against the new `web/app.js` and `web/viewer.html`. That includes `isMenuShortcut` in `bridge.js` against pdf.js's key handling in `onKeyDown` (`web/app.js`) and `web/pdf_print_service.js`, for ⌘ on macOS and for Ctrl and F4 on Windows, and that pdf.js still binds none of the tab shortcuts (see Menu commands). Also check what `bridge.js` uses for page changes against the files its header lists: `open({ data, filename })`, `_docFilename`, `initialBookmark`, `initialRotation`, the `viewOnLoad` option, the `documentinit` and `metadataloaded` events, `pdfViewer.pagesPromise`, the `getMetadata()` flags `EncryptFilterName` and `IsSignaturesPresent`, `isPureXfa`, `AnnotationEditorPrefix`, and `#editorModeSeparator`, before which the Insert Blank Page button goes. For the page tools, check the `enableSplitMerge` and `enableMerge` options, `pdfThumbnailViewer.hasStructuralChanges()` and `getStructuralChanges()`, `pdfDocument.pagesMapper.getMapping()`, `extractPages()`, the `pagesedited` event, `onSaveAndLoad()` and the `pageInfos` with `insertAfter` that `#mergeFiles` in `web/pdf_thumbnail_viewer.js` hands it, `pdfViewer.pagesCount`, `#viewsManagerStatusWaitingCloseButton`, and the `isDraggingFile` class on `#thumbnailsView` that `preload.cjs` reads. For `guardPageTools()`, check the listeners in `web/pdf_thumbnail_viewer.js` it goes before (the thumbnails' `pointerdown`, `dragenter`, `drop` and `keydown`, and the picker's `change`), `DRAG_THRESHOLD_IN_PIXELS`, the ids of the Manage menu's items and of Add file's picker, and how `web/menu.js` closes the menu on a click. For `findDroppable()`, check what `extractPages()` writes into the new catalog (`#makeRoot` and `isSingleFile` in `src/core/editor/pdf_editor.js`), `getOptionalContentConfig()`, `getJSActions()`, `getViewerPreferences()`, `getOpenAction()`, `getPageMode()` and `getPageLayout()` with their defaults in `src/core/catalog.js`, `getMarkInfo()`, which answers a `Map`, `getPageLabels()`, and `getMetadata()`'s `metadata` and `info.Language`. For the page overview, check `SidebarView` in `web/ui_utils.js`, the views manager's `switchView()`, `visibleView` and `close()` and the `sidebarviewchanged` event it dispatches (`web/views_manager.js`), `onResizing()` in `web/sidebar.js` and the `--viewsManager-width` it sets, that `web/pdf_thumbnail_viewer.js` still works out where the thumbnails are on a `resize` from the views manager and still lays them out with `--thumbnail-width` and `--gap-between-input-and-thumbnail`, the ids the overview uses (`#viewsManagerToggleButton`, after which its button goes, `#viewsManagerAddFileButton`, before which its page tools go, `#viewsManagerTitle`, `#viewsManagerSelector`, `#viewsManagerResizer`), `aria-current` on the current thumbnail, the `isDragging` class on `#thumbnailsView`, `pdfViewer.focus()`, and that `onKeyDown` prevents the default of an Esc it acts on. For the eraser, check the editor internals it uses: `pdfViewer._layerProperties.annotationEditorUIManager`, `pdfViewer.annotationEditorMode`, the `switchannotationeditormode`, `annotationeditormodechanged` and `editingaction` events, the UI manager's `getEditors()`, `getLayer()`, `unselectAll()` (which commits a drawing session and returns), `addCommands()`, `addEditor()`, `addToAnnotationStorage()` and `isEditorHandlingKeyboard`, the editors' `editorType`, `pageIndex`, `remove()` and `serialize(true)` with `paths.points` and `thickness`, the layer's `addOrRebuild()`, and the page views' `div` and `viewport` (`convertToPdfPoint()`, `scale`). Also check `AnnotationEditorType` in `src/shared/util.js`, `textInputChecker` in `src/display/editor/tools.js`, that ink mode still shows Pencil on with its option box (`toggleExpandedBtn` in `web/toolbar.js`), that Pencil's click still switches ink mode off while its button shows on, the ids `#editorInk`, `#editorInkButton` and `#editorInkParamsToolbar`, and `.page[data-page-number]` in `#viewerContainer`. For rotating pages, check how `get rotate()` in `src/core/document.js` reads a page's `/Rotate`, which `rightAngle()` in `bridge.js` repeats, and that a click on a thumbnail's checkbox still selects its page (the thumbnails' `click` listener in `web/pdf_thumbnail_viewer.js`), which `checkThumbnail()` relies on to check pages again after `reopen()`. Check whether undoing a deletion still leaves the wrong page in the page cache (`updatePageNumber` in `web/pdf_page_view.js`, `updatePage` in `src/display/api.js`): if not, `recachePages()` can go. Also check the range transport in `bridge.js` against `PDFDataRangeTransport` (`src/display/api.js`) and `src/display/transport_stream.js`, and against `getNetworkStream` (`src/display/network_stream.js`), in case pdf.js now makes range requests for other schemes itself. Check the variables and selectors in `overrides.css` against `web/viewer.css`: pdf.js renames them, and a missing one fails silently, leaving that part in pdf.js's own style. Also check the CSP header in `protocol.js` against the `<meta>` CSP in `web/viewer.html`. Chromium enforces both, so the header must not be stricter than what pdf.js needs.
  4. Check what pdf.js bundles against the "pdf.js includes" group in `src/main/credits.js` and README's Credits: the projects in `vendor/pdf.js/external/` and the license files in the build's `web/` folders. A release can add or drop one.
  5. Run the unit and e2e tests on macOS and Windows.
  6. Stage the submodule bump plus any bridge fixes it required, and suggest the commit message `Update pdf.js to vX.Y.Z`. The user commits.

## How the viewer is served

Everything a window loads comes from the custom privileged scheme `pdflion://app/` (standard, secure, fetch, stream):

| Path | Serves |
|---|---|
| `/viewer/…` | the pdf.js generic build. For `web/viewer.html`, the handler injects `overrides.css`, `geometry.js` and `bridge.js` before `</head>` and adds a CSP header |
| `/pdflion/…` | `src/viewer/` |
| `/tabs/…` | `src/tabs/`. `tabs.html` gets a CSP header of its own: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'` |
| `/lib/…` | @cantoo/pdf-lib's `dist/`, of which only `pdf-lib.min.js` is packaged |
| `/doc/<token>/<name>.pdf` | a file the user opened, or an untitled document from File > New, whole or as byte ranges. The main process mints tokens, so the renderer can only read files the user chose and documents PDFLion made |

A window is a `BrowserWindow` whose own page is the tab strip, `pdflion://app/tabs/tabs.html`. Each tab is a `WebContentsView` that loads `pdflion://app/viewer/web/viewer.html?file=/doc/<token>/<name>.pdf`. It sits below the strip, or covers the whole window while the window has one tab or the page is full screen, which hides the strip. Moving a tab to another window moves its view, so the page and its unsaved changes come along without a reload. Main keys documents, edited state and commands by tab, not by window.
- The document must be same-origin, because the generic viewer rejects a `file=` from any other origin.
- `bridge.js` sets `defaultUrl` to `""` so the pdf.js demo PDF never opens.
- `bridge.js` is a classic script. It runs before the viewer's module scripts, so its `webviewerloaded` listener is in place before the viewer initialises.
- pdf.js makes range requests only for http(s) URLs, so `bridge.js` opens `/doc/` URLs through a `PDFDataRangeTransport`. It streams the file and fetches the parts pdf.js needs sooner as byte ranges, with `If-Match` so that a changed file gets 412.
- The handler resolves every path against its root and returns 404 for anything that escapes it.
- An untitled document (`blank.js`, `documents.registerUntitled`) lives in main's memory until its first save, and `/doc/` serves it from there with a fixed `ETag`. Its tab is named `Untitled.pdf`, `Untitled 2.pdf` and so on. Save on it always means Save As, edited or not: `runCommand()` sends `saveAs` for `save`, which also covers the Save button of the save prompts. Save As then turns its token into a file token (`documents.update`).

## Page changes

pdf.js's page tools are on (`enableSplitMerge`, `enableMerge`), in the sidebar's thumbnails. `bridge.js` fits them into PDFLion's saving and edited state:

- Pages checked in the thumbnails can be dragged to a new place, and the Manage menu copies, cuts, deletes and exports them, with pasting and an undo bar. These changes stay in the viewer (`pagesMapper`, `src/display/pages_mapper.js`) until Save.
- Save writes the new file `extractPages()` makes of them, with typed form values (`currentBytes()`), then `reopen()`s the bytes it wrote, so the tab matches the file and the page tools start afresh. If anything changed while the file was being written, the tab keeps the document as it is, edited, instead.
- They count as edits while the order of the pages differs from the document's own (`hasPageChanges()`). pdf.js's `hasStructuralChanges()` stays true after an Undo, and after a Copy that was never pasted.
- Add file, and PDFs or images dropped on the thumbnails, add pages through `onSaveAndLoad()`. `bridge.js` replaces it before pdf.js binds it, so that it works like Insert Blank Page below: one change at a time, the locks and the signing prompt first, typed form values kept, and the document as it was if the result has no new pages or doesn't open. `preload.cjs` lets PDFs dropped on the thumbnails through to pdf.js while `#thumbnailsView` has `isDraggingFile`. Dropped anywhere else, they open as tabs.
- pdf.js caches pages by their place for `getPage()`, which printing and Find use, and an undone deletion leaves the wrong page cached there. `recachePages()` caches each page shown at its place again after every page edit.
- `guardPageTools()` captures the events of the page tools' changes on window, before pdf.js's own listeners: a press on a thumbnail, files dragged onto the thumbnails or dropped there, clicks on Copy, Cut and Delete in the Manage menu, their keys in the thumbnails, and Add file's picker. A click on a thumbnail still goes to its page.
  - A locked document (see below) gets `pdflionPagesLocked` on `#outerContainer`, and `overrides.css` hides the thumbnails' checkboxes, the Manage menu and Add file. Its thumbnails take neither drags nor files.
  - A signed document asks before the first change, through `confirmPageChange()`. A click, a key, a drop or Add file's files wait for the answer and then go ahead. A drag can't be replayed: it asks once the press has moved as far as pdf.js needs to start one, and after Change Pages the next drag moves pages.
- A save that writes a new file through `extractPages()` first asks with `pageDialog("rewrite", items)` whether to drop what the file holds and the new file won't (`confirmRewrite()`). `findDroppable()` finds out what that is when the document opens and after each save: XMP metadata, layers, document scripts, viewer settings (preferences, open action, page mode and layout), tagging (`MarkInfo`) and the language (`Lang`). The Info entries (title, author, subject, keywords) and page labels count only when the new file is made of several: after Add file, or with copied pages and typed form values. That's a save with page changes, or after Add file. It's also a save after Insert Blank Page or a rotation that came after page changes not saved yet: `changeDocument()` starts from `currentBytes()`, which writes them as a new file. `newFile` keeps track of that until the next save. Each item is asked about once per tab, and a document holding none of them saves without asking.

The page overview, from View > Page Overview or its toolbar button right of the sidebar's, shows the same thumbnails across the viewer area. It's pdf.js's views manager on its thumbnails, which `overrides.css` makes a grid while `#outerContainer` has `pdflionPageOverview`. Its button, the menu item, Esc and a double-click on a page close it, and the sidebar shows what it showed before.

- The document stays where it was, hidden behind the overview, at its zoom. pdf.js would move it aside by `--viewsManager-width`, so `bridge.js` keeps the views manager's `onResizing()` from changing that while the overview is open.
- pdf.js works out where the thumbnails are, for dragging pages, on a `resize` from the views manager. `bridge.js` sends one whenever they move: the overview opening and closing, the window resizing while it's open, and `reopen()`. Otherwise pages dragged in the grid would land where the sidebar's column had them.
- Its header has PDFLion's own page tools before Add file: Rotate Pages Left and Right, which turn the checked pages, or else the current one, and Insert Blank Page, which in the overview goes after the last checked page, or the current one. A locked document hides them, as it hides pdf.js's.
- `reopen()` keeps it open, as it keeps the sidebar: pdf.js switching views while the document loads doesn't close it. pdf.js's own sidebar button and F4 close the views manager, and the overview with it.

pdf.js can't insert or rotate pages, so Insert Blank Page and the overview's Rotate Pages Left and Right go through @cantoo/pdf-lib, in `bridge.js`. Rotating sets a page's `/Rotate` a quarter turn from the angle pdf.js shows it at, which counts an angle that isn't a quarter turn as none. View > Rotate Left and Right turn only the view, which isn't saved.

- `currentBytes()` takes the document as Save would write it, with typed form values and annotations. The library appends the change to those bytes as an incremental update (`forIncrementalUpdate`, and `updateMetadata: false` to leave the Info dictionary alone), so the file's original bytes, metadata, layers, scripts, page labels and signed revisions stay as they were.
- `reopen()` then shows the result in the same tab, as pdf.js's own `onSaveAndLoad()` does. It keeps the URL, the file name, the zoom, rotation, scroll and spread modes and the sidebar, and goes to the given page through pdf.js's `initialBookmark`. It checks the same thumbnails again after a rotation (`selection`), with clicks, so that pdf.js selects those pages too. The changed document has the same fingerprint, so `reopen()` sets `viewOnLoad` to `INITIAL` while it loads: otherwise pdf.js would show it where its history left the old one. The document then counts as edited until it's saved.
- If the library can't read the document, or pdf.js can't open the result (`pagesPromise` rejects), the tab gets the bytes it had back and an alert says the pages couldn't be changed.
- One busy flag covers Save and page changes, so none starts while another runs.
- Documents with a password, even an owner password only, and pure XFA forms are locked against page changes: the library's increments to encrypted files aren't reliable. Insert Blank Page and Add file say why, Insert Blank Page's toolbar button is disabled, and the overview hides its page tools. A signed document (`SigFlags` with SignaturesExist) asks once before its first page change, and the answer lasts as long as the tab.
- The page names what an alert or prompt is about through `pdflion:page-dialog`, and `pages.js` words it.

## Eraser

The eraser is a drawing tool of PDFLion's, after Pencil (`#editorInk`) in the toolbar: `#pdflionEditorEraserButton`, with an option box like pdf.js's tools have. It erases Pencil's drawings, and the file's own ink annotations, which pdf.js turns into editors in ink mode. `bridge.js` builds it, `geometry.js` works out what it touches, and `overrides.css` styles it.

- It works in pdf.js's ink mode. Turning it on first makes the strokes of Pencil's open drawing session one drawing (`uiManager.unselectAll()`, twice, since the first only commits the session). pdf.js then shows Pencil on, with its option box: under `pdflionErasing` on `#outerContainer`, `overrides.css` shows them off.
- While it's on, a capture listener on `#viewerContainer` takes presses on pages before pdf.js, which would draw. The drag's moves and release are captured on window.
- Another tool, the eraser's button and Esc turn it off, the last two to no tool. Pencil's button would turn ink mode off, since it shows as on, so a capture listener catches its click and just stops erasing. Esc leaves it on when pdf.js or the page overview used the key.
- Object mode removes each Pencil drawing it touches, whole: an ink editor, which holds every stroke of one drawing session. Only `editorType` `"ink"`, since signatures are drawings too, and free highlights serialize to nothing. It reads each editor's strokes once per drag (`serialize(true).paths.points`), fills in the path between pointer events with `resample()`, and tests with `hitsStroke()`, at the eraser's radius plus half the stroke's thickness.
- A drag is one step to undo (`uiManager.addCommands()` once the drag ends, with `mustExec: false`). Undo puts the editors back as pdf.js's own undo of Delete does: `addOrRebuild()` on their page's layer, or `addEditor()` and `addToAnnotationStorage()` without one.
- Line mode, which cuts strokes, isn't in yet: its choice is disabled, and the eraser erases objects whatever the setting.
- The mode and size are `window.pdflion`'s tool settings (`toolsettings.js`), the same in every tab. Without a stored choice, it erases objects at 10 pt.
- The circle cursor is a `div`, `#pdflionEraserCursor`, as wide as the eraser at the page's zoom (`viewport.scale`), since a CSS cursor can't grow that large. While erasing, pages show no other cursor, and take `touch-action: none`.

## Menu commands

- Menu items that act on the document come from `commandItem()` in `menu.js`. A click calls `runCommand(tab, command)` in `ipc.js` for the focused window's active tab, which sends the command to that tab's `bridge.js`, and `COMMANDS` there maps it to pdf.js. A new command needs all three, plus an end-to-end test.
- Edit > Insert Blank Page and View > Page Overview have no shortcut yet: they get theirs together with the eraser.
- Edit > Undo and Redo aren't roles: Chromium's undo and redo, which the roles call, act on editable text only, and don't reach pdf.js's history of annotations. `undoItem()` in `menu.js` sends `undo` or `redo` to `bridge.js` first, which dispatches pdf.js's `editingaction` while a drawing tool is on and no text is being typed, and answers false otherwise. Then main calls `webContents.undo()` or `redo()`, as the roles do. Their shortcuts are the roles'. pdf.js handles ⌘Z and ⇧⌘Z itself in a drawing tool, before the menu sees them.
- Menu items that act on tabs (Show Next Tab, Move Tab to New Window, …) come from `tabItem()` in `menu.js` and run in main. They're in the Window menu on macOS and at the end of View on Windows and Linux, and disabled where they can't act. File > Close Tab asks about unsaved changes through `unsaved.js`.
- The page sees key presses before the native menu, on every platform alike, and the menu only gets the ones the page leaves unhandled. `isMenuShortcut` in `bridge.js` keeps pdf.js from acting on the shortcuts it shares with the menu. A new shortcut that pdf.js also binds needs adding there. pdf.js binds none of the tab shortcuts (⌃Tab, ⌃⇧Tab, ⇧⌘], ⇧⌘[, Ctrl+Page Down, Ctrl+Page Up).
- A click on the native menu gives the page no user activation, which some web APIs need, such as `requestFullscreen()` for Presentation Mode. `runCommand()` grants it for the commands in `COMMANDS_NEEDING_ACTIVATION`.
- Menu labels mark Windows and Linux access keys with `&`, as in `&File`. macOS drops the `&`. Write a literal `&` as `&&`.

## Security rules

- Every window and every tab's view uses `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`, and `app.enableSandbox()` sandboxes every renderer.
- The preloads expose small, explicit APIs through `contextBridge` and never expose `ipcRenderer` itself. `preload.cjs` exposes `window.pdflion` only on the viewer page, and `tabs.cjs` exposes `window.pdflionTabs` only on the tab strip, since a preload runs in every page its `webContents` shows.
- Main validates the sender and the payload of every IPC message. The tool settings' channels (`pdflion:get-tool-settings`, `pdflion:set-tool-settings` and `pdflion:favourite-menu`, in `toolsettings.js`) take only what `tools.js` accepts: the eraser's mode and size, and favourites of a known tool, with a `#rrggbb` colour and numbers within pdf.js's ranges for it, at most 500 of them. It rebuilds each from its known fields, so nothing else reaches `state.json`, and main sends the result to every tab as `pdflion:tool-settings-changed`. `pdflion:page-dialog` takes only a reason, and for `rewrite` the items, from the fixed lists in `pages.js`, which writes every word of the dialog. The sender must be the top frame, and its URL must be the viewer (`ipc.js`), or the tab strip for the strip's channels (`strip.js`). A strip message must also come from a window's own `webContents`, every tab id in it must be a tab of that window, and every index must be in range. Don't switch to comparing origins, as the Electron checklist suggests: an `about:blank` page the viewer navigates to has the viewer's origin, and the strip shares it too.
- Tab ids are random and unrelated to document tokens, since drags carry them out of the app. Main accepts a dropped tab only if a strip reported starting to drag that tab.
- Navigation away from `pdflion://app/viewer/` is blocked in tabs, and every navigation of the strip is blocked. External links (`http`, `https`, `mailto` only) open with `shell.openExternal`. Every other `window.open` is denied, and the strip's all are.
- `viewer.html` is served with a CSP: no `unsafe-eval`, and `wasm-unsafe-eval` for pdf.js's image decoders.
- @cantoo/pdf-lib parses documents, which are untrusted, so it runs only in the sandboxed viewer renderer, never in main.
- Permission requests and checks are denied, except `fullscreen` and `clipboard-sanitized-write` for the viewer (`permissions.js`). The strip gets none.
- The packaged app's Electron fuses (`electron-builder.yml`) turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect` and file:// privileges. They load the app only from `app.asar`, after checking its hash on macOS and Windows, and they encrypt cookies.

### Electron security checklist

Reviewed in October 2026, for Electron 45, against the [checklist](https://www.electronjs.org/docs/latest/tutorial/security). Items 1–4, 6–10, 13, 14, 16, 18 and 20 are met as the rules above describe. The rest:

- 5 (permission handlers): met, with handlers for requests and checks. PDFLion sets no device or screen-sharing handlers, so WebHID, Web Serial, WebUSB, Bluetooth and `getDisplayMedia` fail.
- 11, 12 (`<webview>`): not applicable. No window enables `webviewTag`, so no `will-attach-webview` handler.
- 13 (navigation): `will-navigate` doesn't fire for `about:blank` and `about:srcdoc`, which only page scripts can reach. Those pages get no `window.pdflion` or `window.pdflionTabs`, and main ignores their messages.
- 15 (`shell.openExternal`): links in PDFs are untrusted, and opening them is deliberate. Only `http`, `https` and `mailto` reach it.
- 17 (IPC senders): checks the frame's URL rather than its origin, as above, for the viewer's channels and the strip's.
- 19 (fuses): all set, see above. `LoadBrowserProcessSpecificV8Snapshot` stays off, because PDFLion has no browser-only snapshot. Electron checks the hash of `app.asar` only on macOS and Windows. On Linux, `EnableEmbeddedAsarIntegrityValidation` only makes it check its V8 snapshot, so nothing checks that `app.asar` is unchanged.
- Downloads keep Electron's default, a save dialog. pdf.js uses them for attachments, for a PDF script's Save As, and for the page tools' Export selected.

## Packaging

- `electron-builder.yml` configures it. `npm run dist` builds this platform's installers, and `npm run build` (`scripts/build.js`) runs the tests first, then builds everything the machine can.
- Mac builds are signed ad hoc (`identity: "-"`). Apple silicon runs only signed code, and flipping the fuses changes the signed Electron binary, so a build with signing skipped is killed at launch.
- `fileAssociations` uses `rank: Alternate`, so PDFLion appears in Finder's Open With without becoming the default viewer. On Windows the installer registers PDFLion as a PDF handler, so it appears under Open with. Windows never changes the default app without asking.
- The NSIS installer is one-click and per user: no admin rights, installed into `%LOCALAPPDATA%\Programs`.
- The pdf.js build doesn't depend on the platform, so every build ships the same `pdfjs/` folder, license files included.
- Of @cantoo/pdf-lib, `app.asar` holds only `dist/pdf-lib.min.js`, its licence and its `package.json`. The `files` patterns in `electron-builder.yml` leave out its other builds and its dependencies, which that build bundles, about 30 MB.
- electron-builder's `makensis` for macOS is an Intel binary, so building the Windows installer on Apple silicon needs Rosetta.
- On Linux, the `.deb` installs into `/opt/PDFLion`, with `pdflion` in `/usr/bin`. Its `.desktop` file is named after `desktopName` in `package.json`, which Electron also uses as the Wayland app ID and X11 WM_CLASS, so the dock groups the windows with their launcher. `Exec` ends in `%F`, so file managers pass paths rather than URIs.
- `linux.mimeTypes` lists PDFLion for `application/pdf`, so it appears under Open With in Files and Nemo without becoming the default. It isn't a `mimeType` in `fileAssociations`, because electron-builder would then also install a MIME definition for `application/pdf`, whose icon replaces the PDF icon in file managers.
- The sandbox stays on under Linux. The `.deb`'s post-install script makes `chrome-sandbox` setuid where user namespaces don't work. On Ubuntu 24.04 and later, which restrict them, it installs an AppArmor profile that allows them for `/opt/PDFLion/pdflion`.
- No AppImage: it can't carry a setuid helper, and Ubuntu 24.04 restricts the user namespaces the sandbox needs otherwise, so it would only run with `--no-sandbox`.
- The `.deb` is built on a Linux PC, where it can be tested. electron-builder can build it on a Mac too, but `npm run build` leaves it out there.

## Tests

- `npm test` runs `node --test "test/unit/**/*.test.js"`. The glob is quoted so Node expands it: since Node 21, `node --test` treats a directory argument as a file.
- Modules that unit tests import stay free of Electron: `arguments.js`, `routes.js`, `ranges.js`, `documents.js`, `blank.js`, `placement.js`, `tablist.js`, `tools.js` and `credits.js`.
- `bridge.test.js` runs `bridge.js` itself in `node:vm`, after `geometry.js` as `viewer.html` loads them, with stand-ins for `window.pdflion` and `PDFViewerApplication`. When the bridge starts using something new from the page, add it to the stand-ins. The test also reads `menu.js` for `commandItem("label", "command", …)` calls, to check that the bridge knows every command.
- `geometry.test.js` runs `geometry.js` in `node:vm` the same way. It answers `Float32Array`s from the script's own realm, so the tests compare them as arrays.
- `npm run test:e2e` drives the dev app with Playwright. Each launch gets its own `--user-data-dir`. `test/e2e/pdfs.js` writes the test PDFs, so no binary fixtures are committed. The few that would be hard to write, the tracemonkey paper and an encrypted document (`empty_protected.pdf`), come from the pdf.js submodule, and `writeProtected()` encrypts one with @cantoo/pdf-lib. The suite is the safety net for pdf.js updates, so it must cover every bridge command. `windows-linux.spec.js` runs only on Windows and Linux.
- Playwright lists each tab's viewer and each window's strip as pages, and `app.firstWindow()` is a strip. The helpers in `test/e2e/pdflion.js` find a document's page by its URL (`documentPage`), a page's strip by its window (`stripOf`, since every strip has the same URL), and count windows in main. `app.browserWindow(page)` works for a tab's page and gives its window. A tab that isn't shown doesn't render, so tests open tabs one at a time and wait for each.
- Playwright can't drag between windows. `tabs.spec.js` sends the strip's `dragStarted`, `drop` and `dragEnded` itself, and stubs `screen.getCursorScreenPoint()` for tearing off. It catches the tab context menu by replacing `Menu.prototype.popup`.
- In end-to-end tests, `page.evaluate()` counts as a user gesture. Where user activation matters, read the page from main with `readFromMain()`, which runs `webContents.executeJavaScript()` on the tab's page.

## Decisions

These were settled on purpose. Change them only on purpose.

- The bundle ID is `io.github.xlion-ch.pdflion`: `appId` in `electron-builder.yml`, repeated as `APP_ID` in `main.js`. Changing it after the first release resets user preferences and file associations. On Windows it is also the AppUserModelID, which groups the app's taskbar buttons with its Start menu shortcut.
- One build per Mac architecture, each about half the size of a universal build. The alternative is a single `universal` build, so nobody can download the wrong one.
- Windows x64 only. Windows on Arm runs it emulated. Adding `arm64` would run it natively there.
- Linux gets a `.deb` for x64, for Ubuntu 22.04 and Linux Mint 21 and later, and nothing else. AppImage would lose the sandbox on Ubuntu 24.04, and Flatpak and Snap bring their own confinement, which Electron's sandbox would have to fit into, and their own stores.
- File > New makes an untitled document in memory, with one blank page: US Letter in the regions CLDR lists for it, from `app.getLocaleCountryCode()`, and A4 everywhere else, including where the region is unknown. The first save asks where to put it, suggesting Documents. It counts as edited only once it changes, so closing it untouched asks nothing, as in TextEdit.
- Launching without a file shows the Open panel, like Preview. On Windows the app then quits if the panel is cancelled, because a Windows app without windows has nothing to show. The alternative is an empty viewer window.
- No code signing, no notarization, no CI and no auto-updates. Releases are built by hand, as the README describes. On macOS, auto-updates would need a Developer ID signature anyway: Electron's updater accepts only an update signed like the running app, and an ad-hoc signature differs with every build.
- The viewer follows Material Design 3, as CSS on top of pdf.js's own UI rather than a UI library. The colour scheme is Material's monochrome one: near-white in light mode, near-black in dark mode. Text uses the system font, not Roboto. Colours apply only outside forced-colors mode, which keeps pdf.js's high contrast styles.
- Page changes pdf.js can't make go through @cantoo/pdf-lib, as incremental updates, in the viewer renderer. pdf.js's own `extractPages()` writes a whole new file instead, which drops the title, page labels and password, among others. Upstream pdf-lib hasn't changed since 2022 and can't append increments. A library in main would parse untrusted documents outside the sandbox.
- Documents with a password and pure XFA forms are locked against page changes, and a signed document asks once before its first one.
- A save that writes a new file through `extractPages()` asks first, once, whether to drop what the document holds and the new file won't. A document holding none of it saves without asking.
- pdf.js's page tools are on, though pdf.js still counts them as experimental and leaves them off in its generic build. They move, copy, delete and add pages, with selection, dragging, pasting and undo, which PDFLion would otherwise have to rebuild. Their changes are saved as the new file `extractPages()` writes, which drops some of what the document holds (see Known limitations).
- Window placement is kept in `state.json`, not with Electron's `windowStatePersistence`. That remembers each window under a unique name, so it can't give a new document the last window's place.
- Tabs are PDFLion's own tab strip, the same on all three platforms, rather than macOS's native tabs there and a strip elsewhere. The end-to-end tests, which run on the Mac, then cover the code Windows and Linux run. The strip hides while a window has one tab. Windows have no `tabbingIdentifier`, so Electron disallows macOS's tabs, even with "Prefer tabs when opening documents: Always". Tab libraries such as electron-tabs are built on `<webview>`, which the security rules leave off.

## Known limitations

- The native menus are in English, and so are PDFLion's own toolbar button and its dialogs. The viewer, and the items macOS adds to the menus, follow the system language.
- Undo doesn't remove an inserted page, but deleting it in the thumbnails does. Nor does it undo a rotation, but rotating back does.
- The eraser erases whole drawings only, until Line mode is in. A drawing is everything Pencil drew in one go, until Esc or another tool, so it may hold several strokes. Erasing with a touchscreen or a pen hasn't been tried.
- Pages moved, copied, deleted or added with pdf.js's page tools are saved as a new file, through `extractPages()`, which keeps only part of what the old one held. PDFLion asks before the first such save (see Page changes). What each page change keeps:

  | Change | Made by | Keeps | Loses |
  |---|---|---|---|
  | Move, copy, delete pages | `extractPages()`, from the document alone | the Info dictionary's title, author, subject and keywords, page labels, the outline, forms, the structure tree, attachments, named destinations | XMP metadata, layers (`OCProperties`), document JavaScript, viewer preferences, the open action, the page mode and layout, `Lang`, `MarkInfo`, the file IDs, valid signatures. pdf.js also sets the Info dictionary's Creator, Producer and CreationDate anew |
  | Add pages from files, or copied pages with typed form values | `extractPages()`, from several files | the outline, forms, the structure tree, attachments, named destinations | all of the above, and the Info dictionary and page labels |
  | Insert a blank page | @cantoo/pdf-lib, as an incremental update | everything. A signed revision stays intact, but signature checks report changes after signing | nothing, but page labels number pages by position, so the labels after it shift |
  | Rotate pages | @cantoo/pdf-lib, as an incremental update | everything, as for a blank page | nothing |

  Copied pages with typed form values count as several files because `withFormValues()` gives each copy its own saved copy of the document. An insertion or rotation after page changes not saved yet starts from the new file those make, so it keeps only what that keeps. Documents with a password are locked against all of these, so none of them writes one without its password.
- On Wayland, which Ubuntu uses by default, apps can't place their windows, so new windows open where the compositor puts them rather than where the last one was, and a torn-off tab's window doesn't open under the pointer. Mint's Cinnamon uses X11, where placement works.
- On Wayland, PDFLion can't tell where the pointer is outside its windows, so it can't tell a tab dropped on the desktop from a drag cancelled with Esc. A tab that no window took tears off into a new window either way, a second after the drag ends.
- Real drags of tabs between windows haven't been tested automatically: Playwright can't drag between windows, and the tests send the strip's messages themselves. The checks by hand in README.md cover them.
- Shutting down Linux with unsaved changes holds off the shutdown while PDFLion asks about them, but only for as long as systemd allows (`InhibitDelayMaxSec`, 5 s by default). After that the changes are lost.
- Copying the text of a whole document fails if pdf.js needs more than about 5 s to gather it. Chromium then asks for `clipboard-read` instead of `clipboard-sanitized-write`, and `permissions.js` denies it.

## Conventions

- Small modules in `src/main/`, one responsibility each, and no catch-all `utils.js`.
- Dev-vs-packaged path logic lives only in `src/main/paths.js`.
- Every third-party project PDFLion uses goes into the About panel and the README, with its link and license: `CREDITS` in `src/main/credits.js`, and Credits in `README.md`. That includes what only builds or tests the app, what pdf.js or Electron brings along, and design resources such as icons and fonts. `credits.test.js` fails when the two don't list the same links.
- Commit messages use the imperative mood and a short subject, e.g. `Add native File menu`.
