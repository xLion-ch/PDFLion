# PDFLion

A PDF viewer for macOS (Apple silicon and Intel), Windows and Linux (Ubuntu and Linux Mint): Mozilla's [pdf.js](https://github.com/mozilla/pdf.js) generic viewer in Electron. pdf.js renders and provides the viewer UI. The Electron shell stays thin, and adds what a browser tab can't: opening files from the file manager, native menus and shortcuts, tabs that move between windows, saving in place, installers, and updates from GitHub releases.

[README.md](README.md) covers installing, building, releasing, and the checks by hand before merging into `main`, since every push there is a release.

## Ground rules

- **Never commit.** Not even when a task says to. Leave the changes in the working tree, stage them if asked, and suggest a commit message. The user commits.
- **Never edit `vendor/pdf.js/`**, a submodule pinned to a release tag. Customise it from outside:
  - `src/viewer/bridge.js`, a main-world script that sets `PDFViewerApplicationOptions` and drives `PDFViewerApplication`
  - `src/viewer/overrides.css`, which restyles the viewer in Material Design 3, with Material Symbols icons from `src/viewer/icons/`
  - `src/viewer/geometry.js`, the eraser's geometry, which touches nothing in pdf.js

  `src/main/protocol.js` injects them into `viewer.html` as it serves it. If something seems to need a pdf.js patch, look for a way through those first, and if there is none, stop and ask.
- Prefer pdf.js's built-in behaviour over reimplementing it.
- `bridge.js` is the only code that touches pdf.js internals (`PDFViewerApplication`, its `eventBus`, `AppOptions`). They change between releases, so check every name against the pinned sources, such as `vendor/pdf.js/web/app.js` and `web/app_options.js`, never from memory.
- Follow each platform's conventions. On all three, each document gets a tab in PDFLion's own tab strip, in the frontmost window.
  - macOS: the menu bar, ⌘ shortcuts, and the app keeps running after its last window closes.
  - Windows: a menu bar in each window, Ctrl shortcuts, and the app quits with its last window. A PDF opened while PDFLion runs goes to the running process.
  - Linux: like Windows, but File > Quit with Ctrl+Q rather than Exit, GTK's About dialog, and GNOME's button order in the save prompt, with Save rightmost.

  Branch on `process.platform` in the module concerned. Before relying on an Electron API, check its `@platform` in `node_modules/electron/electron.d.ts`: many are macOS only, such as `isDocumentEdited()` and the `recentDocuments` role, and some leave out Linux, such as `app.addRecentDocument()`, `setAppUserModelId()`, `query-session-end` and the About panel's `credits`.
- Code is written on a Mac. Report anything Windows- or Linux-specific as unverified until it has run there.

## Stack

- Electron (latest stable), with the main process as ES modules. Plain JavaScript with JSDoc: no TypeScript, no bundler, no UI framework. The preloads are CommonJS, as sandboxed preloads must be.
- Two production dependencies, pinned to exact versions. When updating one, check what it brings along against its group in `credits.js` and README's Credits:
  - [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib), an MIT fork of pdf-lib, for the page changes pdf.js can't make. It parses documents, so it runs only in the sandboxed viewer: `bridge.js` loads its browser build from `/lib/`, which bundles its own dependencies.
  - [electron-updater](https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater), in main (see Updates). `npm ls --omit=dev --all` lists what it brings into `app.asar`.
- electron-builder: a `.dmg` and a `.zip` per Mac architecture (arm64, x64), an NSIS installer for Windows x64, and a `.deb` for Linux x64. No certificates and no notarization. Mac builds are signed ad hoc (see Packaging).
- Node 24 LTS (`.nvmrc`). The pdf.js build needs Node `>=22.22.3 || >=24.15.0 || >=26.0`.
- GitHub Actions (`.github/workflows/ci.yml`) tests and builds on all three platforms, and releases every push to `main`.

## Layout

```
src/main/        main process: one module per concern
  main.js        app lifecycle, open-file queue, single-instance lock (Windows and Linux)
  arguments.js   files from the command line and from a second instance (Electron-free, unit tested)
  protocol.js    pdflion:// scheme handler
  routes.js      pdflion:// URL layout: viewer URLs, /doc/ tokens, mount paths (Electron-free)
  ranges.js      Range headers for /doc/ (Electron-free, unit tested)
  documents.js   tokens for opened files and untitled documents, atomic writes (Electron-free, unit tested)
  blank.js       File > New's blank PDF and its paper size by region (Electron-free, unit tested)
  saving.js      Save and Save As: dialogs and error alerts
  pages.js       the alerts and prompts about changing pages (pdflion:page-dialog)
  unsaved.js     save prompts when a tab or window closes, the app quits, an update installs, or the system shuts down
  windows.js     document windows: placement, which is in front, opening documents as tabs, the Open panel
  tabs.js        one tab per document: its WebContentsView, edited state, navigation guards, the window's layout and title
  tablist.js     each window's tabs and its active tab (Electron-free, unit tested)
  strip.js       the tab strip's messages, its context menu, dragging tabs between windows
  placement.js   where a new window opens (Electron-free, unit tested)
  state.js       userData/state.json
  tools.js       checks the tool settings PDFLion keeps: the eraser's, and favourites (Electron-free, unit tested)
  toolsettings.js  keeps the tool settings for every tab: their IPC channels, and a favourite's context menu
  recent.js      recent documents, and PDFLion's own list for Open Recent on Windows and Linux
  updates.js     updates through electron-updater: the checks, the prompts and Restart Now
  ipc.js         the viewer's IPC handlers, runCommand() to a tab's bridge.js
  permissions.js web permission handlers
  menu.js        native menu and the About panel
  credits.js     the third-party projects the About panel lists (Electron-free, unit tested)
  paths.js       the only place that knows dev vs packaged locations
src/preload/     preload.cjs (window.pdflion, for the viewer), tabs.cjs (window.pdflionTabs, for the strip)
src/tabs/        the tab strip, served at pdflion://app/tabs/
src/viewer/      bridge.js, geometry.js (unit tested), overrides.css, icons/, served at pdflion://app/pdflion/
resources/       icon and entitlements (electron-builder buildResources); about-icon.png also ships in the app
scripts/         update-pdfjs.js, build.js, version.js (CI's version), after-sign.js (the Mac app's designated requirement)
test/unit/       node --test, *.test.js
test/e2e/        Playwright against the dev app
vendor/pdf.js/   submodule, never edit
electron-builder.yml, .github/workflows/ci.yml
```

