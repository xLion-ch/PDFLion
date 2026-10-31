/**
 * Updates, from a local feed: an HTTP server that serves electron-updater's
 * generic provider, which the dev app reads with --pdflion-update-config. The
 * installer is a few random bytes, and the install itself is stubbed, since
 * it would run them, or dpkg through pkexec. electron-updater keeps its
 * download in a cache folder of the test's own.
 *
 * On macOS, Squirrel.Mac would refuse every update to the dev app, whose
 * Electron.app is signed ad hoc with its own hash as its requirement, so a
 * stand-in replaces it (stubSquirrel()).
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ROOT, clickMenu, expect, isEdited, tempDir, test, tracemonkey } from "./pdflion.js";
import { writeForm } from "./pdfs.js";

/** @typedef {import("./pdflion.js").ElectronApplication} ElectronApplication */

const isMac = process.platform === "darwin";

/** Newer than any release. */
const NEWER = "99.0.0";

const READY = `PDFLion ${NEWER} is ready to install.`;

const CURRENT = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")).version;

/** Squirrel.Mac's error for an app on a disk image or in Downloads. */
const READ_ONLY_VOLUME =
  "Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again.";

/** The installer each platform's updater looks for. */
const INSTALLER = {
  darwin: `mac-${process.arch}.zip`,
  win32: "win-x64.exe",
  linux: "linux-amd64.deb",
}[/** @type {"darwin" | "win32" | "linux"} */ (process.platform)];

/** @type {http.Server[]} */
const servers = [];

/** electron-updater's cache folders on macOS, which it keeps in ~/Library/Caches. */
const caches = [];

test.afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(caches.splice(0).map((cache) => fs.rm(cache, { recursive: true, force: true })));
});

/**
 * Serves an update to `version`: its update file, whatever its name, and the
 * installer it names.
 *
 * @param {{ version: string, sha512?: string }} release sha512: the
 *   installer's, unless given
 * @returns {Promise<{ url: string, installer: string, requests: http.IncomingMessage[] }>}
 */
async function serveFeed({ version, sha512 }) {
  const bytes = crypto.randomBytes(4096);
  const installer = `PDFLion-${version}-${INSTALLER}`;
  sha512 ??= crypto.createHash("sha512").update(bytes).digest("base64");
  const yml = [
    `version: ${version}`,
    "files:",
    `  - url: ${installer}`,
    `    sha512: ${sha512}`,
    `    size: ${bytes.length}`,
    `path: ${installer}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-30T12:00:00.000Z'",
  ].join("\n");

  /** @type {http.IncomingMessage[]} */
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
    if (pathname.endsWith(".yml")) response.end(yml);
    else if (pathname === `/${installer}`) response.end(bytes);
    else response.writeHead(404).end(); // such as the .blockmap
  });
  servers.push(server);
  await new Promise((listening) => server.listen(0, "127.0.0.1", () => listening(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}/`, installer, requests };
}

/**
 * Launch options that point PDFLion at a feed, with automatic checks off
 * unless `automatic`, so that only the menu checks.
 *
 * @param {string} url
 * @param {{ automatic?: boolean }} [options]
 */
