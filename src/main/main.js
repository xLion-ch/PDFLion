/**
 * App lifecycle. Mac convention: one window per document, and the app keeps
 * running after its last window closes until the user quits with Cmd+Q.
 */
import { app, BrowserWindow } from "electron";

/** @returns {BrowserWindow} */
function createWindow() {
  return new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
}

// Without a listener, Electron quits when the last window closes.
app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  createWindow();

  // Clicking the Dock icon with no windows open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