## Commands

```sh
git clone --recurse-submodules https://github.com/xLion-ch/PDFLion.git
npm install
npm run pdfjs:build      # build the pinned pdf.js viewer (once per clone and after each update)
npm start                # run in dev; npm start -- path/to/file.pdf opens a file
npm test                 # unit tests
npm run test:e2e         # end-to-end tests: they open windows and take focus while they run
npm run build            # tests, then every version this machine can build, in dist/
npm run dist             # this platform's installers in dist/; npm run dist -- --dir for the apps alone
node scripts/version.js  # the version CI builds this commit as; --pr <n> for pull request n
```

## pdf.js

- The submodule keeps its full history on purpose: pdf.js computes its version from it, so a shallow clone builds as `x.y.0`.
- `scripts/update-pdfjs.js`, run through npm: with no argument it switches to the latest release, builds it and stages the submodule. `vX.Y.Z` switches to that release, `--check` prints the pinned and latest versions, `--build` rebuilds, `--build-if-missing` builds only without a build (`npm start` runs it), and `--check-build` fails unless the build is of the pinned commit (CI runs it).
- The build is `vendor/pdf.js/build/generic/` with `build/version.json`, which pdf.js's `.gitignore` covers. Dev serves it from there, and packaged builds copy it to `pdfjs/` in the app's resources.
- Updating to a new release:
  1. Run `npm run pdfjs:update`, and read the release notes.
  2. Check what `bridge.js` and `overrides.css` rely on against the new sources. Most of it fails silently when it changes:
     - **Keys:** `isMenuShortcut` against `onKeyDown` in `web/app.js` and `web/pdf_print_service.js` (⌘ on macOS, Ctrl and F4 elsewhere), and that pdf.js, its editors' `KeyboardManager`s included, still binds none of PDFLion's own shortcuts (see Menu commands).
     - **Loading:** `open({ data, filename })`, `_docFilename`, `initialBookmark`, `initialRotation`, the `viewOnLoad` option, the `documentinit` and `metadataloaded` events, `pdfViewer.pagesPromise` and `pagesCount`, and the range transport against `PDFDataRangeTransport` (`src/display/api.js`), `src/display/transport_stream.js` and `getNetworkStream` (`src/display/network_stream.js`), in case pdf.js now makes range requests for other schemes.
     - **Page tools:** the `enableSplitMerge` and `enableMerge` options, `hasStructuralChanges()`, `getStructuralChanges()`, `pagesMapper.getMapping()`, `extractPages()`, the `pagesedited` event, `onSaveAndLoad()` and the `pageInfos` that `#mergeFiles` in `web/pdf_thumbnail_viewer.js` hands it, `#viewsManagerStatusWaitingCloseButton`, and the `isDraggingFile` class `preload.cjs` reads. For `guardPageTools()`: the thumbnails' listeners it goes before (`pointerdown`, `dragenter`, `drop`, `keydown`, and the picker's `change`), `DRAG_THRESHOLD_IN_PIXELS`, the ids of the Manage menu's items and of Add file's picker, and how `web/menu.js` closes a menu. That a click on a thumbnail's checkbox still selects its page. Whether an undone deletion still leaves the wrong page cached (`updatePageNumber` in `web/pdf_page_view.js`, `updatePage` in `src/display/api.js`): if not, `recachePages()` can go.
     - **What a rewrite drops (`findDroppable()`):** `#makeRoot` and `isSingleFile` in `src/core/editor/pdf_editor.js`, `getOptionalContentConfig()`, `getJSActions()`, `getViewerPreferences()`, `getOpenAction()`, `getPageMode()` and `getPageLayout()` with their defaults in `src/core/catalog.js`, `getMarkInfo()`, which answers a `Map`, `getPageLabels()`, `getMetadata()`'s `metadata`, `info.Language` and flags `EncryptFilterName` and `IsSignaturesPresent`, and `isPureXfa`.
     - **Inserting and rotating pages:** `AnnotationEditorPrefix`, `#editorModeSeparator`, before which Insert Blank Page goes, and `get rotate()` in `src/core/document.js`, which `rightAngle()` repeats.
     - **Page overview:** `SidebarView` in `web/ui_utils.js`; the views manager's `switchView()`, `visibleView`, `isOpen`, `close()`, `toggle()` and `sidebarviewchanged` (`web/views_manager.js`), and that `open()` and `close()` mark the sidebar button through `toggleExpandedBtn()` before dispatching it; that `web/sidebar.js` binds the button's click to `toggle()` and sets `--viewsManager-width` in `onResizing()`; that the thumbnails are placed on a `resize` from the views manager and laid out with `--thumbnail-width` and `--gap-between-input-and-thumbnail`; the ids `#viewsManagerToggleButton`, `#viewsManagerAddFileButton`, `#viewsManagerTitle`, `#viewsManagerSelector` and `#viewsManagerResizer`; `aria-current` on the current thumbnail, the `isDragging` class, `pdfViewer.focus()`, and that `onKeyDown` prevents the default of an Esc it acts on.
     - **Eraser:** `pdfViewer._layerProperties.annotationEditorUIManager` and `annotationEditorMode`; the `switchannotationeditormode`, `annotationeditormodechanged` and `editingaction` events; the UI manager's `getEditors()`, `getLayer()`, `unselectAll()` (which commits a drawing session and returns), `addCommands()`, `addEditor()`, `addToAnnotationStorage()`, `isEditorHandlingKeyboard`, and `updateMode()`, which must enable the layers before `web/pdf_viewer.js` dispatches the mode event; the editors' `editorType`, `pageIndex`, `remove()` and `serialize(true)`; the layer's `addOrRebuild()`, `addUndoableEditor()`, which `onceAdded()` in `src/display/editor/draw.js` calls, and `deserialize()`, which needs `annotationType`, `paths.points` as `Float32Array`s, `color`, `thickness`, `opacity`, a `rotation` of 0, 90, 180 or 270, and a `rect`; that the layers in `src/display/editor/annotation_editor_layer.js` ignore presses but `button` 0; the page views' `div` and `viewport`; `AnnotationEditorType` in `src/shared/util.js`, `textInputChecker` in `src/display/editor/tools.js`; that ink mode shows Pencil on with its option box (`toggleExpandedBtn` in `web/toolbar.js`) and Pencil's click turns ink mode off; and `#editorInk`, `#editorInkButton`, `#editorInkParamsToolbar` and `.page[data-page-number]` in `#viewerContainer`.
     - **Favourites:** the option boxes `#editorHighlightParamsToolbar`, `#editorFreeTextParamsToolbar` and `#editorInkParamsToolbar` with their `.editorParamsToolbarContainer`; the inputs read (`#editorInkColor`, `#editorInkThickness`, `#editorInkOpacity`, `#editorFreeTextColor`, `#editorFreeTextFontSize`, `#editorFreeHighlightThickness`) and their ranges, which `tools.js` repeats; that `web/annotation_editor_params.js` keeps them in step with the tool and the selected drawing; that `src/display/editor/color_picker.js` marks the chosen swatch with `aria-selected` and `data-color`; `#editorModeButtons`, the icon variables `--toolbarButton-editorHighlight-icon`, `--toolbarButton-editorFreeText-icon` and `--toolbarButton-editorInk-icon`, and `FAVOURITE_TOOLS` against `AnnotationEditorType` and `AnnotationEditorParamsType`; that `updateParams()` dispatches no `annotationeditorparamschanged`, that `updateMode()` returns for the tool that's on and clears the selection only after an `await`, and that `#editorModeChanged()` in `web/toolbar.js` opens a tool's option box; the Stamp menu's classes and `web/menu.js`'s keys, which the ★ menu copies; and that `web/event_utils.js` calls external listeners after internal ones.
     - **Toolbar width:** that `#toolbarViewer`'s three groups keep `flex: none`, and pdf.js's media queries in `web/viewer.css` against `PDFJS_STEPS` and the rules `overrides.css` repeats for them (`.hiddenMediumView`, `.visibleMediumView`, `.hiddenSmallView`, `#scaleSelectContainer`).
     - **Styles and CSP:** the variables and selectors in `overrides.css` against `web/viewer.css`, and the CSP header in `protocol.js` against the `<meta>` CSP in `web/viewer.html`. Chromium enforces both, so the header mustn't be stricter.
  3. Check what pdf.js bundles (`vendor/pdf.js/external/`, and the license files in the build's `web/` folders) against "pdf.js includes" in `credits.js` and README's Credits.
  4. Run the unit and end-to-end tests. The pull request's CI runs them on all three platforms.
  5. Stage the submodule and any fixes, and suggest `Update pdf.js to vX.Y.Z`.

## How the viewer is served

Everything a window loads comes from the privileged scheme `pdflion://app/` (standard, secure, fetch, stream):

| Path | Serves |
|---|---|
| `/viewer/…` | the pdf.js build. Into `web/viewer.html` the handler injects `overrides.css`, `geometry.js` and `bridge.js`, and adds a CSP header |
| `/pdflion/…` | `src/viewer/` |
| `/tabs/…` | `src/tabs/`, with a CSP header of its own for `tabs.html` |
| `/lib/…` | @cantoo/pdf-lib's `dist/`, of which only `pdf-lib.min.js` is packaged |
| `/doc/<token>/<name>.pdf` | a file the user opened, or an untitled document, whole or as byte ranges. Main mints the tokens, so the renderer reads only what the user chose |

- A window is a `BrowserWindow` whose page is the tab strip. Each tab is a `WebContentsView` that loads `viewer/web/viewer.html?file=/doc/<token>/<name>.pdf`, below the strip, or over the whole window with one tab or in full screen. Moving a tab to another window moves its view, unsaved changes included. Main keys documents, edited state and commands by tab, not by window.
- The document must be same-origin: the generic viewer rejects a `file=` from another origin.
- `bridge.js` is a classic script, so its `webviewerloaded` listener is in place before the viewer's modules initialise. It sets `defaultUrl` to `""`, so pdf.js's demo PDF never opens.
- pdf.js makes range requests only for http(s), so `bridge.js` opens `/doc/` through a `PDFDataRangeTransport`, with `If-Match`, so that a changed file gets 412.
- The handler resolves every path against its root, and answers 404 for anything that escapes it.
- An untitled document from File > New lives in main's memory until its first save. Save on it always means Save As (`runCommand()` sends `saveAs`, also for the save prompts' Save), which turns its token into a file token.

