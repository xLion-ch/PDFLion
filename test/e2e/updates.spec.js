/**
 * Updates, from a local feed: an HTTP server that serves electron-updater's
 * generic provider, which the dev app reads with --pdflion-update-config. The
 * installer is a few random bytes, and the install itself is stubbed, since
 * it would run them, or dpkg through pkexec. electron-updater keeps its
 * download in a temporary cache folder.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { ROOT, clickMenu, expect, isEdited, tempDir, test, tracemonkey } from "./pdflion.js";
import { writeForm } from "./pdfs.js";

/** @typedef {import("./pdflion.js").ElectronApplication} ElectronApplication */

const isMac = process.platform === "darwin";

/** Newer than any release. */
const NEWER = "99.0.0";

const READY = `PDFLion ${NEWER} is ready to install.`;

const CURRENT = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")).version;

/** @type {http.Server[]} */
const servers = [];

test.afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
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
  const installer = `PDFLion-${version}-${process.platform === "win32" ? "win-x64.exe" : "linux-amd64.deb"}`;
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
 * @param {{ automatic?: boolean, userData?: string }} [options]
 */
async function fromFeed(url, { automatic = false, userData } = {}) {
  const dir = await tempDir();
  const config = path.join(dir, "app-update.yml");
  await fs.writeFile(
    config,
    `provider: generic\nurl: ${url}\nupdaterCacheDirName: pdflion-updater\n`,
  );
  if (!userData) {
    userData = await tempDir();
    if (!automatic) {
      await fs.writeFile(
        path.join(userData, "state.json"),
        JSON.stringify({ updates: { automatic: false } }),
      );
    }
  }
  // electron-updater's cache, which it finds in these on Windows and Linux.
  const cache = path.join(dir, "cache");
  return {
    userData,
    args: [`--pdflion-update-config=${config}`],
    env: { LOCALAPPDATA: cache, XDG_CACHE_HOME: cache },
  };
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
 * Replaces the install with one that writes how it was asked to install to
 * `file`, and succeeds, or fails as a cancelled password prompt does.
 *
 * @param {ElectronApplication} app
 * @param {string} file
 * @param {{ fails?: boolean }} [options]
 */
async function stubInstall(app, file, { fails = false } = {}) {
  await app.evaluate(
    (_electron, { root, file, fails }) => {
      const { createRequire } = process.getBuiltinModule("node:module");
      const fs = process.getBuiltinModule("node:fs");
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
 * @param {ElectronApplication} app
 * @returns {Promise<{ id: string, type: string, checked: boolean }[]>} the
 *   Help menu's items
 */
function helpItems(app) {
  return app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items.find((item) => item.role === "help")?.submenu?.items ?? []).map(
      (item) => ({ id: item.id, type: item.type, checked: item.checked, role: item.role ?? "" }),
    ),
  );
}

test("offers Check for Updates only where PDFLion updates itself", async ({ pdflion }) => {
  const file = await tracemonkey(await tempDir());
  const feed = await serveFeed({ version: NEWER });

  // The dev app, unless it's pointed at a feed.
  let { app } = await pdflion([file]);
  expect((await helpItems(app)).map((item) => item.id)).not.toContain("checkForUpdates");
  await app.close();

  ({ app } = await pdflion([file], await fromFeed(feed.url, { automatic: true })));
  const items = await helpItems(app);
  const ids = items.map((item) => item.id);
  if (isMac) {
    // Not before Squirrel.Mac can install an ad-hoc-signed update.
    expect(ids).not.toContain("checkForUpdates");
    expect(ids).not.toContain("automaticUpdates");
    return;
  }
  const check = ids.indexOf("checkForUpdates");
  expect(check).toBeGreaterThan(0);
  expect(items[check + 1]).toMatchObject({ id: "automaticUpdates", type: "checkbox", checked: true });
  expect(items.findIndex((item) => item.role === "about")).toBeGreaterThan(check + 1);
});

test.describe("on Windows and Linux", () => {
  test.skip(isMac, "Updates are off on macOS");

  test("says when PDFLion is up to date", async ({ pdflion }) => {
    const feed = await serveFeed({ version: CURRENT });
    const { app, page } = await pdflion(
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
    const { app, page } = await pdflion(
      [await tracemonkey(await tempDir())],
      await fromFeed(feed.url, { automatic: true }),
    );
    await app.evaluate(({ shell }) => {
      globalThis.opened = [];
      shell.openExternal = async (url) => void globalThis.opened.push(url);
    });
    await answer(app, ["Release Notes", "Later"]);

    // 10 s after launch. Release Notes opens the release and asks again.
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
    const { app, page } = await pdflion(
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
    const { app, page } = await pdflion([file], await fromFeed(feed.url));
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

    // Don't Save closes the window, and PDFLion installs, then quits, rather
    // than quitting with its last window.
    await answer(app, ["Restart Now", "Don’t Save"]);
    const quit = app.waitForEvent("close");
    await clickMenu(app, page, "checkForUpdates");
    await quit;
    expect(JSON.parse(await fs.readFile(installed, "utf8"))).toMatchObject({
      isSilent: true,
      isForceRunAfter: true,
    });
  });

  test("says when installing failed, and can try again", async ({ pdflion }) => {
    const dir = await tempDir();
    const feed = await serveFeed({ version: NEWER });
    const { app, page } = await pdflion([await tracemonkey(dir)], await fromFeed(feed.url));
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

  test("keeps automatic checks off once they're turned off", async ({ pdflion }) => {
    const file = await tracemonkey(await tempDir());
    const feed = await serveFeed({ version: NEWER });
    const options = await fromFeed(feed.url, { automatic: true });
    let { app, page } = await pdflion([file], options);
    await clickMenu(app, page, "automaticUpdates");
    expect((await helpItems(app)).find((item) => item.id === "automaticUpdates")?.checked).toBe(
      false,
    );
    await app.close();

    ({ app, page } = await pdflion([file], options));
    expect((await helpItems(app)).find((item) => item.id === "automaticUpdates")?.checked).toBe(
      false,
    );
    // Longer than PDFLion waits for its first check.
    await page.waitForTimeout(12_000);
    expect(feed.requests).toEqual([]);
  });
});
