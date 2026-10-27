import path from "node:path";
import {
  clickMenu,
  documentPage,
  documentPages,
  expect,
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