## Page changes

pdf.js's page tools are on (`enableSplitMerge`, `enableMerge`): in the sidebar's thumbnails, checked pages can be dragged, copied, cut, deleted and exported, and Add file or dropped files add pages. `bridge.js` fits them into PDFLion's saving and edited state:

- Moves, copies and deletions stay in pdf.js's `pagesMapper` until Save, which writes the file `extractPages()` makes of them, with typed form values (`currentBytes()`), then `reopen()`s it. They count as edits while the pages' order differs from the document's (`hasPageChanges()`), since pdf.js's `hasStructuralChanges()` stays true after an Undo.
- `bridge.js` replaces `onSaveAndLoad()` before pdf.js binds it, so that Add file works like Insert Blank Page: one change at a time, the locks and the signing prompt first, form values kept, and the document as it was if the result doesn't open. `preload.cjs` lets PDFs dropped on the thumbnails through to pdf.js while `#thumbnailsView` has `isDraggingFile`. Dropped anywhere else, they open as tabs.
- An undone deletion leaves the wrong page in pdf.js's page cache, which printing and Find use, so `recachePages()` caches the pages again after every page edit.
- Insert Blank Page and the overview's Rotate Pages go through @cantoo/pdf-lib, as incremental updates appended to `currentBytes()` (`forIncrementalUpdate`, `updateMetadata: false`), so the original bytes, metadata, page labels and signed revisions stay as they were. `reopen()` shows the result in the same tab, with its view, sidebar and overview, and `viewOnLoad` set to `INITIAL`, since the fingerprint stays the same. If the library or pdf.js fails, the tab gets its bytes back, with an alert. One busy flag covers Save and every page change.
- Documents with a password, even an owner password only, and pure XFA forms are locked against page changes, since the library's increments to encrypted files aren't reliable. `guardPageTools()` captures the page tools' events before pdf.js's listeners, and `pdflionPagesLocked` on `#outerContainer` hides the tools. A signed document asks once per tab before its first change (`confirmPageChange()`). A drag can't be replayed, so it asks once the press has moved far enough to start one.
- A save that writes a new file through `extractPages()` first asks whether to drop what the document holds and the new file won't (`confirmRewrite()`, with what `findDroppable()` found), once per item and tab. An insertion or rotation after unsaved page changes starts from the new file `currentBytes()` writes, which `newFile` tracks until the next save.
- Every word of the page dialogs is in `pages.js`, which the page asks through `pdflion:page-dialog`.

