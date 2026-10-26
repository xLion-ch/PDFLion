import path from "node:path";
import { expect, tempDir, test, tracemonkey } from "./pdflion.js";
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
  expect(app.windows()).toHaveLength(1);
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