async function fromFeed(url, { automatic = false } = {}) {
  const dir = await tempDir();
  const config = path.join(dir, "app-update.yml");
  const cacheName = `pdflion-updater-e2e-${crypto.randomUUID()}`;
  await fs.writeFile(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: ${cacheName}\n`);
  const userData = await tempDir();
  if (!automatic) {
    await fs.writeFile(
      path.join(userData, "state.json"),
      JSON.stringify({ updates: { automatic: false } }),
    );
  }
  // electron-updater's cache, which it finds in these on Windows and Linux,
  // and in ~/Library/Caches on macOS.
  const cache = path.join(dir, "cache");
  if (isMac) caches.push(path.join(os.homedir(), "Library", "Caches", cacheName));
  return {
    userData,
    args: [`--pdflion-update-config=${config}`],
    env: { LOCALAPPDATA: cache, XDG_CACHE_HOME: cache },
  };
}

/**
 * Starts PDFLion with launch options from fromFeed(), and on macOS replaces
 * Squirrel.Mac before the first check.
 *
 * @param {(files: string[], options: object) => ReturnType<import("./pdflion.js").launch>} pdflion
 * @param {string[]} files
 * @param {Awaited<ReturnType<typeof fromFeed>>} options
 * @param {{ squirrelError?: string }} [stub] squirrelError: what Squirrel.Mac
 *   fails with
 */
async function launchFromFeed(pdflion, files, options, { squirrelError } = {}) {
  const launched = await pdflion(files, options);
  if (isMac) await stubSquirrel(launched.app, squirrelError);
  return launched;
}

/**
 * macOS: replaces Squirrel.Mac. Like Squirrel, the stand-in fetches the update
 * from the proxy electron-updater hands it, then says it has it, or fails with
 * `error`. It counts its checks on `globalThis.squirrelChecks` in main.
 *
 * @param {ElectronApplication} app
 * @param {string} [error]
 */
async function stubSquirrel(app, error) {
  await app.evaluate(({ autoUpdater }, error) => {
    globalThis.squirrelChecks = 0;
    /** @type {{ url: string, headers: Record<string, string> } | undefined} */
    let feed;
    autoUpdater.setFeedURL = (options) => void (feed = /** @type {typeof feed} */ (options));
    autoUpdater.checkForUpdates = async () => {
      globalThis.squirrelChecks++;
      if (error || !feed) {
        autoUpdater.emit("error", new Error(error ?? "No feed"));
        return;
      }
      const { url } = await (await fetch(feed.url, { headers: feed.headers })).json();
      await (await fetch(url)).arrayBuffer();
      autoUpdater.emit("update-downloaded", {}, "", "", new Date(), url);
    };
  }, error);
}

/**
 * Replaces the install with one that writes how it was asked to install to
 * `file` and quits, or on Windows and Linux fails, as a cancelled password
 * prompt does. On macOS that's Squirrel.Mac's quitAndInstall().
 *
 * @param {ElectronApplication} app
 * @param {string} file
 * @param {{ fails?: boolean }} [options]
 */
async function stubInstall(app, file, { fails = false } = {}) {
  await app.evaluate(
    ({ app, autoUpdater }, { root, file, fails }) => {
      const { createRequire } = process.getBuiltinModule("node:module");
      const fs = process.getBuiltinModule("node:fs");
      autoUpdater.quitAndInstall = () => {
        fs.writeFileSync(file, JSON.stringify({ squirrel: true }));
        app.quit();
      };
      const updater = createRequire(`${root}/package.json`)("electron-updater");
      for (const Updater of [updater.NsisUpdater, updater.DebUpdater]) {
        Updater.prototype.doInstall = function (options) {
          fs.writeFileSync(file, JSON.stringify(options));
          if (!fails) return true;
          this.dispatchError(new Error("Request dismissed"));
          return false;
        };
      }
    },
    { root: ROOT, file, fails },
  );
}

/**
 * Replaces Electron's message boxes with one that answers each that has
 * buttons with the next of `buttons`, and records every message on
 * `globalThis.messages` in main.
 *
 * @param {ElectronApplication} app
 * @param {string[]} buttons
 */
async function answer(app, buttons) {
  await app.evaluate(({ dialog }, buttons) => {
    globalThis.messages = [];
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.messages.push(options.message);
      const button = options.buttons?.length ? buttons.shift() : undefined;
      return { response: button ? options.buttons.indexOf(button) : 0, checkboxChecked: false };
    };
  }, buttons);
}

/** @param {ElectronApplication} app */
function messages(app) {
  return app.evaluate(() => globalThis.messages);
}

/**
 * @param {ElectronApplication} app
 * @param {string} role of a menu in the menu bar, such as "help"
 * @returns {Promise<{ id: string, type: string, checked: boolean, role: string }[]>}
 *   its items
 */
function menuItems(app, role) {
  return app.evaluate(({ Menu }, role) => {
    const menu = Menu.getApplicationMenu()?.items.find((item) => item.role?.toLowerCase() === role);
    return (menu?.submenu?.items ?? []).map((item) => ({
      id: item.id,
      type: item.type,
      checked: item.checked,
      role: item.role?.toLowerCase() ?? "",
    }));
  }, role);
}

/**
 * @param {ElectronApplication} app
 * @returns {Promise<boolean | undefined>} whether Check for Updates
 *   Automatically shows checked
 */
function automaticChecked(app) {
  return app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("automaticUpdates")?.checked,
  );
}

test("offers Check for Updates where PDFLion updates itself", async ({ pdflion }) => {
  const file = await tracemonkey(await tempDir());
  const feed = await serveFeed({ version: NEWER });
  // The app menu on macOS, Help on Windows and Linux.
  const where = isMac ? "appmenu" : "help";

  // Not the dev app, unless it's pointed at a feed.
  let { app } = await pdflion([file]);
  expect((await menuItems(app, where)).map((item) => item.id)).not.toContain("checkForUpdates");
  await app.close();

  ({ app } = await pdflion([file], await fromFeed(feed.url, { automatic: true })));
  const items = await menuItems(app, where);
  const check = items.findIndex((item) => item.id === "checkForUpdates");
  const about = items.findIndex((item) => item.role === "about");
  expect(items[check + 1]).toMatchObject({ id: "automaticUpdates", type: "checkbox", checked: true });
  if (isMac) {
    // After About and a separator.
    expect(check).toBe(about + 2);
    expect((await menuItems(app, "help")).map((item) => item.id)).not.toContain("checkForUpdates");
  } else {
    expect(check).toBeGreaterThan(0);
    expect(about).toBeGreaterThan(check + 1);
  }
});

test("says when PDFLion is up to date", async ({ pdflion }) => {
  const feed = await serveFeed({ version: CURRENT });
  const { app, page } = await launchFromFeed(
    pdflion,
    [await tracemonkey(await tempDir())],
    await fromFeed(feed.url),
  );
  await answer(app, []);

  await clickMenu(app, page, "checkForUpdates");
  await expect.poll(() => messages(app)).toEqual(["PDFLion is up to date."]);
  expect(feed.requests.map((request) => request.url)).not.toContainEqual(
    expect.stringContaining(feed.installer),
  );
});

test("downloads a newer version by itself and asks to install it", async ({ pdflion }) => {
  const feed = await serveFeed({ version: NEWER });
  const { app, page } = await launchFromFeed(
    pdflion,
    [await tracemonkey(await tempDir())],
    await fromFeed(feed.url, { automatic: true }),
  );
  await app.evaluate(({ shell }) => {
    globalThis.opened = [];
    shell.openExternal = async (url) => void globalThis.opened.push(url);
  });
  await answer(app, ["Release Notes", "Later"]);

  // 10 s after launch, and on macOS once Squirrel.Mac has it. Release Notes
  // opens the release and asks again.
  await expect.poll(() => messages(app), { timeout: 30_000 }).toEqual([READY, READY]);
  expect(await app.evaluate(() => globalThis.opened)).toEqual([
    `https://github.com/xLion-ch/PDFLion/releases/tag/v${NEWER}`,
  ]);
  expect(feed.requests.map((request) => request.url)).toContainEqual(
    expect.stringContaining(feed.installer),
  );
  // Without the ID electron-updater would otherwise send every check.
  for (const request of feed.requests) expect(request.headers["x-user-staging-id"] ?? "").toBe("");

  // After Later, only the menu asks again.
  await answer(app, ["Later"]);
  await clickMenu(app, page, "checkForUpdates");
  await expect.poll(() => messages(app)).toEqual([READY]);
});