The page overview (View > Page Overview) is pdf.js's views manager on its thumbnails, made a grid by `overrides.css` while `#outerContainer` has `pdflionPageOverview`. Its header gets Rotate Pages Left and Right, and Insert Blank Page, before Add file.

- The document stays where it was, behind it: `bridge.js` keeps the views manager's `onResizing()` from moving it aside.
- pdf.js places the thumbnails for dragging on a `resize` from the views manager, so `bridge.js` sends one whenever the grid moves: as it opens and closes, as the window resizes, and on `reopen()`.
- pdf.js shows its sidebar button on while the views manager is open, so `showSidebarButton()` shows it off while the overview is. Toggling the sidebar closes the overview: `bridge.js` wraps the views manager's `toggle()`, which F4 and the menu call, and a capture listener takes the button's clicks.
- View > Rotate Left and Right turn only the view, which isn't saved.

## Eraser

A drawing tool of PDFLion's after Pencil, `#pdflionEditorEraserButton`, with an option box. `bridge.js` builds it, `geometry.js` works out what it touches, and `overrides.css` styles it.

- It works in pdf.js's ink mode, where the file's ink annotations are editors too. Turning it on commits Pencil's open drawing session (`unselectAll()`, twice). pdf.js then shows Pencil on, which `overrides.css` shows off under `pdflionErasing`. Pencil's click would turn ink mode off, so a capture listener makes it just stop erasing.
- A capture listener on `#viewerContainer` takes presses on pages before pdf.js, and the drag's moves are captured on window.
- It takes only `editorType` `"ink"`: signatures are drawings too, and free highlights serialize to nothing. Object mode removes whole drawings. Line mode cuts strokes, and once per frame replaces each cut drawing with one built through the layer's `deserialize()`. `addWithoutUndo()` masks the step to undo pdf.js's `onceAdded()` would add for it.
- A drag is one step to undo (`addCommands()` with `mustExec: false`). pdf.js builds editors asynchronously, so all the eraser's work runs in one queue (`afterErasing()`).
- A pen's eraser end (`button` 5) erases with any tool on, which stays on (`inPlace`). With no tool on, it turns the eraser on, and erases once `annotationeditormodechanged` says ink mode is on. The eraser then stays on, since with no tool on pdf.js takes no Undo, and its disabled layers wouldn't show an undone erase.
- Its mode and size are tool settings, the same in every tab (`toolsettings.js`). The circle cursor is a `div`, since a CSS cursor can't grow that large.

