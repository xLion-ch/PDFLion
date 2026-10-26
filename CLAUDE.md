# PDFLion

A PDF viewer for macOS (Apple silicon and Intel), Windows and Linux (Ubuntu and Linux Mint): Mozilla's [pdf.js](https://github.com/mozilla/pdf.js) generic viewer wrapped in Electron. The shell stays thin. pdf.js does the rendering and provides the viewer UI. Electron adds what a browser tab can't: opening files from Finder, Explorer and Linux file managers, native menus and shortcuts, saving in place, and packaging as a Mac app, a Windows installer and a Linux package.

[README.md](README.md) covers installing, building, and the checks to do by hand before a release.

## Ground rules

- **Never commit.** Not even when a plan or task says to. Leave the changes in the working tree, stage them if asked, and suggest a commit message. The user commits.
- **Never edit `vendor/pdf.js/`.** It is a git submodule pinned to an upstream release tag. All customisation happens outside it:
  - `src/viewer/bridge.js` is a main-world script that sets `PDFViewerApplicationOptions` and drives `PDFViewerApplication`.
  - `src/viewer/overrides.css` restyles the viewer UI in Material Design 3, with Material Symbols icons from `src/viewer/icons/`.
  - The `pdflion://` protocol handler (`src/main/protocol.js`) injects both into `viewer.html` as it serves it.

  If something seems to need a pdf.js patch, look for a way through those three first. If there really is none, stop and ask.
- Prefer pdf.js's built-in behaviour over reimplementing it.
- `bridge.js` is the only code that touches pdf.js internals (`PDFViewerApplication`, its `eventBus`, `AppOptions`). These are not a stable API and change between releases. For example, `pdfSidebar` became `viewsManager`, and `isEvalSupported` was removed. Check names against `vendor/pdf.js/web/app.js` and `web/app_options.js` for the pinned version, never from memory.
- The app runs on macOS, Windows and Linux (Ubuntu and Linux Mint) and follows each platform's conventions. On all three, each document gets its own window.
  - macOS: the menu bar, ⌘ shortcuts, and the app keeps running after its last window closes.
  - Windows: a menu bar in each window, Ctrl shortcuts, and the app quits when its last window closes. A PDF opened while PDFLion runs goes to the running process.
  - Linux: like Windows, except for File > Quit with Ctrl+Q where Windows has Exit, GTK's About dialog, and GNOME's button order in the save prompt, with Save rightmost.

  Branch on `process.platform === "darwin"` in the module concerned, and on `"win32"` or `"linux"` where those two differ. Before relying on an Electron API, check its `@platform` in `node_modules/electron/electron.d.ts`. Many window and menu APIs, such as `isDocumentEdited()` and the `recentDocuments` role, are macOS only. Others leave out Linux, such as `app.addRecentDocument()`, `setAppUserModelId()`, a window's `moved`, `resized` and `query-session-end` events, and the About panel's `credits`.
- Code is written on a Mac. Anything Windows- or Linux-specific stays unverified until it has run on a Windows PC or a Linux PC, so say so when reporting it.

## Stack

- Electron (latest stable), main process as ES modules (`"type": "module"`).
- Plain JavaScript with JSDoc. No TypeScript, no bundler, no UI framework, because the UI is pdf.js's.
- The preload is CommonJS (`preload.cjs`), because sandboxed preloads can't be ES modules.
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
  documents.js   token registry for opened files, atomic writes (Electron-free, unit tested)
  saving.js      Save and Save As: dialogs and error alerts
  unsaved.js     save prompts when an edited window closes, the app quits, a Windows session ends, or Linux shuts down
  windows.js     one BrowserWindow per document, where it opens, its edited state, the Open panel, navigation guards
  placement.js   where a new window opens: the last window's place, on screen, cascaded (Electron-free, unit tested)
  state.js       userData/state.json: the last window placement and, on Windows and Linux, recent documents
  recent.js      recent documents, plus PDFLion's own list for File > Open Recent on Windows and Linux
  ipc.js         IPC handlers (sender and payload checks), runCommand() to bridge.js
  permissions.js web permission handlers: deny all but full screen and clipboard writes
  menu.js        native menu, with items for macOS only or for Windows and Linux, and the About panel
  credits.js     the third-party projects the About panel lists (Electron-free, unit tested)
  paths.js       the only place that knows dev vs packaged locations
