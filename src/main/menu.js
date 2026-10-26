/**
 * The application menu. For now this is Electron's default menu plus
 * File > Open…, until the full native menu replaces it.
 */
import { Menu } from "electron";
import { showOpenPanel } from "./windows.js";

export function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          { label: "Open…", accelerator: "Cmd+O", click: () => showOpenPanel() },
          { type: "separator" },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}
