# PDFLion

A PDF viewer for macOS (Apple silicon and Intel) and Windows: Mozilla's [pdf.js](https://github.com/mozilla/pdf.js) generic viewer wrapped in Electron. The shell stays thin. pdf.js does the rendering and provides the viewer UI. Electron adds what a browser tab can't: opening files from Finder and Explorer, native menus and shortcuts, saving in place, and packaging as a signed `.app` and Windows installer.

Implementation status and next steps are in [PLAN.md](PLAN.md). Tick items off there as they land.

## Ground rules

- **Never edit `vendor/pdf.js/`.** It is a git submodule pinned to an upstream release tag. All customisation happens outside it:
  - `src/viewer/bridge.js` is a main-world script that sets `PDFViewerApplicationOptions` and drives `PDFViewerApplication`.
  - `src/viewer/overrides.css` adjusts the viewer UI.
  - The `pdflion://` protocol handler (`src/main/protocol.js`) injects both into `viewer.html` as it serves it.

  If something seems to need a pdf.js patch, look for a way through those three first. If there really is none, stop and ask.
- Prefer pdf.js's built-in behaviour over reimplementing it.
- `bridge.js` is the only code that touches pdf.js internals (`PDFViewerApplication`, its `eventBus`, `AppOptions`). These are not a stable API and change between releases. For example, `pdfSidebar` became `viewsManager`, and `isEvalSupported` was removed. Check names against `vendor/pdf.js/web/app.js` and `web/app_options.js` for the pinned version, never from memory.
- The app runs on macOS and Windows and follows each platform's conventions. On both, each document gets its own window.
  - macOS: the menu bar, ⌘ shortcuts, and the app keeps running after its last window closes.
  - Windows: a menu bar in each window, Ctrl shortcuts, and the app quits when its last window closes. A PDF opened while PDFLion runs goes to the running process.

  Branch on `process.platform === "darwin"` in the module concerned. Before relying on an Electron API, check its `@platform` in `node_modules/electron/electron.d.ts`. Many window and menu APIs, such as `isDocumentEdited()` and the `recentDocuments` role, are macOS only.
- Code is written on a Mac. Anything Windows-specific stays unverified until it has run on a Windows PC or in Windows CI, so say so when reporting it.

## Stack

- Electron (latest stable), main process as ES modules (`"type": "module"`).
- Plain JavaScript with JSDoc. No TypeScript, no bundler, no UI framework, because the UI is pdf.js's.
- The preload is CommonJS (`preload.cjs`), because sandboxed preloads can't be ES modules.
- electron-builder for packaging: a signed and notarized `.dmg` and `.zip` for each Mac architecture (arm64, x64), and a signed NSIS installer for Windows (x64).
- Node 24 LTS (`.nvmrc`). The pdf.js build requires Node `>=22.22.3 || >=24.15.0 || >=26.0`.

## Layout

This is the target layout. Directories appear as PLAN.md phases land.

```
src/main/        main process: one module per concern
  main.js        app lifecycle, open-file queue, single-instance lock (Windows)
  protocol.js    pdflion:// scheme handler
  routes.js      pdflion:// URL layout: viewer URLs, /doc/ tokens, mount paths. Electron-free so unit tests can import it
  ranges.js      Range headers for /doc/ (Electron-free, unit tested)
  documents.js   token registry for opened files, atomic writes (Electron-free, unit tested)
  saving.js      Save and Save As: dialogs and error alerts
  unsaved.js     save prompts when an edited window closes, the app quits, or a Windows session ends
  windows.js     one BrowserWindow per document, where it opens, its edited state, the Open panel, navigation guards
  placement.js   where a new window opens: the last window's place, on screen, cascaded (Electron-free, unit tested)
  state.js       userData/state.json: the last window placement and, on Windows, recent documents
  recent.js      recent documents, plus PDFLion's own list for File > Open Recent on Windows
  ipc.js         IPC handlers (sender and payload checks), runCommand() to bridge.js
  permissions.js web permission handlers: deny all but full screen and clipboard writes
  menu.js        native menu, with macOS-only and Windows-only items, and the About panel
  paths.js       the only place that knows dev vs packaged locations
src/preload/
  preload.cjs    contextBridge API exposed as window.pdflion
src/viewer/      served at pdflion://app/pdflion/, injected into viewer.html
  bridge.js
  overrides.css
resources/       icon, entitlements (electron-builder buildResources); about-icon.png also ships in the app
scripts/
  update-pdfjs.js  plain Node, so it runs on Windows too
test/unit/       node --test, files named *.test.js
test/e2e/        Playwright against the real app
vendor/pdf.js/   submodule, never edit
electron-builder.yml  packaging: targets, file associations, Electron fuses
```

## Commands

```sh
git clone --recurse-submodules https://github.com/c14ud3/PDFLion.git
npm install
npm run pdfjs:build      # build the pinned pdf.js viewer (once per clone and after each update)
npm start                # run in dev; npm start -- path/to/file.pdf opens a file
npm test                 # unit tests
npm run test:e2e         # Playwright smoke tests
npm run dist             # installers for this platform in dist/: Mac .dmg/.zip (arm64 and x64), or the Windows .exe
npm run dist -- --dir -c.mac.identity=- -c.mac.notarize=false   # unsigned local Mac apps, ad-hoc signed so they run
```

## pdf.js