## Favourites

A favourite is a drawing tool with its settings, such as a blue pencil 1 pt wide. Main keeps them in `state.json`, and sends every tab the whole list after each change. Save as Favourite goes at the end of the option boxes of Highlight, Text and Pencil. The favourites show before pdf.js's drawing tools (`#pdflionFavourites`), and those that don't fit in the ★ menu.

- Settings are read from the option box's inputs, which pdf.js keeps in step with the tool or the selected drawing. Highlight's colour is the swatch marked `aria-selected`, by its upper-case `data-color`. Where the colour input takes an alpha channel, Pencil's opacity is in the colour, since pdf.js then removes the slider.
- A click (`useFavourite()`) first commits Pencil's drawing and clears the selection (`commitDrawing()`), since pdf.js gives new settings to selected and open drawings. Then it switches the tool, and dispatches `switchannotationeditorparams` for each setting, and `annotationeditorparamschanged`, since pdf.js doesn't update its option boxes for these.
- The tool's option box stays closed. pdf.js opens it as it switches tools, and calls external listeners after its own, so `followFavourites()` closes it again on `annotationeditormodechanged`.
- Which favourite shows pressed is read a microtask after pdf.js's events, since Highlight's colour picker marks its swatch only after dispatching.
- Reordering is HTML5 drag and drop with a data type of its own (`FAVOURITE_DRAG_TYPE`), which the preload and the strip leave alone. A drop rebuilds the buttons, so it ends the drag itself.
- The ★ menu copies pdf.js's Stamp menu, and repeats `web/menu.js`'s keyboard handling, which `bridge.js` can't import. Remove Favourite is main's context menu.

## The toolbar's width

The toolbar's width depends on the language, the page count, the favourites and a signed document's button. So `layoutToolbar()` gives up as little as it can as a window narrows, one step at a time, each keeping those before it (classes of `#toolbarContainer`, `TOOLBAR_STEPS`): 32 px buttons, favourites into the ★ menu from the last, pdf.js's medium view (Print into the ⋮ menu, every favourite into ★), pdf.js's small view (no previous and next page buttons), and no zoom menu.

- It never takes fewer steps than pdf.js's own media queries at that width (`PDFJS_STEPS`: 750, 690 and 560 px), and as the window narrows, the toolbar only ever loses more. `overrides.css` repeats pdf.js's rules for those views under the classes, in `:where()`.
- A `ResizeObserver` lays it out again, on everything but the right group, which the favourites change.
- A window's content is at least 560 px wide (`MIN_WIDTH` in `windows.js`), where the toolbar fits after its last step in English and German for 1000 pages. `toolbar.spec.js` checks it.

## Menu commands

- Items that act on the document come from `commandItem()` in `menu.js`. A click calls `runCommand(tab, command)` (`ipc.js`), which sends the command to the tab's `bridge.js`, where `COMMANDS` maps it to pdf.js. A new command needs all three, and an end-to-end test.
- Items that act on tabs come from `tabItem()`, and run in main: in the Window menu on macOS, at the end of View on Windows and Linux.
- PDFLion's own shortcuts follow Preview: Page Overview ⌥⌘6, its Contact Sheet, Insert Blank Page ⇧⌘N and Eraser ⇧⌘E. On Windows and Linux they're Ctrl+Shift+O, since Ctrl+Alt+6 is AltGr+6, Ctrl+Shift+N and Ctrl+Shift+E.
- The page sees keys before the native menu. `isMenuShortcut` in `bridge.js` keeps pdf.js from acting on the shortcuts it shares with the menu, so a new shortcut that pdf.js also binds needs adding there. pdf.js binds none of the tab shortcuts, nor PDFLion's own above.
- Edit > Undo and Redo aren't roles, whose undo reaches editable text only. `undoItem()` asks `bridge.js` first, which dispatches pdf.js's `editingaction` while a drawing tool is on and no text is being typed. Otherwise main calls `webContents.undo()` or `redo()`.
- A click on the native menu gives the page no user activation, so `runCommand()` grants it for `COMMANDS_NEEDING_ACTIVATION`, such as Presentation Mode's `requestFullscreen()`.
- Labels mark access keys with `&`, as in `&File`, which macOS drops. A literal `&` is `&&`.

## Updates

The packaged app updates from the GitHub releases, through electron-updater (`updates.js`), which `app-update.yml` in the app's resources points at.

