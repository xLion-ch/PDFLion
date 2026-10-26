/**
 * App lifecycle. Mac convention: one window per document, and the app keeps
 * running after its last window closes until the user quits with Cmd+Q.
 */
import { app, BrowserWindow } from "electron";
import { handleProtocol, registerScheme, VIEWER_URL } from "./protocol.js";

registerScheme();

/** @returns {BrowserWindow} */
function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // An empty file= opens no document.
  win.loadURL(`${VIEWER_URL}?file=`);
  return win;
}

// Without a listener, Electron quits when the last window closes.
app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  handleProtocol();
  createWindow();

  // Clicking the Dock icon with no windows open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
