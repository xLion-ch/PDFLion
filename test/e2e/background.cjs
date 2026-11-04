/**
 * Runs the app under test without disturbing whoever uses the computer
 * meanwhile. launch() in pdflion.js loads it into the main process with
 * Electron's `-r`, as Playwright loads its own hook, unless CI or
 * PDFLION_E2E_FOREGROUND is set.
 *
 * The app never becomes the active app, nor shows in the Dock, and its windows
 * show without activating, invisible and letting clicks through. Instead they
 * keep a focus of their own, which BrowserWindow's focus(), blur(),
 * isFocused(), getFocusedWindow() and its focus and blur events follow, as the
 * system's would. Playwright's input goes through the DevTools protocol, which
 * needs no focus, and its switches keep Chromium drawing windows it can't see.
 *
 * CommonJS, since `-r` loads it before the app's modules.
 */
{
  const { app, BrowserWindow } = require("electron");

  // Otherwise main.js would take this file for a document to open.
  const index = process.argv.indexOf(__filename);
  if (index > 0) process.argv.splice(index - 1, 2);

  // Unlike "accessory", which macOS still activates as a window shows.
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  app.focus = () => {};

  /**
   * The shown windows, the most recently focused first. Not isVisible(), which
   * on macOS is false for a window that others cover, as an invisible one.
   *
   * @type {BrowserWindow[]}
   */
  let shown = [];
  /** @type {BrowserWindow | null} */
  let focused = null;

  /** @param {BrowserWindow | null} win */
  function focus(win) {
    if (win === focused) return;
    const previous = focused;
    focused = win;
    if (win) shown = [win, ...shown.filter((other) => other !== win)];
    if (previous && !previous.isDestroyed()) previous.emit("blur", {});
    if (win) win.emit("focus", {});
  }

  /** @param {BrowserWindow} win */
  function forget(win) {
    shown = shown.filter((other) => other !== win);
    if (focused === win) {
      focused = null;
      focus(shown[0] ?? null);
    }
  }

  const proto = BrowserWindow.prototype;
  const { showInactive, hide, minimize } = proto;
  proto.show = function () {
    showInactive.call(this);
    focus(this);
  };
  proto.showInactive = function () {
    showInactive.call(this);
    if (!shown.includes(this)) shown.push(this);
  };
  proto.focus = function () {
    if (shown.includes(this)) focus(this);
  };
  proto.blur = function () {
    if (focused === this) focus(shown.find((win) => win !== this) ?? null);
  };
  // Not on the hide event, which macOS sends when it finds a window covered.
  proto.hide = function () {
    forget(this);
    hide.call(this);
  };
  proto.minimize = function () {
    this.blur();
    minimize.call(this);
  };
  proto.isFocused = function () {
    return focused === this;
  };
  BrowserWindow.getFocusedWindow = () => focused;

  app.on("browser-window-created", (_event, win) => {
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.on("closed", () => forget(win));
  });
}