- It checks 10 s after launch and every 6 hours while automatic checks are on (`updates.automatic` in `state.json`), downloads in the background, checks the SHA-512 against the release's `latest*.yml`, and takes neither downgrades nor prereleases. `allowPrerelease` would otherwise be on for a pull request's build.
- `updates.js` makes `MacUpdater`, `NsisUpdater` or `DebUpdater` itself, since electron-updater's `autoUpdater` picks the Linux one by a file only the `.deb` has. It `import()`s electron-updater, a CommonJS module, when the first check is due.
- Restart Now first asks about every edited tab (`reviewUnsavedChanges()` in `unsaved.js`), then calls `quitAndInstall(true, true)`, which can't be taken back. Meanwhile Windows and Linux don't quit with their last window (`isRestartingForUpdate()`).
- macOS: Squirrel.Mac installs the zip, on quit or with Restart Now, if the new bundle satisfies the running one's designated requirement (see Packaging). `MacUpdater` serves it the zip from a proxy on 127.0.0.1, and the prompt waits for Squirrel's own `update-downloaded`, about a second after electron-updater's. An app on a read-only volume can't update, such as one run from the DMG, or from Downloads, which macOS translocates. A check from the menu then says to move it to Applications.
- Windows: the NSIS installer installs silently for the user, on quit or with Restart Now. Once Windows asks to end the session, quitting installs nothing, in case Windows ends the installer halfway. Whether that's needed hasn't been tried.
- Linux: `dpkg -i` through `pkexec`, which asks for a password, so only Restart Now installs. A failure, such as a cancelled prompt, shows as an error during `quitAndInstall()`, and PDFLion says the update wasn't installed.
- electron-updater's staging ID (`x-user-staging-id`) goes out empty, so GitHub can't follow a copy from one IP address to the next.
- The dev app gets no updates, except from an end-to-end test's local feed (`--pdflion-update-config=<app-update.yml>`, which sets `forceDevUpdateConfig`). The packaged app ignores the switch.

## Security rules

- Every window and tab view uses `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`, and `app.enableSandbox()` sandboxes every renderer.
- The preloads expose small APIs through `contextBridge`, never `ipcRenderer`: `window.pdflion` only on the viewer page, and `window.pdflionTabs` only on the tab strip, since a preload runs in every page its `webContents` shows.
- Main validates the sender and the payload of every IPC message. The sender must be the top frame, with the viewer's URL (`ipc.js`) or, for the strip's channels, the strip's (`strip.js`). A strip message must also come from a window's own `webContents`, with tab ids of that window and indexes in range. Don't compare origins instead, as Electron's checklist suggests: an `about:blank` page the viewer opens has its origin, and the strip shares it too.
- The tool settings' channels (`toolsettings.js`) take only what `tools.js` accepts, rebuilt from known fields, so nothing else reaches `state.json`. `pdflion:page-dialog` takes only a reason and items from `pages.js`'s fixed lists.
- Tab ids are random and unrelated to document tokens, since drags carry them out of the app. Main takes a dropped tab only after a strip reported dragging it.
- Tabs can't navigate away from `pdflion://app/viewer/`, and the strip can't navigate at all. Only `http`, `https` and `mailto` links open, with `shell.openExternal`, and every other `window.open` is denied.
- `viewer.html` gets a CSP without `unsafe-eval`, with `wasm-unsafe-eval` for pdf.js's image decoders.
- @cantoo/pdf-lib parses untrusted documents, so it runs only in the sandboxed viewer, never in main.
- Permissions are denied, except `fullscreen` and `clipboard-sanitized-write` for the viewer (`permissions.js`).
- The updater's requests to GitHub, over HTTPS, are PDFLion's only network requests of its own. Releases aren't signed, and only the SHA-512 in the same release checks a download: `NsisUpdater` checks no Authenticode signature without a `publisherName`, and Squirrel's check of the designated requirement proves nothing, since any app can claim the bundle ID. So whoever can publish a release can run code on every installed copy, and the workflow's permissions and the ruleset on `main` guard that. Release text is never shown.
- CI has a read-only token (`contents: read`), runs pull requests on `pull_request`, never `pull_request_target`, checks out with `persist-credentials: false`, uses only GitHub's own actions, pinned to commits, and installs with `npm ci`. Only the `release` job gets `contents: write`. It runs no code from the repository, and only for pushes to `main` in `xLion-ch/PDFLion`, in the `release` environment, which allows only `main`.
- The packaged app's Electron fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect` and file:// privileges, load the app only from `app.asar`, checking its hash on macOS and Windows, and encrypt cookies.

Against Electron's [security checklist](https://www.electronjs.org/docs/latest/tutorial/security) (reviewed for Electron 45), the rules above meet every item that applies. Beyond them: no device or screen-sharing permission handlers are set, so those APIs fail; no window enables `webviewTag`; `about:blank` and `about:srcdoc` pages, which `will-navigate` doesn't see, get no preload API, and main ignores their messages; `LoadBrowserProcessSpecificV8Snapshot` stays off, since there's no browser-only snapshot; and on Linux nothing checks `app.asar`'s hash. Downloads keep Electron's save dialog, for attachments, a script's Save As and Export selected.

## Packaging