test("refuses an update whose SHA-512 doesn't match", async ({ pdflion }) => {
  const feed = await serveFeed({
    version: NEWER,
    sha512: crypto.createHash("sha512").update("something else").digest("base64"),
  });
  const { app, page } = await launchFromFeed(
    pdflion,
    [await tracemonkey(await tempDir())],
    await fromFeed(feed.url),
  );
  await answer(app, []);

  await clickMenu(app, page, "checkForUpdates");
  await expect.poll(() => messages(app)).toEqual([`PDFLion ${NEWER} couldn’t be downloaded.`]);
});

test("Restart Now asks about unsaved changes first", async ({ pdflion }) => {
  const dir = await tempDir();
  const file = path.join(dir, "form.pdf");
  await writeForm(file);
  const feed = await serveFeed({ version: NEWER });
  const { app, page } = await launchFromFeed(pdflion, [file], await fromFeed(feed.url));
  const installed = path.join(dir, "installed.json");
  await stubInstall(app, installed);
  await page.locator(".annotationLayer input").fill("changed");
  await expect.poll(() => isEdited(app, page)).toBe(true);
  const saveChanges = "Do you want to save the changes made to the document “form.pdf”?";

  // Cancel installs nothing, and leaves the document as it was.
  await answer(app, ["Restart Now", "Cancel"]);
  await clickMenu(app, page, "checkForUpdates");
  await expect.poll(() => messages(app)).toEqual([READY, saveChanges]);
  expect(page.isClosed()).toBe(false);
  expect(await isEdited(app, page)).toBe(true);
  await expect(fs.access(installed)).rejects.toThrow();

  // Don't Save closes the window, and PDFLion installs, then quits. On Windows
  // and Linux it doesn't quit with its last window first.
  await answer(app, ["Restart Now", "Don’t Save"]);
  const quit = app.waitForEvent("close");
  await clickMenu(app, page, "checkForUpdates");
  await quit;
  expect(JSON.parse(await fs.readFile(installed, "utf8"))).toMatchObject(
    isMac ? { squirrel: true } : { isSilent: true, isForceRunAfter: true },
  );
});