src/preload/
  preload.cjs    contextBridge API exposed as window.pdflion
src/viewer/      served at pdflion://app/pdflion/, injected into viewer.html
  bridge.js
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
  3. Check `bridge.js` and `overrides.css` against the new `web/app.js` and `web/viewer.html`. That includes `isMenuShortcut` in `bridge.js` against pdf.js's key handling in `onKeyDown` (`web/app.js`) and `web/pdf_print_service.js`, for ⌘ on macOS and for Ctrl and F4 on Windows. Also check the range transport in `bridge.js` against `PDFDataRangeTransport` (`src/display/api.js`) and `src/display/transport_stream.js`, and against `getNetworkStream` (`src/display/network_stream.js`), in case pdf.js now makes range requests for other schemes itself. Check the variables and selectors in `overrides.css` against `web/viewer.css`: pdf.js renames them, and a missing one fails silently, leaving that part in pdf.js's own style. Also check the CSP header in `protocol.js` against the `<meta>` CSP in `web/viewer.html`. Chromium enforces both, so the header must not be stricter than what pdf.js needs.
  4. Check what pdf.js bundles against the "pdf.js includes" group in `src/main/credits.js` and README's Credits: the projects in `vendor/pdf.js/external/` and the license files in the build's `web/` folders. A release can add or drop one.
  5. Run the unit and e2e tests on macOS and Windows.
  6. Stage the submodule bump plus any bridge fixes it required, and suggest the commit message `Update pdf.js to vX.Y.Z`. The user commits.

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

## Menu commands

- Menu items that act on the document come from `commandItem()` in `menu.js`. A click calls `runCommand(win, command)` in `ipc.js`, which sends the command to `bridge.js`, and `COMMANDS` there maps it to pdf.js. A new command needs all three, plus an end-to-end test.
- The page sees key presses before the native menu, on every platform alike, and the menu only gets the ones the page leaves unhandled. `isMenuShortcut` in `bridge.js` keeps pdf.js from acting on the shortcuts it shares with the menu. A new shortcut that pdf.js also binds needs adding there.
- A click on the native menu gives the page no user activation, which some web APIs need, such as `requestFullscreen()` for Presentation Mode. `runCommand()` grants it for the commands in `COMMANDS_NEEDING_ACTIVATION`.
- Menu labels mark Windows and Linux access keys with `&`, as in `&File`. macOS drops the `&`. Write a literal `&` as `&&`.

## Security rules

- Every window uses `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`, and `app.enableSandbox()` sandboxes every renderer.
- The preload exposes a small, explicit API through `contextBridge` and never exposes `ipcRenderer` itself. It exposes the API only on the viewer page, since the preload runs in every page a window shows.
- Main validates the sender and the payload of every IPC message. The sender must be the top frame, and its URL must be the viewer. Don't switch to comparing origins, as the Electron checklist suggests: an `about:blank` page the viewer navigates to has the viewer's origin.
- Navigation away from `pdflion://app/viewer/` is blocked. External links (`http`, `https`, `mailto` only) open with `shell.openExternal`. Every other `window.open` is denied.
- `viewer.html` is served with a CSP: no `unsafe-eval`, and `wasm-unsafe-eval` for pdf.js's image decoders.
- Permission requests and checks are denied, except `fullscreen` and `clipboard-sanitized-write` for the viewer (`permissions.js`).
- The packaged app's Electron fuses (`electron-builder.yml`) turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect` and file:// privileges. They load the app only from `app.asar`, after checking its hash on macOS and Windows, and they encrypt cookies.