- Mac builds are signed ad hoc (`identity: "-"`): Apple silicon runs only signed code, and the fuses change the Electron binary, so an unsigned build is killed at launch.
- An ad-hoc signature's designated requirement is the app's own hash, so Squirrel.Mac would refuse every update. `scripts/after-sign.js`, electron-builder's `afterSign` hook, signs the bundle alone again, ad hoc, with `designated => identifier "io.github.xlion-ch.pdflion"`, keeping its identifier, entitlements and hardened runtime, then verifies it. `mac.requirements` can't do that, since it gives every nested binary the requirement, which they then fail. electron-builder warns that it skips the hook on Windows and Linux.
- `fileAssociations` has `rank: Alternate`, so PDFLion is in Open With without becoming the default. The NSIS installer is one-click and per user, into `%LOCALAPPDATA%\Programs`.
- Of @cantoo/pdf-lib, `app.asar` holds only `dist/pdf-lib.min.js`, its licence and its `package.json`: the `files` patterns leave out about 30 MB.
- electron-builder's `makensis` is an Intel binary, so the Windows installer needs Rosetta on Apple silicon.
- `publish` names the GitHub releases, so every build writes `latest-mac.yml`, `latest.yml` or `latest-linux.yml`, a `.blockmap` for each but the `.deb`, `app-update.yml` into the resources, and `resources/package-type` into the `.deb`. On macOS only the zip and DMG targets get `app-update.yml`, not `--dir`. A build that fails on any target writes no `.yml` at all.
- CI's version comes from `scripts/version.js`: `package.json`'s major and minor, and the commit count, so the same commit always gets the same version, and each push a higher one, without CI committing. A pull request builds `<version>-pr.<number>`. `-c.extraMetadata.version` puts the version everywhere. `version.js` refuses a shallow history. `package.json` keeps `x.y.0`, and raising major or minor is a hand edit there.
- The run keeps the installers for 14 days, except a fork's pull request's, which come from unreviewed code. The upload step compares `head.repo.full_name` with `github.repository`, since a deleted fork's `head.repo` is null, and `null == false` in Actions expressions.
- Once all three platforms pass on a push to `main`, the `release` job makes `v<version>` with `gh`: it checks that every file is there, deletes any draft a failed run left, creates a draft on the commit with every file and generated notes, then publishes it as the latest release, which creates the tag. It releases nothing if the latest release has the same version or a higher one. Releases keep their `.blockmap` files for differential downloads.
- Linux: the `.deb` installs into `/opt/PDFLion`, with `pdflion` in `/usr/bin`. Its `.desktop` file is named after `desktopName`, which Electron uses as the Wayland app ID and X11 WM_CLASS, so the dock groups the windows with the launcher, and `Exec` ends in `%F`, so file managers pass paths. `linux.mimeTypes` lists PDFLion for PDFs, rather than a `mimeType` in `fileAssociations`, which would install a MIME definition whose icon replaces the PDF icon.
- The sandbox stays on under Linux: the `.deb`'s post-install script makes `chrome-sandbox` setuid where user namespaces don't work, and installs an AppArmor profile on Ubuntu 24.04 and later. No AppImage, which can't carry a setuid helper.
- `npm run build` leaves the `.deb` out on a Mac. It's built on a Linux PC, where it can be tested.

## Tests

- `npm test` runs `node --test "test/unit/**/*.test.js"`, quoted so that Node expands the glob. Modules that unit tests import stay free of Electron.
- `bridge.test.js` runs `bridge.js` in `node:vm`, after `geometry.js`, with stand-ins for `window.pdflion` and `PDFViewerApplication`. When the bridge uses something new from the page, add it to the stand-ins. The test also checks that the bridge knows every `commandItem()` command in `menu.js`. `geometry.js` answers `Float32Array`s from its own realm, so its tests compare them as arrays.
- The end-to-end tests drive the dev app with Playwright, each launch with its own `--user-data-dir`. `pdfs.js` writes the test PDFs, and the few that would be hard to write come from the pdf.js submodule. The suite is the safety net for pdf.js updates, so it must cover every bridge command.
- Playwright lists each tab's viewer and each window's strip as pages. The helpers in `pdflion.js` find a document's page by its URL (`documentPage`), and a page's strip by its window (`stripOf`). A tab that isn't shown doesn't render, so tests open tabs one at a time. `setSize()` and `setWidth()` wait until the page has laid itself out.
- `launch()` makes the first window's content 1000 × 640 (`WINDOW_SIZE`), which fits CI's smallest screen. Whatever a test points at must be in view at that size.
- `page.evaluate()` counts as a user gesture. Where user activation matters, read the page from main with `readFromMain()`.
- Playwright can't drag between windows, so `tabs.spec.js` sends the strip's messages itself.
- A key sent with `sendInputEvent()` never reaches the native menu on macOS, so there `shortcuts.spec.js` clicks the menu item itself, after checking that the page left the key alone.
- `updates.spec.js` serves a local feed (`--pdflion-update-config`), and replaces the install, which would run the downloaded bytes or dpkg: the updaters' `doInstall()`, which it reaches through `process.getBuiltinModule("node:module")`, and on macOS Squirrel.Mac (`stubSquirrel()`), which would refuse the ad-hoc-signed dev app's update.
- CI runs both suites on `macos-26`, `windows-2025` and `ubuntu-24.04` (the jobs `mac`, `windows` and `linux`), after a `pdfjs` job that builds pdf.js once, cached by the submodule's commit. The `electron` package downloads its binary on first run, so the jobs fetch it after `npm ci`. On Linux the end-to-end tests run under `xvfb-run` at 1920 × 1080, with `chrome-sandbox` setuid root, and nothing passes `--no-sandbox`. With `CI` set, Playwright also writes an HTML report, kept when a test fails, and `test.only` fails the run.

## Decisions

These were settled on purpose. Change them only on purpose.

