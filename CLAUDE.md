# PDFLion

A native macOS PDF viewer: Mozilla's [pdf.js](https://github.com/mozilla/pdf.js) generic viewer wrapped in Electron. The shell stays thin. pdf.js does the rendering and provides the viewer UI. Electron adds what a browser tab can't: opening files from Finder, native menus and shortcuts, saving in place, and packaging as a signed `.app`.

Implementation status and next steps are in [PLAN.md](PLAN.md). Tick items off there as they land.

## Ground rules

- **Never edit `vendor/pdf.js/`.** It is a git submodule pinned to an upstream release tag. All customisation happens outside it:
  - `src/viewer/bridge.js` is a main-world script that sets `PDFViewerApplicationOptions` and drives `PDFViewerApplication`.
  - `src/viewer/overrides.css` adjusts the viewer UI.
  - The `pdflion://` protocol handler (`src/main/protocol.js`) injects both into `viewer.html` as it serves it.

  If something seems to need a pdf.js patch, look for a way through those three first. If there really is none, stop and ask.
- Prefer pdf.js's built-in behaviour over reimplementing it.
- `bridge.js` is the only code that touches pdf.js internals (`PDFViewerApplication`, its `eventBus`, `AppOptions`). These are not a stable API and change between releases. For example, `pdfSidebar` became `viewsManager`, and `isEvalSupported` was removed. Check names against `vendor/pdf.js/web/app.js` and `web/app_options.js` for the pinned version, never from memory.
- The app is macOS only, so follow Mac conventions: menu bar, Cmd shortcuts, one window per document, and the app keeps running after its last window closes.

## Stack

- Electron (latest stable), main process as ES modules (`"type": "module"`).
- Plain JavaScript with JSDoc. No TypeScript, no bundler, no UI framework, because the UI is pdf.js's.
- The preload is CommonJS (`preload.cjs`), because sandboxed preloads can't be ES modules.
- electron-builder for packaging, signing and notarization.
- Node 24 LTS (`.nvmrc`). The pdf.js build requires Node `>=22.22.3 || >=24.15.0 || >=26.0`.

## Layout

This is the target layout. Directories appear as PLAN.md phases land.

```
src/main/        main process: one module per concern
  main.js        app lifecycle, open-file queue
  protocol.js    pdflion:// scheme handler
  routes.js      pdflion:// URL layout: viewer URLs, /doc/ tokens, mount paths. Electron-free so unit tests can import it
  documents.js   token registry for opened files, save / save as
  windows.js     one BrowserWindow per document, the Open panel, navigation guards
  ipc.js         IPC handlers (sender and payload checks), sending commands to bridge.js
  menu.js        native menu
  paths.js       the only place that knows dev vs packaged locations
src/preload/
  preload.cjs    contextBridge API exposed as window.pdflion
src/viewer/      served at pdflion://app/pdflion/, injected into viewer.html
  bridge.js
  overrides.css
resources/       icon, entitlements (electron-builder buildResources)
scripts/
  update-pdfjs.sh
test/unit/       node --test, files named *.test.js
test/e2e/        Playwright against the real app
vendor/pdf.js/   submodule, never edit
```

## Commands

```sh
git clone --recurse-submodules https://github.com/c14ud3/PDFLion.git
npm install
npm run pdfjs:build      # build the pinned pdf.js viewer (once per clone and after each update)
npm start                # run in dev; npm start -- path/to/file.pdf opens a file
npm test                 # unit tests
npm run test:e2e         # Playwright smoke tests
npm run dist             # .dmg / .zip in dist/
```

## pdf.js

- The submodule at `vendor/pdf.js` uses full history on purpose. pdf.js computes its version from git history, so a shallow clone builds as `x.y.0`.
- `scripts/update-pdfjs.sh` manages it:
  - With no argument, it switches to the latest release tag, builds it and stages the submodule.
  - With `vX.Y.Z`, it switches to that release.
  - `--check` prints the pinned and latest versions and changes nothing.
  - `--build` rebuilds the pinned release.
- The build output is `vendor/pdf.js/build/generic/`, plus `build/version.json`. pdf.js's own `.gitignore` covers it, so the submodule stays clean. In dev the app serves it from there. Packaged builds copy it to `Contents/Resources/pdfjs`.
- Updating to a new release:
  1. Run `npm run pdfjs:update`.
  2. Read the upstream release notes.
  3. Check `bridge.js` and `overrides.css` against the new `web/app.js` and `web/viewer.html`. That includes `isMenuShortcut` in `bridge.js` against pdf.js's key handling in `onKeyDown` (`web/app.js`) and `web/pdf_print_service.js`. Also check the CSP header in `protocol.js` against the `<meta>` CSP in `web/viewer.html`. Chromium enforces both, so the header must not be stricter than what pdf.js needs.
  4. Run the unit and e2e tests.
  5. Commit `Update pdf.js to vX.Y.Z`, containing the submodule bump plus any bridge fixes it required.

## How the viewer is served

Everything the window loads comes from the custom privileged scheme `pdflion://app/` (standard, secure, fetch, stream):

| Path | Serves |
|---|---|
| `/viewer/…` | the pdf.js generic build. For `web/viewer.html`, the handler injects `overrides.css` and `bridge.js` before `</head>` and adds a CSP header |
| `/pdflion/…` | `src/viewer/` |
| `/doc/<token>/<name>.pdf` | a file the user opened. The main process mints tokens, so the renderer can only read files the user chose |

A window loads `pdflion://app/viewer/web/viewer.html?file=/doc/<token>/<name>.pdf`.
- The document must be same-origin, because the generic viewer rejects a `file=` from any other origin.
- `bridge.js` sets `defaultUrl` to `""` so the pdf.js demo PDF never opens.
- `bridge.js` is a classic script. It runs before the viewer's module scripts, so its `webviewerloaded` listener is in place before the viewer initialises.
- The handler resolves every path against its root and returns 404 for anything that escapes it.

## Security rules

- Every window uses `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`.
- The preload exposes a small, explicit API through `contextBridge` and never exposes `ipcRenderer` itself. Main validates the sender and the payload of every IPC message.
- Navigation away from `pdflion://app/viewer/` is blocked. External links (`http`, `https`, `mailto` only) open with `shell.openExternal`. Every other `window.open` is denied.
- `viewer.html` is served with a CSP: no `unsafe-eval`, and `wasm-unsafe-eval` for pdf.js's image decoders.
- Permission requests are denied by default.

## Conventions

- Small modules in `src/main/`, one responsibility each, and no catch-all `utils.js`.
- Dev-vs-packaged path logic lives only in `src/main/paths.js`.
- Commit messages use the imperative mood and a short subject, e.g. `Add native File menu`.
