/**
 * The tool settings every tab shares, kept in state.json: the eraser's mode
 * and size and whether only a pen draws, under `toolSettings`, and the
 * favourites, under `favourites`.
 * tools.js checks them. A change from one tab reaches every tab, so that all
 * windows show the same favourites. A favourite's context menu is native.
 *
 * The channel names are repeated in src/preload/preload.cjs, which can't
 * import this module.
 */
import { ipcMain, Menu } from "electron";
import { fromViewer } from "./ipc.js";
import { getState, setState } from "./state.js";
import * as tabs from "./tabs.js";
import {
  parseFavourite,
  parseToolSettings,
  readToolSettings,
  removeFavourite,
} from "../shared/tools.js";

/** Must run once the app is ready, before any window loads. */
export function handleToolSettings() {
  ipcMain.handle("pdflion:get-tool-settings", (event) => {
    if (!tabs.fromWebContents(event.sender) || !fromViewer(event)) return null;
    return toolSettings();
  });

  ipcMain.on("pdflion:set-tool-settings", (event, settings) => {
    const changes = parseToolSettings(settings);
    if (!tabs.fromWebContents(event.sender) || !fromViewer(event) || !changes) return;
    update(changes);
  });

  ipcMain.on("pdflion:favourite-menu", (event, value) => {
    const tab = tabs.fromWebContents(event.sender);
    const favourite = parseFavourite(value);
    if (!tab || !fromViewer(event) || !favourite) return;
    const win = tabs.windowOf(tab);
    if (!win) return;
    Menu.buildFromTemplate([
      {
        label: "Remove Favourite",
        click: () => update({ favourites: removeFavourite(toolSettings().favourites, favourite) }),
      },
    ]).popup({ window: win });
  });
}

/** @returns {import("../shared/tools.js").ToolSettings} */
function toolSettings() {
  return readToolSettings(getState("toolSettings"), getState("favourites"));
}

/**
 * Stores changed tool settings, and sends every tab all of them.
 *
 * @param {Partial<import("../shared/tools.js").ToolSettings>} changes
 */
function update({ eraser, penOnly, favourites }) {
  if (eraser || penOnly !== undefined) {
    const current = toolSettings();
    setState("toolSettings", {
      eraser: eraser ?? current.eraser,
      penOnly: penOnly ?? current.penOnly,
    });
  }
  if (favourites) setState("favourites", favourites);
  const settings = toolSettings();
  for (const tab of tabs.allTabs()) {
    if (!tabs.isHome(tab) && !tab.webContents.isDestroyed()) {
      tab.webContents.send("pdflion:tool-settings-changed", settings);
    }
  }
}
