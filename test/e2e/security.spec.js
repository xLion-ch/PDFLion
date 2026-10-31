import fs from "node:fs/promises";
import path from "node:path";
import {
  answerMessages,
  clickMenu,
  documentPage,
  documentPages,
  expect,
  homePage,
  isStrip,
  openFile,
  rendered,
  stripOf,
  stripTabs,
  tempDir,
  test,
  tracemonkey,
  windowCount,
} from "./pdflion.js";
import { writeLinks } from "./pdfs.js";

test("opens web links in the browser, and nothing else anywhere", async ({ pdflion }) => {
  const file = path.join(await tempDir(), "links.pdf");
  await writeLinks(file);
  const { app, page } = await pdflion([file]);
  await app.evaluate(({ shell }) => {
    const opened = (globalThis.opened = []);
    shell.openExternal = async (url) => {
      opened.push(url);
    };
  });
  const opened = () => app.evaluate(() => globalThis.opened);
  const viewerUrl = page.url();

  // pdf.js makes only the https link clickable: it drops file: and javascript: links.
  const links = page.locator(".annotationLayer .linkAnnotation a");
  await expect(links).toHaveCount(1);
  await links.click();
  await expect.poll(opened).toEqual(["https://example.com/"]);

  // What a page could still try. Main denies it.
  for (const url of [
    "file:///etc/passwd",
    "smb://example.com/share",
    "pdflion://app/viewer/web/viewer.html",
  ]) {
    await page.evaluate((url) => window.open(url), url);
  }
  await page.evaluate(() => {
    location.href = "https://example.com/elsewhere";
  });
  await page.waitForTimeout(500);
  expect(await opened()).toEqual(["https://example.com/"]);
  expect(documentPages(app)).toHaveLength(1);
  expect(await windowCount(app)).toBe(1);
  expect(page.url()).toBe(viewerUrl);
});

test("grants pdf.js only full screen and clipboard writes", async ({ pdflion }) => {
  const { page } = await pdflion([await tracemonkey(await tempDir())]);

  const states = await page.evaluate(async () => {
    /** @type {Record<string, string>} */
    const result = {};
    for (const name of [
      "clipboard-write",
      "clipboard-read",
      "geolocation",
      "notifications",
      "camera",
    ]) {
      result[name] = (await navigator.permissions.query(/** @type {any} */ ({ name }))).state;
    }
    return result;
  });
  expect(states).toEqual({
    "clipboard-write": "granted",
    "clipboard-read": "denied",
    geolocation: "denied",
    notifications: "denied",
    camera: "denied",
  });
  expect(await page.evaluate(() => Notification.requestPermission())).toBe("denied");
});

test("keeps window.pdflion off pages other than the viewer", async ({ pdflion }) => {
  const { page } = await pdflion([await tracemonkey(await tempDir())]);
  expect(await page.evaluate(() => typeof window.pdflion)).toBe("object");

  // about:blank gets past will-navigate, and the preload runs there too.
  await Promise.all([
    page.waitForURL("about:blank"),
    page.evaluate(() => {
      location.href = "about:blank";
    }),
  ]);
  expect(await page.evaluate(() => typeof window.pdflion)).toBe("undefined");
});

test("keeps window.pdflionTabs to the tab strip, and window.pdflion to the viewer", async ({
  pdflion,
}) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  const strip = await stripOf(app, page);
  expect(await strip.evaluate(() => [typeof window.pdflion, typeof window.pdflionTabs])).toEqual([
    "undefined",
    "object",
  ]);
  expect(await page.evaluate(() => typeof window.pdflionTabs)).toBe("undefined");
});