### Electron security checklist

Reviewed in October 2026, for Electron 45, against the [checklist](https://www.electronjs.org/docs/latest/tutorial/security). Items 1–4, 6–10, 13, 14, 16, 18 and 20 are met as the rules above describe. The rest:

- 5 (permission handlers): met, with handlers for requests and checks. PDFLion sets no device or screen-sharing handlers, so WebHID, Web Serial, WebUSB, Bluetooth and `getDisplayMedia` fail.
- 11, 12 (`<webview>`): not applicable. No window enables `webviewTag`, so no `will-attach-webview` handler.
- 13 (navigation): `will-navigate` doesn't fire for `about:blank` and `about:srcdoc`, which only page scripts can reach. Those pages get no `window.pdflion`, and main ignores their messages.
- 15 (`shell.openExternal`): links in PDFs are untrusted, and opening them is deliberate. Only `http`, `https` and `mailto` reach it.
- 17 (IPC senders): checks the frame's URL rather than its origin, as above.
- 19 (fuses): all set, see above. `LoadBrowserProcessSpecificV8Snapshot` stays off, because PDFLion has no browser-only snapshot. Electron checks the hash of `app.asar` only on macOS and Windows. On Linux, `EnableEmbeddedAsarIntegrityValidation` only makes it check its V8 snapshot, so nothing checks that `app.asar` is unchanged.
- Downloads keep Electron's default, a save dialog. pdf.js uses them for attachments and for a PDF script's Save As.

## Packaging

- `electron-builder.yml` configures it. `npm run dist` builds this platform's installers, and `npm run build` (`scripts/build.js`) runs the tests first, then builds everything the machine can.
- Mac builds are signed ad hoc (`identity: "-"`). Apple silicon runs only signed code, and flipping the fuses changes the signed Electron binary, so a build with signing skipped is killed at launch.
- `fileAssociations` uses `rank: Alternate`, so PDFLion appears in Finder's Open With without becoming the default viewer. On Windows the installer registers PDFLion as a PDF handler, so it appears under Open with. Windows never changes the default app without asking.
- The NSIS installer is one-click and per user: no admin rights, installed into `%LOCALAPPDATA%\Programs`.
- The pdf.js build doesn't depend on the platform, so every build ships the same `pdfjs/` folder, license files included.
- electron-builder's `makensis` for macOS is an Intel binary, so building the Windows installer on Apple silicon needs Rosetta.
- On Linux, the `.deb` installs into `/opt/PDFLion`, with `pdflion` in `/usr/bin`. Its `.desktop` file is named after `desktopName` in `package.json`, which Electron also uses as the Wayland app ID and X11 WM_CLASS, so the dock groups the windows with their launcher. `Exec` ends in `%F`, so file managers pass paths rather than URIs.
- `linux.mimeTypes` lists PDFLion for `application/pdf`, so it appears under Open With in Files and Nemo without becoming the default. It isn't a `mimeType` in `fileAssociations`, because electron-builder would then also install a MIME definition for `application/pdf`, whose icon replaces the PDF icon in file managers.
- The sandbox stays on under Linux. The `.deb`'s post-install script makes `chrome-sandbox` setuid where user namespaces don't work. On Ubuntu 24.04 and later, which restrict them, it installs an AppArmor profile that allows them for `/opt/PDFLion/pdflion`.
- No AppImage: it can't carry a setuid helper, and Ubuntu 24.04 restricts the user namespaces the sandbox needs otherwise, so it would only run with `--no-sandbox`.
- The `.deb` is built on a Linux PC, where it can be tested. electron-builder can build it on a Mac too, but `npm run build` leaves it out there.

## Tests

- `npm test` runs `node --test "test/unit/**/*.test.js"`. The glob is quoted so Node expands it: since Node 21, `node --test` treats a directory argument as a file.
- Modules that unit tests import stay free of Electron: `arguments.js`, `routes.js`, `ranges.js`, `documents.js`, `placement.js` and `credits.js`.
- `bridge.test.js` runs `bridge.js` itself in `node:vm`, with stand-ins for `window.pdflion` and `PDFViewerApplication`. When the bridge starts using something new from the page, add it to the stand-ins. The test also reads `menu.js` for `commandItem("label", "command", …)` calls, to check that the bridge knows every command.
- `npm run test:e2e` drives the dev app with Playwright. Each launch gets its own `--user-data-dir`. `test/e2e/pdfs.js` writes the test PDFs, so no binary fixtures are committed. The suite is the safety net for pdf.js updates, so it must cover every bridge command. `windows-linux.spec.js` runs only on Windows and Linux.
- In end-to-end tests, `page.evaluate()` counts as a user gesture. Where user activation matters, read the page from main with `webContents.executeJavaScript()`.

## Decisions

These were settled on purpose. Change them only on purpose.

- The bundle ID is `io.github.xlion-ch.pdflion`: `appId` in `electron-builder.yml`, repeated as `APP_ID` in `main.js`. Changing it after the first release resets user preferences and file associations. On Windows it is also the AppUserModelID, which groups the app's taskbar buttons with its Start menu shortcut.
- One build per Mac architecture, each about half the size of a universal build. The alternative is a single `universal` build, so nobody can download the wrong one.
- Windows x64 only. Windows on Arm runs it emulated. Adding `arm64` would run it natively there.
- Linux gets a `.deb` for x64, for Ubuntu 22.04 and Linux Mint 21 and later, and nothing else. AppImage would lose the sandbox on Ubuntu 24.04, and Flatpak and Snap bring their own confinement, which Electron's sandbox would have to fit into, and their own stores.
- Launching without a file shows the Open panel, like Preview. On Windows the app then quits if the panel is cancelled, because a Windows app without windows has nothing to show. The alternative is an empty viewer window.
- No code signing, no notarization, no CI and no auto-updates. Releases are built by hand, as the README describes. On macOS, auto-updates would need a Developer ID signature anyway: Electron's updater accepts only an update signed like the running app, and an ad-hoc signature differs with every build.
- The viewer follows Material Design 3, as CSS on top of pdf.js's own UI rather than a UI library. The colour scheme is Material's monochrome one: near-white in light mode, near-black in dark mode. Text uses the system font, not Roboto. Colours apply only outside forced-colors mode, which keeps pdf.js's high contrast styles.
- Window placement is kept in `state.json`, not with Electron's `windowStatePersistence`. That remembers each window under a unique name, so it can't give a new document the last window's place.

## Known limitations

- The native menus are in English. The viewer, and the items macOS adds to the menus, follow the system language.
- On Wayland, which Ubuntu uses by default, apps can't place their windows, so new windows open where the compositor puts them rather than where the last one was. Mint's Cinnamon uses X11, where placement works.
- Shutting down Linux with unsaved changes holds off the shutdown while PDFLion asks about them, but only for as long as systemd allows (`InhibitDelayMaxSec`, 5 s by default). After that the changes are lost.
- Copying the text of a whole document fails if pdf.js needs more than about 5 s to gather it. Chromium then asks for `clipboard-read` instead of `clipboard-sanitized-write`, and `permissions.js` denies it.

## Conventions

- Small modules in `src/main/`, one responsibility each, and no catch-all `utils.js`.
- Dev-vs-packaged path logic lives only in `src/main/paths.js`.
- Every third-party project PDFLion uses goes into the About panel and the README, with its link and license: `CREDITS` in `src/main/credits.js`, and Credits in `README.md`. That includes what only builds or tests the app, what pdf.js or Electron brings along, and design resources such as icons and fonts. `credits.test.js` fails when the two don't list the same links.
- Commit messages use the imperative mood and a short subject, e.g. `Add native File menu`.
