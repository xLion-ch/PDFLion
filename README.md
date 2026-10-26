# PDFLion

A PDF viewer for macOS and Windows. It's Mozilla's [pdf.js](https://github.com/mozilla/pdf.js), the viewer built into Firefox, in a desktop app: PDFs open from Finder and Explorer, each in its own window, with native menus and shortcuts, and forms and annotations save back into the file.

- Opens PDFs from Finder, Explorer, the Open dialog, or by dropping them on a window. On macOS, windows can be merged into tabs.
- Saves form data and annotations into the file in place, or to a new file with Save As. It asks before closing or quitting with unsaved changes.
- Shows the first page of a large PDF before the rest has loaded.
- Zoom, rotation, search, sidebar, Presentation Mode and printing, all from the menu and the platform's usual shortcuts.
- Follows the system's light or dark appearance. The viewer also follows the system language; the menus are in English.
- Remembers where you left the last window, and lists recently opened files.

PDFLion makes no network requests of its own. Links in a document open in your browser or mail app, and only `http`, `https` and `mailto` links open at all.

## Installing

PDFLion runs on macOS 13 Ventura or later, on Apple silicon and Intel Macs, and on 64-bit Windows 10 and 11. Pick the build for your computer:

| Build | For |
|---|---|
| `PDFLion-<version>-mac-arm64.dmg` (or `.zip`) | Macs with Apple silicon (M1 and later) |
| `PDFLion-<version>-mac-x64.dmg` (or `.zip`) | Intel Macs |
| `PDFLion-<version>-win-x64.exe` | Windows; Windows on Arm runs it emulated |

PDFLion isn't signed with an Apple or Microsoft certificate, so each system warns the first time.

**macOS:** open the DMG and drag PDFLion to Applications. The first launch is blocked with a message that Apple couldn't check the app. Open System Settings > Privacy & Security, scroll down to the message about PDFLion and click Open Anyway. To open PDFs with PDFLion by default, select a PDF in Finder, choose File > Get Info, pick PDFLion under Open With, and click Change All.

**Windows:** run the installer. SmartScreen shows "Windows protected your PC"; click More info, then Run anyway. PDFLion installs for your user only, without administrator rights. It appears under Open with for PDFs; to make it the default, use Settings > Apps > Default apps. Uninstall it from Settings > Apps.

## Shortcuts

| | macOS | Windows |
|---|---|---|
| Open… | ⌘O | Ctrl+O |
| Save / Save As… | ⌘S / ⇧⌘S | Ctrl+S / Ctrl+Shift+S |
| Print… | ⌘P | Ctrl+P |
| Close | ⌘W | Ctrl+W |
| Find… | ⌘F | Ctrl+F |
| Toggle Sidebar | ⌥⌘S | F4 |
| Zoom In / Zoom Out | ⌘+ / ⌘− | Ctrl++ / Ctrl+− |
| Actual Size | ⌘0 | Ctrl+0 |
| Rotate Left / Right | ⌘L / ⌘R | Ctrl+L / Ctrl+R |
| Presentation Mode | ⇧⌘F | Ctrl+Shift+F |
| Full Screen | ⌃⌘F | F11 |

## Building from source

You need [Node.js](https://nodejs.org) 24 (see `.nvmrc`), Git, and a Mac or a Windows PC.

```sh
git clone --recurse-submodules https://github.com/c14ud3/PDFLion.git
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

## Development

```sh
npm test               # unit tests
npm run test:e2e       # end-to-end tests: they open windows and take focus while they run
npm run pdfjs:check    # is there a newer pdf.js release?
npm run pdfjs:update   # switch to it and rebuild pdf.js
```

PDFLion keeps the Electron side thin. pdf.js is a Git submodule in `vendor/pdf.js`, pinned to a release and never edited. The app adds to it from outside:

- `src/viewer/bridge.js` connects the menus to pdf.js.
- `src/viewer/overrides.css` adjusts its interface.

The main process code is in `src/main/`, one module per concern. [CLAUDE.md](CLAUDE.md) describes the architecture, the ground rules, the security model and the decisions behind them.

## Releasing

There's no CI and no auto-update. A release is built by hand:

1. Check for a newer pdf.js with `npm run pdfjs:check`, and update as [CLAUDE.md](CLAUDE.md) describes.
2. Raise `version` in `package.json`.
3. Run `npm run build` on a Mac and on a Windows PC. Between them, they build both Mac versions and the Windows installer.
4. Go through the checks below, which the automated tests can't do. The Windows checks haven't been done for any release yet.
5. Publish the `.dmg`, `.zip` and `.exe` files from `dist/`.

### Checks by hand

On a Mac with Apple silicon:

- The DMG installs on a Mac that has never run PDFLion, and the app starts once allowed under Privacy & Security.
- PDFLion is listed in Finder's Open With for PDFs. Once it's the default, double-clicking a PDF opens it.
- The shortcuts work from the keyboard, and pdf.js doesn't also act on them: ⌘S saves without a download, and ⇧⌘F starts Presentation Mode rather than Find.
- The title bar's proxy icon works, and opened files appear in the Dock menu's recent documents.
- Window > Merge All Windows gathers the windows into tabs, and the tab bar's + button opens a file as a new tab.
- The viewer switches when the appearance changes in System Settings.
- Print shows the native dialog, with every page.
- A trackpad pinch zooms the pages, not the whole window.

On an Intel Mac, or under Rosetta, which shows only that it starts:

- The x64 build starts.

On a Windows PC:

- `npm run build` passes in PowerShell, including the two Windows-only end-to-end tests.
- The installer runs without administrator rights after SmartScreen's More info > Run anyway, and the app starts.
- PDFLion is listed under Open with for PDFs. Once it's the default, double-clicking a PDF opens it. Uninstalling removes the app and its file association.
- Ctrl+O, Ctrl+S, Ctrl+P, Ctrl+F, Ctrl+Shift+F, Ctrl++, Ctrl+=, Ctrl+−, Ctrl+0, F4 and F11 each do one thing, and pdf.js doesn't also act on them. AltGr characters can still be typed into form fields, and Alt+F opens the File menu.
- Editing a form puts `*` before the title. Closing the window, Exit, and closing the last window each ask about the changes.
- A PDF opened from Explorer while PDFLion runs opens in the running app, in front of other windows. A file that's already open gets its window focused.
- Cancelling the Open dialog at launch quits the app, and so does a launch with a file that can't be read.
- Dropping a PDF from Explorer onto a window opens it in a new window.
- Saving a file another app has open, and saving to a network share, either works or shows an error and keeps the changes. If antivirus scanning makes saving fail with `EPERM` or `EBUSY`, saving needs a short retry, as graceful-fs does.
- A large PDF on a network share shows its first page before the rest has loaded.
- Shutting down or signing out with unsaved changes is held off while PDFLion asks about them.
- The taskbar button groups with the pinned or Start menu shortcut, and the jump list shows recent files.
- The viewer switches with Settings > Personalization > Colors, and a touchpad or touchscreen pinch zooms the pages.

## License

PDFLion is licensed under the [Apache License 2.0](LICENSE).

## Credits

PDFLion is built on [pdf.js](https://github.com/mozilla/pdf.js) by Mozilla, under the Apache License 2.0, and on [Electron](https://www.electronjs.org), under the MIT License. The pdf.js build includes fonts, colour profiles and image decoders under their own licenses, which ship with the app in `pdfjs/`.