test("takes tab messages only from the strip, and only for its own tabs", async ({ pdflion }) => {
  const dir = await tempDir();
  const { app, page: first } = await pdflion([await tracemonkey(dir, "first.pdf")]);
  await openFile(app, await tracemonkey(dir, "second.pdf"));
  const second = await documentPage(app, "second.pdf");
  await rendered(second);
  const strip = await stripOf(app, first);
  const [firstId, secondId] = (await stripTabs(strip)).map(({ id }) => id);
  /**
   * Hands main a message as if `from`'s page had sent it. Every strip has the
   * same URL, so a strip is found by its window.
   *
   * @param {import("./pdflion.js").Page} from
   * @param {string} channel
   * @param {unknown[]} args
   */
  const send = async (from, channel, ...args) => {
    const windowId = isStrip(from.url())
      ? await (await app.browserWindow(from)).evaluate((win) => win.id)
      : null;
    await app.evaluate(
      ({ BrowserWindow, ipcMain, webContents }, { url, windowId, channel, args }) => {
        const sender =
          windowId === null
            ? webContents
                .getAllWebContents()
                .find((other) => other.getURL().split("#")[0] === url.split("#")[0])
            : BrowserWindow.fromId(windowId)?.webContents;
        if (!sender) throw new Error(`No page at ${url}`);
        ipcMain.emit(channel, { sender, senderFrame: sender.mainFrame }, ...args);
      },
      { url: from.url(), windowId, channel, args },
    );
  };

  // From a viewer, which could be showing a hostile PDF.
  await send(second, "pdflion-tabs:select", firstId, true);
  await send(second, "pdflion-tabs:close", firstId);
  await send(second, "pdflion-tabs:drag-started", firstId);
  await send(second, "pdflion-tabs:drop", firstId, 0);
  await first.waitForTimeout(500);
  expect(await stripTabs(strip)).toMatchObject([
    { name: "first.pdf", active: false },
    { name: "second.pdf", active: true },
  ]);

  // From another window's strip.
  await clickMenu(app, second, "moveTabToNewWindow");
  await expect.poll(() => windowCount(app)).toBe(2);
  const otherStrip = await stripOf(app, second);
  await send(otherStrip, "pdflion-tabs:close", firstId);
  await first.waitForTimeout(500);
  expect(documentPages(app)).toHaveLength(2);

  // From the tab's own strip, which works.
  const closed = first.waitForEvent("close");
  await send(strip, "pdflion-tabs:close", firstId);
  await closed;
  expect(await stripTabs(otherStrip)).toMatchObject([{ id: secondId }]);
});

test("shows only the page dialogs main words, whatever the viewer asks", async ({ pdflion }) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  await answerMessages(app, "OK");
  const ask = (/** @type {unknown[]} */ ...args) =>
    page.evaluate((args) => window.pdflion.pageDialog(...args), args);

  for (const args of [
    ["Your files are encrypted. Pay now."],
    ["toString"],
    ["failed", ["xmp"]],
    ["rewrite"],
    ["rewrite", []],
    ["rewrite", ["xmp", "xmp"]],
    ["rewrite", ["<b>bold</b>"]],
    ["rewrite", "xmp"],
  ]) {
    expect(await ask(...args), JSON.stringify(args)).toBe(false);
  }
  expect(await app.evaluate(() => /** @type {any} */ (globalThis).messages)).toEqual([]);

  expect(await ask("failed")).toBe(false);
  expect(await app.evaluate(() => /** @type {any} */ (globalThis).messages)).toEqual([
    "The pages of the document “tracemonkey.pdf” couldn’t be changed.",
  ]);
});

/**
 * Hands main a message on `channel` as if `from`, a tab's page, had sent it.
 *
 * @param {import("./pdflion.js").ElectronApplication} app
 * @param {import("./pdflion.js").Page} from
 * @param {string} channel
 * @param {unknown[]} args
 */
async function sendFrom(app, from, channel, ...args) {
  await app.evaluate(
    ({ ipcMain, webContents }, { url, channel, args }) => {
      const sender = webContents
        .getAllWebContents()
        .find((other) => other.getURL().split("#")[0] === url.split("#")[0]);
      if (!sender) throw new Error(`No page at ${url}`);
      ipcMain.emit(channel, { sender, senderFrame: sender.mainFrame }, ...args);
    },
    { url: from.url(), channel, args },
  );
}

/**
 * @param {import("./pdflion.js").Page} home
 * @returns {Promise<string[]>} the names of the documents Home shows
 */
const homeNames = (home) => home.locator(".card .name").allTextContents();

test("keeps window.pdflionHome to Home, and Home's page to its own API", async ({ pdflion }) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  await clickMenu(app, page, "home");
  const home = await homePage(app);
  const strip = await stripOf(app, page);
  const apis = () => [typeof window.pdflion, typeof window.pdflionTabs, typeof window.pdflionHome];
  expect(await home.evaluate(apis)).toEqual(["undefined", "undefined", "object"]);
  expect(await page.evaluate(apis)).toEqual(["object", "undefined", "undefined"]);
  expect(await strip.evaluate(apis)).toEqual(["undefined", "object", "undefined"]);

  // Home stays on Home, and about:blank, which gets past will-navigate, gets
  // no API.
  await home.evaluate(() => {
    location.href = "pdflion://app/viewer/web/viewer.html";
  });
  await home.waitForTimeout(500);
  expect(home.url()).toBe("pdflion://app/home/home.html");
  await Promise.all([
    home.waitForURL("about:blank"),
    home.evaluate(() => {
      location.href = "about:blank";
    }),
  ]);
  expect(await home.evaluate(() => typeof window.pdflionHome)).toBe("undefined");
});

