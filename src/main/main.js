/**
 * App lifecycle and the ways documents come in. Mac convention: one window per
 * document, and the app keeps running after its last window closes until the
 * user quits with Cmd+Q.
 */
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { handleIpc } from "./ipc.js";
import { installMenu } from "./menu.js";
import { handleProtocol, registerScheme } from "./protocol.js";
import { openDocument, showOpenPanel } from "./windows.js";

registerScheme();

/**
 * Files macOS asked to open before the app was ready, or null once it is.
 * @type {string[] | null}
 */
let openFileQueue = [];

// macOS sends open-file during launch, before `ready`, when the app is started
// by opening a document from Finder.
app.on("open-file", (event, file) => {
  event.preventDefault();
  if (openFileQueue) openFileQueue.push(file);
  else openDocument(file);
});

// Without a listener, Electron quits when the last window closes.
app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  handleProtocol();
  handleIpc();
  installMenu();

  const files = [...openFileQueue, ...commandLineFiles()];
  openFileQueue = null;
  // Like Preview, a launch without a document shows the Open panel.
  if (files.length === 0) showOpenPanel();
  for (const file of files) openDocument(file);

  // Clicking the Dock icon with no windows open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) showOpenPanel();
  });
});

/**
 * Files named on the command line, as in `npm start -- file.pdf`. Under
 * `electron .` the first two arguments are Electron and the app path. npm runs
 * scripts from the package root, so relative paths resolve against the
 * directory npm was started in.
 *
 * @returns {string[]}
 */
function commandLineFiles() {
  const cwd = process.env.INIT_CWD ?? process.cwd();
  return process.argv
    .slice(process.defaultApp ? 2 : 1)
    .filter((arg) => !arg.startsWith("-"))
    .map((arg) => path.resolve(cwd, arg));
}
