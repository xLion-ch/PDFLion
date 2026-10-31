/**
 * The alerts and prompts about changing a document's pages, which bridge.js
 * asks for through `pdflion:page-dialog`. The page names a reason and, for a
 * save that rewrites the document, what it would drop, each from a fixed
 * list in src/shared/wording.js, which ipc.js checks with isPageDialog(), so a
 * PDF can't choose what a dialog says.
 */
import { dialog } from "electron";
import { CANCEL, OK, pageDialog } from "../shared/wording.js";
import * as tabs from "./tabs.js";

const isLinux = process.platform === "linux";

/**
 * Shows a page dialog on a tab's window.
 *
 * @param {tabs.Tab} tab
 * @param {string} reason checked with isPageDialog()
 * @param {string[]} [items]
 * @returns {Promise<boolean>} for a prompt, whether the user went ahead; for
 *   an alert, false
 */
export async function showPageDialog(tab, reason, items = []) {
  const win = tabs.windowOf(tab);
  if (!win) return false;
  const { message, detail, confirm, cancelByDefault } = pageDialog(
    reason,
    tabs.documentName(tab),
    items,
  );
  // macOS and Windows show the first button as the main one. GNOME puts it
  // last, rightmost.
  const buttons = !confirm ? [OK] : isLinux ? [CANCEL, confirm] : [confirm, CANCEL];
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    message,
    detail,
    buttons,
    defaultId: buttons.indexOf(cancelByDefault ? CANCEL : (confirm ?? OK)),
    cancelId: confirm ? buttons.indexOf(CANCEL) : 0,
    noLink: true,
  });
  return confirm !== undefined && buttons[response] === confirm;
}