test("takes Home's messages only from Home, and only for documents on its list", async ({
  pdflion,
}) => {
  const dir = await tempDir();
  const first = await tracemonkey(dir, "first.pdf");
  const second = await tracemonkey(dir, "second.pdf");
  const { app, page } = await pdflion([first]);
  await clickMenu(app, page, "home");
  const home = await homePage(app);
  await expect.poll(() => homeNames(home)).toEqual(["first.pdf"]);
  const id = await home.locator(".card").first().getAttribute("data-id");

  // From a viewer, which could be showing a hostile PDF.
  await sendFrom(app, page, "pdflion-home:clear");
  await sendFrom(app, page, "pdflion-home:remove", id);
  await sendFrom(app, page, "pdflion-home:open-files", [second]);
  await sendFrom(app, page, "pdflion-home:new-document");
  // From Home, but naming no document of its list, or a path.
  await sendFrom(app, home, "pdflion-home:remove", "0b6c3a52-5d0e-4c55-9d1e-6f1c2f0e8a41");
  await sendFrom(app, home, "pdflion-home:open", first);
  await sendFrom(app, home, "pdflion-home:show-in-folder", first);
  await sendFrom(app, home, "pdflion-home:open-files", ["relative.pdf", "/etc/passwd"]);
  await home.waitForTimeout(500);
  expect(documentPages(app)).toHaveLength(1);
  expect(await homeNames(home)).toEqual(["first.pdf"]);

  // From Home, for its own document, which works.
  await sendFrom(app, home, "pdflion-home:remove", id);
  await expect.poll(() => homeNames(home)).toEqual([]);
});

test("keeps as thumbnails only small PNGs from a document with a file", async ({ pdflion }) => {
  const dir = await tempDir();
  const { app, page, userData } = await pdflion([await tracemonkey(dir, "first.pdf")]);
  await clickMenu(app, page, "home");
  const home = await homePage(app);
  await expect(home.locator(".card")).toHaveCount(1);
  const id = await home.locator(".card").first().getAttribute("data-id");
  const thumbnail = path.join(userData, "thumbnails", `${id}.png`);
  // The viewer's own, which comes once the page has shown.
  await expect.poll(() => fs.stat(thumbnail).then(() => true, () => false)).toBe(true);

  /**
   * Hands main a PNG header of that size, padded to `bytes`, from `from`.
   *
   * @param {import("./pdflion.js").Page} from
   * @param {{ width: number, height: number, bytes?: number, signature?: boolean }} png
   */
  const sendPng = (from, { width, height, bytes = 1000, signature = true }) =>
    app.evaluate(
      ({ ipcMain, webContents }, { url, width, height, bytes, signature }) => {
        const png = new Uint8Array(bytes);
        if (signature) png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
        png.set([0x49, 0x48, 0x44, 0x52], 12);
        new DataView(png.buffer).setUint32(16, width);
        new DataView(png.buffer).setUint32(20, height);
        png[bytes - 1] = width % 256; // which PNG this is
        const sender = webContents
          .getAllWebContents()
          .find((other) => other.getURL().split("#")[0] === url.split("#")[0]);
        ipcMain.emit("pdflion:thumbnail", { sender, senderFrame: sender?.mainFrame }, png);
      },
      { url: from.url(), width, height, bytes, signature },
    );
  const last = async () => (await fs.readFile(thumbnail)).at(-1);

  await sendPng(page, { width: 100, height: 130 });
  await expect.poll(last).toBe(100);

  await sendPng(page, { width: 513, height: 130 });
  await sendPng(page, { width: 120, height: 513 });
  await sendPng(page, { width: 121, height: 130, bytes: 256 * 1024 + 1 });
  await sendPng(page, { width: 122, height: 130, signature: false });
  await sendPng(home, { width: 123, height: 130 });
  await page.waitForTimeout(500);
  expect(await last()).toBe(100);

  // Served as a PNG, which nothing may take for anything else. Home's CSP
  // lets it load images only, so main fetches it.
  const fetchFromMain = (/** @type {string} */ url) =>
    app.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url);
      const { headers } = response;
      return [response.status, headers.get("Content-Type"), headers.get("X-Content-Type-Options")];
    }, url);
  const answer = await fetchFromMain(`pdflion://app/thumb/${id}.png`);
  expect(answer).toEqual([200, "image/png", "nosniff"]);
  for (const url of ["pdflion://app/thumb/first.png", "pdflion://app/thumb/..%2Fstate.json"]) {
    expect((await fetchFromMain(url))[0]).toBe(404);
  }
});
