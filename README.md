> [!NOTE]
> This project contains AI-generated code.

![PDFLion Logo](resources/icon.svg)

# PDFLion

A PDF viewer for macOS, Windows and Linux. It's based on Mozilla's [pdf.js](https://github.com/mozilla/pdf.js).

- Opens PDFs from the file manager, the Open dialog, or dropped on a window, as tabs of the front window. Tabs can be dragged into another order, onto another window, or out into a window of their own.
- Saves form data and annotations into the file, or to a new one with Save As, and asks about unsaved changes before closing or quitting.
- File > New opens an untitled document with one blank page, US Letter or A4, whichever your region uses.
- In the sidebar's thumbnails, and in View > Page Overview, which shows them as a grid across the window, pages can be moved, copied, cut, deleted and exported, and PDFs or images added. These changes are saved as a new file, which leaves out some of what the old one held, such as XMP metadata, layers and document scripts, and PDFLion asks first.
- Edit > Insert Blank Page, and the page overview's Rotate Pages Left and Right, are saved as additions to the end of the file, so everything else in it stays as it was.
- Documents with a password can't have their pages changed, and signed documents ask first.
- The Eraser, after Pencil, erases the parts of lines it passes over, or whole drawings, also those another app left in the file. A pen's eraser end erases too, without picking the Eraser.
- Save as Favourite, in the options of Highlight, Text and Pencil, keeps the tool's settings, such as a blue pencil 1 point wide, as a button in the toolbar of every window.
- Zoom, rotation, search, sidebar, Presentation Mode and printing, from the menus and the platform's usual shortcuts.
- Follows the system's light or dark appearance, and in the viewer its language. The menus are in English.
- Remembers the last window's place and recently opened files, and updates itself from the releases on GitHub.

PDFLion's only network requests of its own are its checks for updates. Links in a document open in your browser or mail app, and only `http`, `https` and `mailto` links open at all.

## Installing

PDFLion runs on macOS 13 Ventura or later, on Apple silicon and Intel Macs, on 64-bit Windows 10 and 11, and on 64-bit Ubuntu 22.04 and Linux Mint 21 or later. Pick the build for your computer from the [latest release](https://github.com/xLion-ch/PDFLion/releases/latest):

| Build | For |
|---|---|
| `PDFLion-<version>-mac-arm64.dmg` | Macs with Apple silicon (M1 and later) |
| `PDFLion-<version>-mac-x64.dmg` | Intel Macs |
| `PDFLion-<version>-win-x64.exe` | Windows; Windows on Arm runs it emulated |
| `PDFLion-<version>-linux-amd64.deb` | Ubuntu and Linux Mint on Intel and AMD processors |

PDFLion isn't signed with an Apple or Microsoft certificate, so macOS and Windows warn the first time.

**macOS:** open the DMG and drag PDFLion to Applications. The first launch is blocked with a message that Apple couldn't check the app: open System Settings > Privacy & Security, and click Open Anyway by the message about PDFLion. To make it the default for PDFs, select a PDF in Finder, choose File > Get Info, pick PDFLion under Open With, and click Change All.

**Windows:** run the installer. SmartScreen shows "Windows protected your PC": click More info, then Run anyway. PDFLion installs for your user only, without administrator rights, and appears under Open with for PDFs. To make it the default, use Settings > Apps > Default apps. Uninstall it from Settings > Apps.

**Linux:** in the folder with the package, run `sudo apt install ./PDFLion-<version>-linux-amd64.deb`. PDFLion appears among your apps, and under Open With for PDFs in Files and Nemo, where you can also make it the default. Uninstall it with `sudo apt remove pdflion`.

### Updates

PDFLion checks for a new release when it starts and every 6 hours, downloads it in the background, and asks whether to restart now. Restart Now asks about unsaved changes first. Otherwise the update installs when you quit PDFLion, except on Linux, where installing asks for an administrator's password, so it installs only with Restart Now. On macOS PDFLion updates only from the Applications folder.

Check for Updates… and Check for Updates Automatically are in the PDFLion menu on macOS, and in the Help menu on Windows and Linux. A check tells GitHub your computer's IP address, and nothing else. A copy without Check for Updates… is from before updates came in: download the latest release once.

## Shortcuts

| | macOS | Windows | Linux |
|---|---|---|---|
| New | ⌘N | Ctrl+N | Ctrl+N |
| Open… | ⌘O | Ctrl+O | Ctrl+O |
| Save / Save As… | ⌘S / ⇧⌘S | Ctrl+S / Ctrl+Shift+S | Ctrl+S / Ctrl+Shift+S |
| Print… | ⌘P | Ctrl+P | Ctrl+P |
| Close Tab | ⌘W | Ctrl+W | Ctrl+W |
| Close Window | ⇧⌘W | Ctrl+Shift+W | Ctrl+Shift+W |
| Show Next Tab | ⌃Tab or ⇧⌘] | Ctrl+Tab or Ctrl+Page Down | Ctrl+Tab or Ctrl+Page Down |
| Show Previous Tab | ⌃⇧Tab or ⇧⌘[ | Ctrl+Shift+Tab or Ctrl+Page Up | Ctrl+Shift+Tab or Ctrl+Page Up |
| Find… | ⌘F | Ctrl+F | Ctrl+F |
| Insert Blank Page | ⇧⌘N | Ctrl+Shift+N | Ctrl+Shift+N |
| Eraser | ⇧⌘E | Ctrl+Shift+E | Ctrl+Shift+E |
| Toggle Sidebar | ⌥⌘S | F4 | F4 |
| Page Overview | ⌥⌘6 | Ctrl+Shift+O | Ctrl+Shift+O |
| Zoom In / Zoom Out | ⌘+ / ⌘− | Ctrl++ / Ctrl+− | Ctrl++ / Ctrl+− |
| Actual Size | ⌘0 | Ctrl+0 | Ctrl+0 |
| Rotate Left / Right | ⌘L / ⌘R | Ctrl+L / Ctrl+R | Ctrl+L / Ctrl+R |
| Presentation Mode | ⇧⌘F | Ctrl+Shift+F | Ctrl+Shift+F |
| Full Screen | ⌃⌘F | F11 | F11 |
| Quit | ⌘Q | (closing the last window) | Ctrl+Q |

## Building from source

You need [Node.js](https://nodejs.org) 24 (see `.nvmrc`), Git, and a Mac, a Windows PC or a Linux PC.

```sh
git clone --recurse-submodules https://github.com/xLion-ch/PDFLion.git
cd PDFLion
npm install
npm start                      # runs PDFLion from the source; the first run also builds pdf.js
npm start -- path/to/file.pdf  # and opens a file
npm run build                  # runs all the tests, then builds the installers into dist/
```

`npm run build` builds both Mac versions on a Mac, and with Rosetta (`softwareupdate --install-rosetta`) the Windows installer too, the Windows installer on Windows, and the `.deb` on Linux, which needs `ar` (`sudo apt install binutils`).

## Development

```sh
npm test               # unit tests
npm run test:e2e       # end-to-end tests: they open windows and take focus while they run
npm run pdfjs:check    # is there a newer pdf.js release?
npm run pdfjs:update   # switch to it and rebuild pdf.js
```

GitHub Actions runs the tests on macOS, Windows and Linux for every pull request into `main`, and every push to `main` that changes more than Markdown files, then builds the installers and keeps them for 14 days, except for pull requests from forks. Builds are numbered `<major>.<minor>.<commits>`, from `package.json` and the commit count, and a pull request's `<version>-pr.<number>`. `node scripts/version.js` prints the version of the commit checked out.

pdf.js is a Git submodule in `vendor/pdf.js`, pinned to a release and never edited. PDFLion adds to it from outside, in `src/viewer/`, and the main process is in `src/main/`. [CLAUDE.md](CLAUDE.md) describes the architecture, the rules and the decisions behind them.

## Releasing

Every push to `main` that changes more than Markdown files is a release. Once its tests and builds pass on all three platforms, CI publishes the GitHub release `v<version>`, with the installers, the Mac `.zip` files and the update files, and installed copies update to it within 6 hours. A failed run releases nothing, and a commit is never released twice. So:

1. Make the change on a branch, and open a pull request into `main`. CI builds its installers as `<version>-pr.<number>`.
2. Go through the checks by hand below that the change touches, with those installers. The Windows and Linux checks haven't been done for any release yet.
3. Merge it.

To raise the major or minor version, edit `package.json`, keeping the patch version at 0. Update pdf.js in a pull request of its own, as [CLAUDE.md](CLAUDE.md) describes.

The releases rely on settings of the repository on GitHub:

- A ruleset protects `main`: changes come through pull requests, the checks `pdf.js`, `mac`, `windows` and `linux` must pass, and `main` can't be force-pushed, which could lower the version, or deleted. `pdf.js` is required too, since GitHub counts skipped checks as passed.
- The `release` environment allows only `main`.
- Everyone who can push to `main` or change these settings uses two-factor authentication.

### Checks by hand

On a Mac with Apple silicon:

- The DMG installs on a Mac that has never run PDFLion, and the app starts once allowed under Privacy & Security. Made the default in Finder's Open With, it opens PDFs.
- The shortcuts work from the keyboard, without pdf.js also acting on them: ⌘S saves without a download, ⇧⌘F starts Presentation Mode, ⇧⌘N inserts one page, ⌥⌘6 opens and closes the page overview, also with a Swiss German or French keyboard layout, and ⇧⌘E turns the eraser on and off, also with the overview open or Pencil on.
- The title bar's proxy icon follows the selected tab, and opened files appear in the Dock menu's recent documents.
- With "Prefer tabs when opening documents" set to Always, windows still don't become macOS's own tabs.
- The viewer follows the appearance setting, Print shows the native dialog with every page, and a trackpad pinch zooms the pages, not the window.
- The previous release, downloaded from GitHub and installed in Applications, offers the latest about 10 seconds after it starts. Restart Now with an edited document asks about it first, then installs and starts the new version, with no prompt about modifying apps and no other Gatekeeper warning. Later, then ⌘Q, installs it without starting PDFLion again. Started from Downloads without moving it, Check for Updates… says it can't be installed there.
- On an Intel Mac, or under Rosetta, the x64 build starts.

On a Windows PC:

- `npm run build` passes in PowerShell.
- The installer runs without administrator rights after SmartScreen's More info > Run anyway. Made the default under Open with, PDFLion opens PDFs, and uninstalling removes the app and its file association.
- Ctrl+O, Ctrl+S, Ctrl+P, Ctrl+F, Ctrl+Shift+F, Ctrl++, Ctrl+=, Ctrl+−, Ctrl+0, F4, F11, Ctrl+W, Ctrl+Shift+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Page Down, Ctrl+Page Up, Ctrl+Shift+N, Ctrl+Shift+O and Ctrl+Shift+E each do one thing, and pdf.js doesn't also act on them. AltGr characters can still be typed into form fields, and Alt+F opens the File menu.
- Editing a form puts `*` before the title, and closing the window, Exit, and closing the last window each ask about it.
- A PDF opened from Explorer while PDFLion runs opens as a tab of its front window, in front of other windows, or selects its tab if it's open already. A PDF dropped from Explorer onto a window opens as a tab there.
- Cancelling the Open dialog at launch quits the app, and so does a launch with a file that can't be read.
- Saving a file another app has open, and saving to a network share, either works or shows an error and keeps the changes. If antivirus scanning makes saving fail with `EPERM` or `EBUSY`, saving needs a short retry. A large PDF on a network share shows its first page before the rest has loaded.
- Shutting down or signing out with unsaved changes waits while PDFLion asks about them.
- The taskbar button groups with the pinned or Start menu shortcut, and the jump list shows recent files.
- The viewer follows Settings > Personalization > Colors, and a touchpad or touchscreen pinch zooms the pages.
- The previous release offers the latest about 10 seconds after it starts, and SmartScreen and Defender let the downloaded installer run. Restart Now with an edited document asks about it first, then installs without showing the installer or asking for administrator rights, and starts the new version. Later, then quitting, installs it without starting PDFLion again. Shutting down with an update downloaded doesn't install it, and the next launch offers it again.

On Ubuntu 24.04 in its default Wayland session, and on Linux Mint 22 Cinnamon, which uses X11:

- `npm run build` passes.
- `sudo apt install ./dist/PDFLion-<version>-linux-amd64.deb` installs it, and PDFLion starts from the app menu with Chromium's sandbox on: `grep Seccomp /proc/$(pgrep -f -- --type=renderer | head -1)/status` shows `Seccomp: 2`.
- The app menu and the dock show PDFLion's icon, and the dock groups its windows with the launcher.
- PDFLion is under Open With for PDFs in Files and Nemo, and PDFs keep their own icon. Made the default, it opens PDFs, and `sudo apt remove pdflion` removes the app and its Open With entry.
- A PDF opened from the file manager while PDFLion runs opens as a tab of its front window, or selects its tab if it's open already.
- Ctrl+O, Ctrl+S, Ctrl+P, Ctrl+F, Ctrl+Shift+F, Ctrl++, Ctrl+=, Ctrl+−, Ctrl+0, F4, F11, Ctrl+Q, Ctrl+W, Ctrl+Shift+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Page Down, Ctrl+Page Up, Ctrl+Shift+N, Ctrl+Shift+O and Ctrl+Shift+E each do one thing, and pdf.js doesn't also act on them, also in a text field while an input method such as IBus runs. Alt+F opens the File menu.
- Editing a form puts `*` before the title, and closing the window, File > Quit, and closing the last window each ask about it, with Save as the rightmost button. Shutting down with unsaved changes shows that prompt for as long as systemd waits.
- Cancelling the Open dialog at launch quits the app.
- File > Open Recent lists opened files, and Help > About PDFLion shows the version, the icon and the credits.
- On Wayland and on X11, the viewer follows the light or dark style, Print shows every page, and a touchpad pinch zooms the pages.
- The previous release's `.deb` offers the latest about 10 seconds after it starts. Restart Now with an edited document asks about it first, then shows the password prompt, installs and starts the new version, with its sandbox on. Cancelling the prompt, which electron-updater then shows again, for `apt-get install -f`, leaves PDFLion running, and it says the update wasn't installed. Answering only the second prompt mustn't restart the old version as if it had updated. Quitting installs nothing.

On every platform, and on Linux both on Wayland and on X11:

- A tab dragged within the tab bar moves there, onto another window's tab bar joins it there, onto another window's document becomes its last tab, and outside every window opens in a window of its own, under the pointer where the platform allows. A window whose last tab leaves closes, and the document keeps its scroll position and unsaved changes. Esc cancels a drag, except on Wayland, where it tears the tab off.
- Clicking a tab, Show Next Tab and Show Previous Tab give that document the keys: the arrow keys scroll it right away.
- With one tab, an edited form shows as `name.pdf — Edited` with a dot in the close button on macOS, and `*name.pdf` on Windows and Linux. With several, the edited tab shows a dot instead of its close button until the pointer is over it. Closing a window with several edited tabs asks about each in turn, showing it, and Cancel keeps the window open.
- Presentation Mode in a window with several tabs fills the screen without the tab bar, and leaving full screen ends it.
- The tab bar follows the light or dark appearance, and high contrast where there is one.
- The toolbar's own buttons, Insert Blank Page, the page overview's and the favourites', show in light and dark mode and in high contrast.
- Insert Blank Page is disabled for a document with a password. On a document signed with a real signing tool, inserting or rotating pages asks first, and Acrobat still validates the signed revision afterwards.
- In the thumbnails and the page overview, dragging pages with a mouse, a trackpad or a touchscreen moves them, in the overview also to another row. A PDF dragged from the file manager onto the thumbnails adds its pages there, and onto the document opens as a tab. Export selected asks where to save the pages. Moved and rotated pages stay so after saving and reopening, also in Preview, Acrobat or a browser. A document with a password shows no checkboxes, Manage menu or add button, and its pages can't be dragged. A signed document asks before the first drag. Moving pages in a document with XMP metadata, such as one from Word or Pages, asks at Save, naming what goes.
- While the page overview is open, its toolbar button shows on and the sidebar's off, and in the narrowest window, 560 pixels wide, it shows one column with its header's buttons inside. Closing it leaves the document and the sidebar as they were.
- The Eraser works with a mouse, a trackpad, a touchscreen and a pen, with its circle as large as the eraser at every zoom. A fast Line drag across many strokes cuts them all where it passed, without lag, and what's left keeps its look, also in Preview or Acrobat after saving. It erases another app's drawing, such as Preview's markup, and saving removes it there too. While it's on, the Eraser shows on and Pencil off, and Pencil turns it off and draws. Edit > Undo and Redo, clicked in the menu, undo and redo erasing, and in a form field ⌘Z (Ctrl+Z) still undoes typing.
- A pen's eraser end, such as a Surface Pen's, erases with Pencil on, which then draws on, with Highlight on, and with no tool on, which turns the Eraser on, and its drag doesn't scroll the page.
- Save as Favourite shows as an outlined button, which Tab reaches, and says Saved, then Already a Favourite when clicked again.
- Favourites in pale and dark colours show in light and dark mode, with legible sizes. With twenty, the toolbar shows as many as fit, and the ★ menu the rest, scrolling in a short window, and both follow the window as it's resized. The ★ menu works with Tab, the arrow keys, Enter and Esc. A favourite picks its tool with the tool's options closed, and picking one with a drawing selected leaves the drawing as it was.
- A favourite dragged onto another, with a mouse or a trackpad, shows a line where it'll go, and moves there in every window: in the toolbar, in the ★ menu, and from the menu onto the toolbar.
- In system languages other than English and German, the toolbar fits as a window narrows a little at a time: its buttons get smaller, then favourites move into the ★ menu, Print into the ⋮ menu, the previous and next page buttons go, and last the zoom menu. Nothing comes back until the window gets wider.
- File > New gives a US Letter page with the region set to the United States or Canada, and an A4 page with Switzerland or the United Kingdom. ⌘N works on macOS with no window open. Closing an edited new document asks about saving, and Save asks where.

## License

PDFLion is licensed under the [Apache License 2.0](LICENSE).

## Credits

PDFLion is built on:

- [pdf.js](https://github.com/mozilla/pdf.js) by Mozilla (Apache-2.0)
- [Electron](https://www.electronjs.org) (MIT)
- [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) by Cantoo, which inserts pages (MIT)
- [electron-updater](https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater), which downloads and installs updates (MIT)
- [Material Symbols](https://github.com/google/material-design-icons) by Google, the viewer's icons (Apache-2.0)
- a [lion icon](https://www.svgrepo.com/svg/484717/lion) from SVG Repo, the app icon (public domain)
- [Material Design 3](https://m3.material.io) by Google, the design guidelines the viewer follows
- [Unicode CLDR](https://cldr.unicode.org) by Unicode, whose paper size data decides between US Letter and A4 for new documents (Unicode-3.0)

pdf.js includes:

- [Fluent](https://github.com/projectfluent/fluent.js) by Mozilla, which localizes the viewer (Apache-2.0)
- the viewer's translations, by [Firefox's localizers](https://github.com/mozilla-l10n/firefox-l10n) (MPL-2.0)
- [OpenJPEG](https://github.com/uclouvain/openjpeg), for JPEG 2000 images (BSD-2-Clause)
- the JBIG2 image decoder and the Foxit fonts from [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD-3-Clause)
- [qcms](https://github.com/FirefoxGraphics/qcms) by Mozilla, for colour management (MIT)
- [QuickJS](https://bellard.org/quickjs/) by Fabrice Bellard and Charlie Gordon, which runs a PDF's scripts in a sandbox (MIT)
- [Liberation Sans](https://github.com/liberationfonts/liberation-fonts) by Red Hat, for fonts a PDF uses without embedding them (GPL-2.0 with the font exception)
- [Adobe's CMaps](https://github.com/adobe-type-tools/cmap-resources), for Chinese, Japanese and Korean text (BSD-3-Clause)
- a CMYK colour profile from [Compact ICC Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles) (CC0-1.0)

@cantoo/pdf-lib includes, in the build PDFLion ships:

- [pdf-lib](https://github.com/Hopding/pdf-lib) by Andrew Dillon, of which it's a fork (MIT)
- [standard-fonts](https://github.com/Hopding/standard-fonts) by Andrew Dillon, with Adobe's metrics of the 14 standard PDF fonts (MIT)
- [fflate](https://github.com/101arrowz/fflate) by Arjun Barrett, for compression (MIT)
- [culori](https://github.com/Evercoder/culori) by Dan Burzo, for colours (MIT)
- [node-html-better-parser](https://github.com/Sharcoux/node-html-parser) and [html-entities](https://github.com/mdevils/html-entities) by Marat Dulin, for SVG (MIT)
- [tslib](https://github.com/microsoft/tslib) by Microsoft (0BSD)
- [UPNG.js and UZIP.js](https://github.com/photopea/UPNG.js) by Photopea, for PNG images (MIT)
- [base64-arraybuffer](https://github.com/niklasvh/base64-arraybuffer) by Niklas von Hertzen (MIT)
- path drawing from [PDFKit](https://github.com/foliojs/pdfkit) by Devon Govett (MIT), and stream decoding from pdf.js

electron-updater includes:

- [builder-util-runtime](https://github.com/electron-userland/electron-builder/tree/master/packages/builder-util-runtime) (MIT)
- [debug](https://github.com/debug-js/debug) by TJ Holowaychuk and Josh Junon (MIT)
- [ms](https://github.com/vercel/ms) by Vercel (MIT)
- [sax](https://github.com/isaacs/sax-js) by Isaac Z. Schlueter, which reads the release feed (BlueOak-1.0.0)
- [fs-extra](https://github.com/jprichardson/node-fs-extra) and [jsonfile](https://github.com/jprichardson/node-jsonfile) by JP Richardson (MIT)
- [graceful-fs](https://github.com/isaacs/node-graceful-fs) by Isaac Z. Schlueter and Ben Noordhuis (ISC)
- [universalify](https://github.com/RyanZim/universalify) by Ryan Zimmerman (MIT)
- [js-yaml](https://github.com/nodeca/js-yaml) by Vitaly Puzrin, which reads the update files (MIT)
- [argparse](https://github.com/nodeca/argparse), a port of Python's (Python-2.0)
- [lazy-val](https://github.com/develar/lazy-val) by Vladimir Krivosheev (MIT)
- [lodash.escaperegexp and lodash.isequal](https://lodash.com) by the JS Foundation (MIT)
- [semver](https://github.com/npm/node-semver) by Isaac Z. Schlueter, which compares versions (ISC)
- [tiny-typed-emitter](https://github.com/binier/tiny-typed-emitter) by Zurab Benashvili (MIT)

Electron includes:

- [Chromium](https://www.chromium.org) (BSD-3-Clause), and the third-party code listed in its `LICENSES.chromium.html`
- [Node.js](https://nodejs.org) (MIT)
- [Squirrel.Mac](https://github.com/Squirrel/Squirrel.Mac) by GitHub, which installs updates on macOS, with [Mantle](https://github.com/Mantle/Mantle) and [ReactiveObjC](https://github.com/ReactiveCocoa/ReactiveObjC) (MIT)

PDFLion is built and tested with:

- [electron-builder](https://www.electron.build) (MIT)
- [NSIS](https://nsis.sourceforge.io), which electron-builder uses for the Windows installer (Zlib)
- [fpm](https://github.com/jordansissel/fpm) by Jordan Sissel, which electron-builder uses for the Linux package (MIT)
- [Playwright](https://playwright.dev) by Microsoft (Apache-2.0)
- [actions/checkout, setup-node, cache, upload-artifact and download-artifact](https://github.com/actions) by GitHub, which run the tests and builds on GitHub Actions (MIT)
- [GitHub CLI](https://cli.github.com) by GitHub, with which CI publishes the releases (MIT)
- [Xvfb](https://gitlab.freedesktop.org/xorg/xserver) by X.Org, the virtual display the Linux tests run on there (MIT)

The license texts ship with the app: pdf.js's and its components' in `pdfjs/`, Electron's in `LICENSE.electron.txt`, and Chromium's in `LICENSES.chromium.html`. The About panel lists the same projects, with the versions of pdf.js, Electron, Chromium and Node.js.