test("says when installing failed, and can try again", async ({ pdflion }) => {
  test.skip(isMac, "Squirrel.Mac installs only once PDFLion has quit");
  const dir = await tempDir();
  const feed = await serveFeed({ version: NEWER });
  const { app, page } = await launchFromFeed(
    pdflion,
    [await tracemonkey(dir)],
    await fromFeed(feed.url),
  );
  const installed = path.join(dir, "installed.json");

  // As when the password prompt on Linux is cancelled.
  await stubInstall(app, installed, { fails: true });
  await answer(app, ["Restart Now"]);
  await clickMenu(app, page, "checkForUpdates");
  await expect.poll(() => messages(app)).toEqual([READY, `PDFLion ${NEWER} wasn’t installed.`]);
  expect(page.isClosed()).toBe(false);

  await stubInstall(app, installed);
  await answer(app, ["Restart Now"]);
  const quit = app.waitForEvent("close");
  await clickMenu(app, page, "checkForUpdates");
  await quit;
});

test("says when macOS can't install an update where PDFLion is", async ({ pdflion }) => {
  test.skip(!isMac, "Squirrel.Mac");
  const feed = await serveFeed({ version: NEWER });
  const { app, page } = await launchFromFeed(
    pdflion,
    [await tracemonkey(await tempDir())],
    await fromFeed(feed.url, { automatic: true }),
    { squirrelError: READ_ONLY_VOLUME },
  );
  await answer(app, []);

  // The automatic check downloads it, but Squirrel.Mac refuses it, which
  // says nothing.
  await expect
    .poll(() => app.evaluate(() => globalThis.squirrelChecks), { timeout: 30_000 })
    .toBe(1);
  expect(await messages(app)).toEqual([]);

  await clickMenu(app, page, "checkForUpdates");
  await expect.poll(() => messages(app)).toEqual([`PDFLion ${NEWER} can’t be installed here.`]);
});

test("keeps automatic checks off once they're turned off", async ({ pdflion }) => {
  const file = await tracemonkey(await tempDir());
  const feed = await serveFeed({ version: NEWER });
  const options = await fromFeed(feed.url, { automatic: true });
  let { app, page } = await launchFromFeed(pdflion, [file], options);
  await clickMenu(app, page, "automaticUpdates");
  expect(await automaticChecked(app)).toBe(false);
  await app.close();

  ({ app, page } = await launchFromFeed(pdflion, [file], options));
  expect(await automaticChecked(app)).toBe(false);
  // Longer than PDFLion waits for its first check.
  await page.waitForTimeout(12_000);
  expect(feed.requests).toEqual([]);
});
