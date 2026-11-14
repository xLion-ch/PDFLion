/**
 * The context menu of a document's pages: Cut, Copy, Paste and Delete, for
 * the drawings, text boxes and images pdf.js has selected, the text selected,
 * and what the clipboard holds, and Add Image from File…. bridge.js asks for
 * it on a right click or a long press on a page, and pastes or adds an image
 * at that place.
 *
 * Cut, Copy and Paste run here, as the Edit menu's roles do: the page gets
 * the clipboard events with the clipboard's data, without the permission to
 * read the clipboard, which permissions.js denies. Main reads only which
 * types of data the clipboard holds, to enable Paste, never the data.
 *
 * The channel name is repeated in src/preload/preload.cjs, which can't import
 * this module.
 */
import { clipboard, ipcMain, Menu } from "electron";
import { fromViewer } from "./ipc.js";
import * as tabs from "./tabs.js";
import { t } from "../shared/i18n.js";

/**
 * @typedef {object} PageMenuOptions what the page has to offer
 * @property {boolean} editors whether pdf.js has drawings, text boxes or
 *   images selected, which Cut, Copy and Delete take
 * @property {boolean} text whether text is selected, which Copy takes
 * @property {boolean} editable whether pdf.js lets the document have new
 *   annotations, which Paste and Add Image from File… add
 */

/** Must run once the app is ready, before any window loads. */
export function handlePageMenu() {
  ipcMain.handle("pdflion:page-menu", (event, value) => {
    const tab = tabs.fromWebContents(event.sender);
    const options = parsePageMenuOptions(value);
    const win = tab && tabs.windowOf(tab);
    if (!tab || !win || !fromViewer(event) || !options) return null;
    return showPageMenu(tab.webContents, win, options);
  });
}

/**
 * @param {unknown} value
 * @returns {PageMenuOptions | null} the options, rebuilt from known fields,
 *   or null if they aren't the page menu's
 */
export function parsePageMenuOptions(value) {
  if (typeof value !== "object" || value === null) return null;
  const { editors, text, editable } = /** @type {Record<string, unknown>} */ (value);
  if (typeof editors !== "boolean" || typeof text !== "boolean" || typeof editable !== "boolean") {
    return null;
  }
  return { editors, text, editable };
}

/**
 * @param {string[]} types the clipboard items' types, as `clipboard.read()`
 *   lists them: MIME types, and each platform's own formats, such as
 *   `electron application/osclipboard;format="org.chromium.web-custom-data"`
 * @returns {boolean} whether there's something to paste on a page: an image,
 *   or what pdf.js copied, which Chromium keeps as its web custom data, by a
 *   name of each platform's ("Chromium Web Custom MIME Data Format" on
 *   Windows, `chromium/x-web-custom-data` on Linux)
 */
export function canPaste(types) {
  return types.some((type) => type.startsWith("image/") || /web[-_ ]custom/i.test(type));
}

/** @returns {Promise<string[]>} the types of what the clipboard holds */
async function clipboardTypes() {
  try {
    return (await clipboard.read()).flatMap((item) => item.types);
  } catch (error) {
    console.warn("Couldn't read the clipboard's types:", error);
    return [];
  }
}

/**
 * @param {Electron.WebContents} webContents the tab's
 * @param {Electron.BrowserWindow} win
 * @param {PageMenuOptions} options
 * @returns {Promise<"paste" | "delete" | "add-image" | null>} Paste, which
 *   the page then expects a paste event for, Delete, which the page carries
 *   out, Add Image from File…, for which the page opens a file picker, or
 *   null for anything else, or nothing chosen
 */
async function showPageMenu(webContents, win, { editors, text, editable }) {
  const pasteable = editable && canPaste(await clipboardTypes());
  return new Promise((resolve) => {
    /** @param {(contents: Electron.WebContents) => void} run */
    const onTab = (run) => () => {
      if (!webContents.isDestroyed()) run(webContents);
    };
    Menu.buildFromTemplate([
      { label: t("menuCut"), enabled: editors, click: onTab((contents) => contents.cut()) },
      {
        label: t("menuCopy"),
        enabled: editors || text,
        click: onTab((contents) => contents.copy()),
      },
      {
        label: t("menuPaste"),
        enabled: pasteable,
        click: onTab((contents) => {
          // Before the paste event, so that the page has the place for it.
          resolve("paste");
          contents.paste();
        }),
      },
      { type: "separator" },
      {
        label: t("menuDelete"),
        enabled: editors,
        click: () => resolve("delete"),
      },
      { type: "separator" },
      {
        label: t("menuAddImage"),
        enabled: editable,
        // A click on a native menu gives the page no activation, without
        // which it can't open a file picker. Running nothing as a user
        // gesture gives it some, as runCommand() does.
        click: onTab(async (contents) => {
          await contents.executeJavaScript("void 0", true).catch(() => {});
          resolve("add-image");
        }),
      },
    ]).popup({
      window: win,
      // Called as the menu closes, which on macOS comes before the click.
      callback: () => setTimeout(() => resolve(null), 200),
    });
  });
}