- The bundle ID is `io.github.xlion-ch.pdflion`: `appId` in `electron-builder.yml`, and `APP_ID` in `main.js`. Changing it resets preferences and file associations. On Windows it's also the AppUserModelID, which groups the taskbar buttons with the Start menu shortcut.
- One build per Mac architecture, half the size of a universal build. Windows x64 only, which Windows on Arm runs emulated. On Linux only a `.deb` for x64, for Ubuntu 22.04 and Linux Mint 21 and later: AppImage would lose the sandbox on Ubuntu 24.04, and Flatpak and Snap bring confinement and stores of their own.
- File > New makes an untitled document in memory with one blank page: US Letter in the regions CLDR lists for it, A4 everywhere else and where the region is unknown. It counts as edited only once it changes.
- Launching without a file shows the Open panel, like Preview. On Windows and Linux, cancelling it quits, since an app there without windows has nothing to show.
- No code signing and no notarization. Every push to `main` that passes CI on all three platforms is a release, so `main` takes only changes whose CI passed, after the checks by hand.
- Installed copies update themselves: in the background, installing on quit on macOS and Windows, and only with Restart Now on Linux, where installing asks for a password. Automatic checks are on until turned off. On macOS that rests on the bundle ID as the designated requirement rather than a Developer ID, and a copy downloaded from GitHub and allowed with Open Anyway updates too, with no further prompt (checked on macOS 27).
- The viewer follows Material Design 3, as CSS over pdf.js's own UI: Material's monochrome scheme, the system font, and colours only outside forced-colors mode, which keeps pdf.js's high contrast styles.
- Page changes pdf.js can't make go through @cantoo/pdf-lib, as incremental updates, in the viewer. pdf.js's `extractPages()` would write a whole new file, without the title, page labels or password, upstream pdf-lib can't append increments, and a library in main would parse untrusted documents outside the sandbox.
- pdf.js's page tools are on, although pdf.js counts them as experimental, rather than rebuilding their selection, dragging, pasting and undo. Their changes are saved through `extractPages()`, which asks first about what it drops. Documents with a password and pure XFA forms are locked against page changes, and signed ones ask once.
- Window placement is kept in `state.json`, not with Electron's `windowStatePersistence`, which remembers each window by name and can't give a new document the last window's place.
- Tabs are PDFLion's own tab strip on all three platforms, rather than macOS's native tabs, so that the end-to-end tests on the Mac cover what Windows and Linux run. Windows have no `tabbingIdentifier`, so macOS's own tabs stay off. Tab libraries build on `<webview>`, which the security rules leave off.

## Known limitations

- The native menus, PDFLion's own labels and its dialogs are in English. The viewer, and the items macOS adds to the menus, follow the system language.
- A Mac copy run from the DMG, or from Downloads without being moved, can't update. On Linux, installing an update asks for a password, so only Restart Now installs. A copy without Check for Updates…, such as 0.1.0, never updates, and needs the latest release downloaded once.
- Undo doesn't remove an inserted page or undo a rotation, but deleting the page or rotating back does.
- The eraser's Object mode erases a whole drawing: everything Pencil drew in one go, which may be several strokes. Line mode saves a cut drawing from the file as deleted, and its rest as a new one. Erasing by touch or with a pen hasn't been tried, nor a pen's eraser end, which the tests only imitate. Pages take `touch-action: none` only while the Eraser is on, so with another tool on, an eraser end's drag might scroll the page instead.
- Pages moved, copied, deleted or added with pdf.js's page tools are saved as a new file, which keeps only part of the old one:

  | Change | Made by | Keeps | Loses |
  |---|---|---|---|
  | Move, copy, delete pages | `extractPages()`, from the document alone | the Info dictionary's title, author, subject and keywords, page labels, the outline, forms, the structure tree, attachments, named destinations | XMP metadata, layers (`OCProperties`), document JavaScript, viewer preferences, the open action, the page mode and layout, `Lang`, `MarkInfo`, the file IDs, valid signatures. pdf.js also sets Creator, Producer and CreationDate anew |
  | Add pages from files, or copied pages with typed form values | `extractPages()`, from several files | the outline, forms, the structure tree, attachments, named destinations | all of the above, and the Info dictionary and page labels |
  | Insert a blank page, rotate pages | @cantoo/pdf-lib, as an incremental update | everything. A signed revision stays intact, but signature checks report changes after signing | nothing, but page labels number pages by position, so an insertion shifts them |

  Copied pages with typed form values count as several files, since `withFormValues()` gives each copy its own saved copy of the document. An insertion or rotation after unsaved page changes keeps only what those keep.
- On Wayland, which Ubuntu uses by default, new windows open where the compositor puts them, and PDFLion can't see the pointer outside its windows. So a tab dropped on the desktop and a drag cancelled with Esc both tear the tab off, a second after the drag ends.
- Real drags of tabs between windows are checked only by hand.
- Shutting down Linux with unsaved changes waits for the save prompts only as long as systemd allows (`InhibitDelayMaxSec`, 5 s by default).
- Copying a whole document's text fails if pdf.js takes more than about 5 s to gather it: Chromium then asks for `clipboard-read`, which `permissions.js` denies.

## Conventions

- Small modules in `src/main/`, one responsibility each, and no catch-all `utils.js`. Dev-vs-packaged paths live only in `src/main/paths.js`.
- Every third-party project PDFLion uses goes into `CREDITS` in `src/main/credits.js` and README's Credits, with its link and licence, including what only builds or tests the app, what pdf.js or Electron brings along, and design resources. `credits.test.js` fails when the two list different links.
- Commit messages use the imperative mood and a short subject, e.g. `Add native File menu`.