- The submodule at `vendor/pdf.js` uses full history on purpose. pdf.js computes its version from git history, so a shallow clone builds as `x.y.0`.
- `scripts/update-pdfjs.js` manages it. Run it through npm (`pdfjs:check`, `pdfjs:update`, `pdfjs:build`):
  - With no argument, it switches to the latest release tag, builds it and stages the submodule.
  - With `vX.Y.Z`, it switches to that release.
  - `--check` prints the pinned and latest versions and changes nothing.
  - `--build` rebuilds the pinned release.
  - `--build-if-missing` builds it only if there is no build yet. `npm start` runs this first.
- The build output is `vendor/pdf.js/build/generic/`, plus `build/version.json`. pdf.js's own `.gitignore` covers it, so the submodule stays clean. In dev the app serves it from there. Packaged builds copy it to `pdfjs` in the app's resources directory: `Contents/Resources/` on macOS, `resources\` on Windows.
- Updating to a new release:
  1. Run `npm run pdfjs:update`.
  2. Read the upstream release notes.
  3. Check `bridge.js` and `overrides.css` against the new `web/app.js` and `web/viewer.html`. That includes `isMenuShortcut` in `bridge.js` against pdf.js's key handling in `onKeyDown` (`web/app.js`) and `web/pdf_print_service.js`, for ⌘ on macOS and for Ctrl and F4 on Windows. Also check the range transport in `bridge.js` against `PDFDataRangeTransport` (`src/display/api.js`) and `src/display/transport_stream.js`, and against `getNetworkStream` (`src/display/network_stream.js`), in case pdf.js now makes range requests for other schemes itself. Also check the CSP header in `protocol.js` against the `<meta>` CSP in `web/viewer.html`. Chromium enforces both, so the header must not be stricter than what pdf.js needs.
  4. Run the unit and e2e tests on macOS and Windows.
  5. Commit `Update pdf.js to vX.Y.Z`, containing the submodule bump plus any bridge fixes it required.

## How the viewer is served

Everything the window loads comes from the custom privileged scheme `pdflion://app/` (standard, secure, fetch, stream):

| Path | Serves |
|---|---|
| `/viewer/…` | the pdf.js generic build. For `web/viewer.html`, the handler injects `overrides.css` and `bridge.js` before `</head>` and adds a CSP header |
| `/pdflion/…` | `src/viewer/` |
| `/doc/<token>/<name>.pdf` | a file the user opened, whole or as byte ranges. The main process mints tokens, so the renderer can only read files the user chose |

A window loads `pdflion://app/viewer/web/viewer.html?file=/doc/<token>/<name>.pdf`.
- The document must be same-origin, because the generic viewer rejects a `file=` from any other origin.
- `bridge.js` sets `defaultUrl` to `""` so the pdf.js demo PDF never opens.
- `bridge.js` is a classic script. It runs before the viewer's module scripts, so its `webviewerloaded` listener is in place before the viewer initialises.
- pdf.js makes range requests only for http(s) URLs, so `bridge.js` opens `/doc/` URLs through a `PDFDataRangeTransport`. It streams the file and fetches the parts pdf.js needs sooner as byte ranges, with `If-Match` so that a changed file gets 412.
- The handler resolves every path against its root and returns 404 for anything that escapes it.

## Security rules

- Every window uses `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`, and `app.enableSandbox()` sandboxes every renderer.
- The preload exposes a small, explicit API through `contextBridge` and never exposes `ipcRenderer` itself. It exposes the API only on the viewer page, since the preload runs in every page a window shows.
- Main validates the sender and the payload of every IPC message. The sender must be the top frame, and its URL must be the viewer. Don't switch to comparing origins, as the Electron checklist suggests: an `about:blank` page the viewer navigates to has the viewer's origin.
- Navigation away from `pdflion://app/viewer/` is blocked. External links (`http`, `https`, `mailto` only) open with `shell.openExternal`. Every other `window.open` is denied.
- `viewer.html` is served with a CSP: no `unsafe-eval`, and `wasm-unsafe-eval` for pdf.js's image decoders.
- Permission requests and checks are denied, except `fullscreen` and `clipboard-sanitized-write` for the viewer (`permissions.js`).
- The packaged app's Electron fuses (`electron-builder.yml`) turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect` and file:// privileges. They load the app only from `app.asar`, after checking its hash, and they encrypt cookies.

### Electron security checklist

Reviewed in phase 9 against the [checklist](https://www.electronjs.org/docs/latest/tutorial/security). Items 1–4, 6–10, 13, 14, 16, 18 and 20 are met as the rules above describe. The rest:

- 5 (permission handlers): met, with handlers for requests and checks. PDFLion sets no device or screen-sharing handlers, so WebHID, Web Serial, WebUSB, Bluetooth and `getDisplayMedia` fail.
- 11, 12 (`<webview>`): not applicable. No window enables `webviewTag`, so no `will-attach-webview` handler.
- 13 (navigation): `will-navigate` doesn't fire for `about:blank` and `about:srcdoc`, which only page scripts can reach. Those pages get no `window.pdflion`, and main ignores their messages.
- 15 (`shell.openExternal`): links in PDFs are untrusted, and opening them is deliberate. Only `http`, `https` and `mailto` reach it.
- 17 (IPC senders): checks the frame's URL rather than its origin, as above.
- 19 (fuses): all set, see above. `LoadBrowserProcessSpecificV8Snapshot` stays off, because PDFLion has no browser-only snapshot.
- Downloads keep Electron's default, a save dialog. pdf.js uses them for attachments and for a PDF script's Save As.

## Conventions

- Small modules in `src/main/`, one responsibility each, and no catch-all `utils.js`.
- Dev-vs-packaged path logic lives only in `src/main/paths.js`.
- Commit messages use the imperative mood and a short subject, e.g. `Add native File menu`.
