> [!NOTE]
> This project contains AI-generated code.

![PDFLion Logo](resources/icon.svg)

# PDFLion

A PDF viewer for macOS, Windows and Linux. It's Mozilla's [pdf.js](https://github.com/mozilla/pdf.js), the viewer built into Firefox, in a desktop app: PDFs open from Finder, Explorer and Linux file managers, as tabs, with native menus and shortcuts, and forms and annotations save back into the file.

- Opens PDFs from Finder, Explorer, Files and Nemo, the Open dialog, or by dropping them on a window, as tabs of the front window.
- Tabs can be dragged into another order, onto another window, or out of every window into a window of their own. The tab bar shows once a window has two tabs.
- Edit > Insert Blank Page, or its toolbar button, adds an empty page after the current one, the size of the current page. It's saved as an addition to the end of the file, so everything else in the file stays as it was. Documents with a password can't have pages added, and signed documents ask first.
- In the sidebar's page thumbnails, pages can be dragged into another order, and the Manage menu copies, cuts, deletes and exports the checked ones. The add button there, or dropping PDFs or images on the thumbnails, adds their pages. These changes are saved as a new file, which leaves out some of what the old one held, such as XMP metadata, layers and document scripts, and signatures no longer validate. PDFLion asks before the first such save of a document that holds any of it. Documents with a password show their pages there but can't change them, and signed documents ask before their first change.
- View > Page Overview, or the button next to the sidebar's, shows the pages as a grid across the window, with the same page tools as the thumbnails, plus Insert Blank Page after the checked pages, and Rotate Pages Left and Right, which turn the checked pages, or the current one. Rotations are saved like an inserted page, as an addition to the end of the file. View > Rotate Left and Right turn only the view, which isn't saved. Esc or a double-click on a page closes it, and the sidebar is back as it was. The sidebar's button, which shows off while the overview is open, closes it and shows the sidebar.
- The Eraser, after Pencil in the toolbar or as Edit > Eraser, erases drawings, also those another app's pen left in the file. In Line mode it erases the parts of lines under it, and in Object mode a drawing it touches goes whole: everything drawn with Pencil in one go, until Esc or another tool. Its size can be set in its options, and Edit > Undo brings back what a drag erased.
- Save as Favourite, at the end of the options of Highlight, Text and Pencil, keeps the tool's settings, such as a blue pencil 1 point wide. Favourites show in the toolbar of every window, before the drawing tools, each as its tool's icon in its colour, with its size. A click picks that tool with those settings, without opening its options, a drag onto another favourite moves it there, and a right-click removes it. Those that don't fit are in the ★ menu at their end.
- File > New opens an untitled document with one blank page, US Letter or A4, whichever your region uses. The first save asks where to put it.
- Saves form data and annotations into the file in place, or to a new file with Save As. Unsaved changes show in the title, or on the tab when a window has several, and PDFLion asks about them before closing or quitting.
- Shows the first page of a large PDF before the rest has loaded.
- Zoom, rotation, search, sidebar, Presentation Mode and printing, all from the menu and the platform's usual shortcuts.
- Follows the system's light or dark appearance. The viewer also follows the system language; the menus are in English.
- Remembers where you left the last window, and lists recently opened files.

PDFLion makes no network requests of its own. Links in a document open in your browser or mail app, and only `http`, `https` and `mailto` links open at all.

## Installing

PDFLion runs on macOS 13 Ventura or later, on Apple silicon and Intel Macs, on 64-bit Windows 10 and 11, and on 64-bit Ubuntu 22.04 and Linux Mint 21 or later. Pick the build for your computer:

| Build | For |
|---|---|
| `PDFLion-<version>-mac-arm64.dmg` (or `.zip`) | Macs with Apple silicon (M1 and later) |
| `PDFLion-<version>-mac-x64.dmg` (or `.zip`) | Intel Macs |
| `PDFLion-<version>-win-x64.exe` | Windows; Windows on Arm runs it emulated |
| `PDFLion-<version>-linux-amd64.deb` | Ubuntu and Linux Mint on Intel and AMD processors |

PDFLion isn't signed with an Apple or Microsoft certificate, so macOS and Windows warn the first time.

**macOS:** open the DMG and drag PDFLion to Applications. The first launch is blocked with a message that Apple couldn't check the app. Open System Settings > Privacy & Security, scroll down to the message about PDFLion and click Open Anyway. To open PDFs with PDFLion by default, select a PDF in Finder, choose File > Get Info, pick PDFLion under Open With, and click Change All.

**Windows:** run the installer. SmartScreen shows "Windows protected your PC"; click More info, then Run anyway. PDFLion installs for your user only, without administrator rights. It appears under Open with for PDFs; to make it the default, use Settings > Apps > Default apps. Uninstall it from Settings > Apps.

**Linux:** in a terminal, in the folder with the package, run `sudo apt install ./PDFLion-<version>-linux-amd64.deb`. PDFLion appears among your apps, and under Open With for PDFs in Files and Nemo. To make it the default, right-click a PDF, choose Open With, and set PDFLion as the default there. Uninstall it with `sudo apt remove pdflion`.

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
npm start                      # runs PDFLion from the source
npm start -- path/to/file.pdf  # and opens a file
```

The first `npm start` also builds pdf.js, which takes a while.

To build the installers, run:

```sh
npm run build
```

It runs all the tests, then builds every version the machine can build into `dist/`:

- **On a Mac:** both Mac builds. With Rosetta installed (`softwareupdate --install-rosetta`), the Windows installer as well. electron-builder's tool for Windows installers is an Intel program.
- **On Windows:** the Windows installer.
- **On Linux:** the `.deb` package. Packaging it needs `ar`, which `sudo apt install binutils` installs.

## Development

```sh
npm test               # unit tests
npm run test:e2e       # end-to-end tests: they open windows and take focus while they run
npm run pdfjs:check    # is there a newer pdf.js release?
npm run pdfjs:update   # switch to it and rebuild pdf.js
```

GitHub Actions runs the unit and end-to-end tests on macOS, Windows and Linux for every pull request into `main`, and for every push to `main` that changes more than Markdown files (`.github/workflows/ci.yml`). When a test fails, the run keeps Playwright's report for 14 days.

PDFLion keeps the Electron side thin. pdf.js is a Git submodule in `vendor/pdf.js`, pinned to a release and never edited. The app adds to it from outside:

- `src/viewer/bridge.js` connects the menus to pdf.js.
- `src/viewer/overrides.css` restyles its interface in Material Design 3.
- `src/viewer/geometry.js` works out what the eraser erases.

The main process code is in `src/main/`, one module per concern. [CLAUDE.md](CLAUDE.md) describes the architecture, the ground rules, the security model and the decisions behind them.

## Releasing

CI only runs the tests, and there's no auto-update. A release is built by hand:

1. Check for a newer pdf.js with `npm run pdfjs:check`, and update as [CLAUDE.md](CLAUDE.md) describes.
2. Raise `version` in `package.json`.
3. Run `npm run build` on a Mac, on a Windows PC and on a Linux PC. Between them, they build both Mac versions, the Windows installer and the Linux package.
4. Go through the checks below, which the automated tests can't do. The Windows and Linux checks haven't been done for any release yet.
5. Publish the `.dmg`, `.zip`, `.exe` and `.deb` files from `dist/`.

### Checks by hand

On a Mac with Apple silicon:

- The DMG installs on a Mac that has never run PDFLion, and the app starts once allowed under Privacy & Security.
- PDFLion is listed in Finder's Open With for PDFs. Once it's the default, double-clicking a PDF opens it.
- The shortcuts work from the keyboard, and pdf.js doesn't also act on them: ⌘S saves without a download, ⇧⌘F starts Presentation Mode rather than Find, ⇧⌘N inserts one page, ⌥⌘6 opens and closes the page overview, and ⇧⌘E turns the eraser on and off, also with the overview open or Pencil on. ⌥⌘6 works with the keyboard layout set to Swiss German and to French as well.
- The title bar's proxy icon works and follows the selected tab, and opened files appear in the Dock menu's recent documents.
- With "Prefer tabs when opening documents" set to Always in System Settings > Desktop & Dock, windows still don't become macOS's own tabs.
- The viewer switches when the appearance changes in System Settings.
- Print shows the native dialog, with every page.
- A trackpad pinch zooms the pages, not the whole window.

On an Intel Mac, or under Rosetta, which shows only that it starts:

- The x64 build starts.

On a Windows PC:

- `npm run build` passes in PowerShell, including the two end-to-end tests for Windows and Linux.
- The installer runs without administrator rights after SmartScreen's More info > Run anyway, and the app starts.
- PDFLion is listed under Open with for PDFs. Once it's the default, double-clicking a PDF opens it. Uninstalling removes the app and its file association.
- Ctrl+O, Ctrl+S, Ctrl+P, Ctrl+F, Ctrl+Shift+F, Ctrl++, Ctrl+=, Ctrl+−, Ctrl+0, F4, F11, Ctrl+W, Ctrl+Shift+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Page Down, Ctrl+Page Up, Ctrl+Shift+N, Ctrl+Shift+O and Ctrl+Shift+E each do one thing, and pdf.js doesn't also act on them. AltGr characters can still be typed into form fields, and Alt+F opens the File menu.
- Editing a form puts `*` before the title. Closing the window, Exit, and closing the last window each ask about the changes.
- A PDF opened from Explorer while PDFLion runs opens as a tab of the running app's front window, in front of other windows. A file that's already open gets its tab selected.
- Cancelling the Open dialog at launch quits the app, and so does a launch with a file that can't be read.
- Dropping a PDF from Explorer onto a window opens it as a tab of that window.
- Saving a file another app has open, and saving to a network share, either works or shows an error and keeps the changes. If antivirus scanning makes saving fail with `EPERM` or `EBUSY`, saving needs a short retry, as graceful-fs does.
- A large PDF on a network share shows its first page before the rest has loaded.
- Shutting down or signing out with unsaved changes is held off while PDFLion asks about them.
- The taskbar button groups with the pinned or Start menu shortcut, and the jump list shows recent files.
- The viewer switches with Settings > Personalization > Colors, and a touchpad or touchscreen pinch zooms the pages.

On Ubuntu 24.04 in its default Wayland session, and on Linux Mint 22 Cinnamon, which uses X11:

- `npm run build` passes, including the two end-to-end tests for Windows and Linux.
- `sudo apt install ./dist/PDFLion-<version>-linux-amd64.deb` installs it, and PDFLion starts from the app menu with Chromium's sandbox on. Chromium won't start without its sandbox unless it's given `--no-sandbox`, and with the sandbox, `grep Seccomp /proc/$(pgrep -f -- --type=renderer | head -1)/status` shows `Seccomp: 2`.
- The app menu and the dock show PDFLion's icon, and the dock groups its windows with the launcher.
- PDFLion is listed under Open With for PDFs in Files (Ubuntu) and Nemo (Mint), and PDFs keep their own icon. Once PDFLion is the default, double-clicking a PDF opens it. `sudo apt remove pdflion` removes the app and its Open With entry.
- A PDF opened from the file manager while PDFLion runs opens as a tab of the running app's front window. A file that's already open gets its tab selected.
- Ctrl+O, Ctrl+S, Ctrl+P, Ctrl+F, Ctrl+Shift+F, Ctrl++, Ctrl+=, Ctrl+−, Ctrl+0, F4, F11, Ctrl+Q, Ctrl+W, Ctrl+Shift+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Page Down, Ctrl+Page Up, Ctrl+Shift+N, Ctrl+Shift+O and Ctrl+Shift+E each do one thing, and pdf.js doesn't also act on them, also with a text field focused while an input method such as IBus runs. Alt+F opens the File menu.
- Editing a form puts `*` before the title. Closing the window, File > Quit, and closing the last window each ask about the changes, with Save as the rightmost button.
- Shutting down with unsaved changes shows the save prompt for as long as systemd waits.
- Cancelling the Open dialog at launch quits the app.
- File > Open Recent lists opened files, and Help > About PDFLion shows the version, the icon and the credits.
- The viewer follows the system's light or dark style, Print shows the print dialog with every page, and a touchpad pinch zooms the pages, on Wayland and on X11.

On every platform, and on Linux both on Wayland and on X11:

- Dragging a tab within the tab bar moves it there. Dragged onto another window's tab bar it joins that window where it's dropped, and onto another window's document it becomes that window's last tab. Dropped outside every window, it opens in a window of its own, under the pointer where the platform allows (not on Wayland). A window whose last tab leaves closes. The document keeps its scroll position and unsaved changes throughout.
- A drag cancelled with Esc leaves the tab where it was. On Wayland it tears the tab off instead (see Known limitations in [CLAUDE.md](CLAUDE.md)).
- Clicking a tab, Show Next Tab and Show Previous Tab send the keys to that tab's document: the arrow keys scroll it right away.
- With one tab, editing a form shows in the title: `name.pdf — Edited` and the close button's dot on macOS, `*name.pdf` on Windows and Linux. With several, the edited tab shows a dot in place of its close button until the pointer is over it, and the title names the document alone. On macOS the close button's dot shows while any tab has changes.
- Closing a window with several edited tabs asks about each in turn, showing each first, and Cancel keeps the window open.
- Presentation Mode in a window with several tabs fills the screen, without the tab bar, and leaving full screen ends it.
- The tab bar follows the system's light or dark appearance, and the system's high contrast mode where there is one.
- Insert Blank Page's toolbar button shows its icon in light and dark mode and in high contrast, and is disabled for a document with a password. On a document signed with a real signing tool, it asks first, and afterwards the signature still validates for the signed revision in Acrobat, which reports the change after signing.
- In the sidebar's thumbnails, dragging a page with the mouse, a trackpad or a touchscreen moves it. A PDF dragged from the file manager onto the thumbnails adds its pages where it's dropped, and onto the document it opens as a tab. Export selected asks where to save the checked pages. Pages moved and saved stay in their new order after reopening. A document with a password shows its thumbnails without checkboxes, Manage menu or add button, and its pages can't be dragged. On a document signed with a real signing tool, the first drag asks first. Moving pages in a document from a word processor that writes XMP metadata, such as Word or Pages, and saving asks first, naming what goes.
- The page overview's buttons, in the toolbar and in its header, show their icons in light and dark mode and in high contrast. While the overview is open, its toolbar button shows on, and the sidebar's next to it shows off. The overview fills the window, with as many columns as fit, and dragging a page with the mouse, a trackpad or a touchscreen moves it there, also to another row. In the narrowest window, 560 pixels wide, the overview shows one column, and its header's buttons stay inside it. Closing it leaves the document where it was, and the sidebar as it was.
- Pages rotated in the page overview stay turned after saving and reopening, in PDFLion and in another viewer such as Preview, Acrobat or a browser. On a document signed with a real signing tool, rotating asks first, and afterwards the signature still validates for the signed revision in Acrobat, which reports the change after signing.
- The Eraser erases with the mouse, a trackpad, a touchscreen and a pen where there is one, and its circle is as large as the eraser at every zoom. In Line mode, a fast drag across many strokes cuts them all where it passed, without lag, and what's left keeps its colour, thickness and opacity, also in Preview or Acrobat after saving. It erases a drawing from another app, such as Preview's markup, and saving removes it there too. While it's on, the toolbar shows the Eraser on and Pencil off, Pencil turns it off and draws, and the toolbar still fits in the narrowest window. Edit > Undo and Redo, clicked in the menu, undo and redo erasing. With the cursor in a form field, ⌘Z (Ctrl+Z) still undoes typing, and so does Edit > Undo.
- Save as Favourite, in the options of Highlight, Text and Pencil, shows as an outlined button across the box in light and dark mode and in high contrast, and Tab reaches it. Clicked, it says Saved, and Already a Favourite when clicked again.
- Favourites in pale and dark colours, such as yellow and black, show in the toolbar in light and dark mode, and in high contrast like the other icons, with their sizes legible. With twenty favourites, the toolbar shows as many as fit and the ★ menu lists the rest, scrolling in a short window, and both follow the window as it's resized. The ★ menu works with the keyboard: Tab to its button, then the arrow keys, Enter and Esc. Picking a favourite while a drawing is selected leaves that drawing as it was, and the next one gets the favourite's settings.
- Dragging a favourite onto another, with a mouse or a trackpad, shows a line where it'll go, before or after the other by the half it's over, and moves it there in every window. That works in the toolbar, in the ★ menu, and from the menu onto the toolbar. A favourite picks its tool without opening the tool's options, and the tool's button shows the tool on.
- In system languages other than English and German, which the automated tests cover, the toolbar still fits as a window narrows a little at a time: first its buttons get smaller, then favourites move into the ★ menu, then Print moves into the ⋮ menu, then the previous and next page buttons go, and last the zoom menu. Nothing comes back until the window gets wider again. A window gets no narrower than 560 pixels.
- File > New gives a US Letter page with the system's region set to the United States or Canada, and an A4 page with it set to Switzerland or the United Kingdom. ⌘N works on macOS with no window open. Editing the new document's page, for example with a drawing, and closing it asks about saving, and Save there asks where to save it.

## License

PDFLion is licensed under the [Apache License 2.0](LICENSE).

## Credits

PDFLion is built on:

- [pdf.js](https://github.com/mozilla/pdf.js) by Mozilla (Apache-2.0)
- [Electron](https://www.electronjs.org) (MIT)
- [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) by Cantoo, which inserts pages (MIT)
- [Material Symbols](https://github.com/google/material-design-icons) by Google, the viewer's icons (Apache-2.0)
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

Electron includes:

- [Chromium](https://www.chromium.org) (BSD-3-Clause), and the third-party code listed in its `LICENSES.chromium.html`
- [Node.js](https://nodejs.org) (MIT)

PDFLion is built and tested with:

- [electron-builder](https://www.electron.build) (MIT)
- [NSIS](https://nsis.sourceforge.io), which electron-builder uses for the Windows installer (Zlib)
- [fpm](https://github.com/jordansissel/fpm) by Jordan Sissel, which electron-builder uses for the Linux package (MIT)
- [Playwright](https://playwright.dev) by Microsoft (Apache-2.0)
- [actions/checkout, setup-node, cache, upload-artifact and download-artifact](https://github.com/actions) by GitHub, which run the tests on GitHub Actions (MIT)
- [Xvfb](https://gitlab.freedesktop.org/xorg/xserver) by X.Org, the virtual display the Linux tests run on there (MIT)

The license texts ship with the app: pdf.js's and its components' in `pdfjs/`, Electron's in `LICENSE.electron.txt`, and Chromium's in `LICENSES.chromium.html`. The About panel lists the same projects, with the versions of pdf.js, Electron, Chromium and Node.js.
