import path from "node:path";
import { LINKS, writeLabelled, writeLinks } from "../e2e/pdfs.js";
import {
  TRACEMONKEY,
  commandKey,
  documentFrame,
  drawStroke,
  expect,
  homeFrame,
  openApp,
  openAppExplained,
  openFromHome,
  readLibrary,
  stripTabs,
  test,
} from "./pdflion.js";

test("documents open as tabs after Home, which always shows, leftmost, as an icon", async ({
  page,
  dir,
}) => {
  const other = path.join(dir, "Other.pdf");
  await writeLabelled(other, 2);
  await openApp(page);
  await expect(page.locator("#tabs")).toBeVisible();
  expect(await stripTabs(page)).toMatchObject([{ name: "Home", home: true, active: true }]);
  const homeTab = page.locator("#tabs .tab.home");
  await expect(homeTab.locator(".name")).toHaveText("");
  await expect(homeTab.locator(".close")).toBeHidden();
  expect(await homeTab.getAttribute("draggable")).toBe("false");

  await openFromHome(page, [TRACEMONKEY, other]);
  await documentFrame(page, "Other.pdf");
  // After Home, and the last shows.
  expect(await stripTabs(page)).toMatchObject([
    { name: "Home", home: true, active: false },
    { name: "compressed.tracemonkey-pldi-09.pdf", home: false, active: false },
    { name: "Other.pdf", home: false, active: true },
  ]);
  await expect(page).toHaveTitle("Other.pdf – PDFLion");
  // Home's tab is narrower than a document's.
  const width = async (/** @type {import("@playwright/test").Locator} */ tab) =>
    (await tab.boundingBox())?.width ?? 0;
  expect(await width(homeTab)).toBeLessThan(await width(page.locator("#tabs .tab:not(.home)").first()));

  const key = await commandKey(page);
  await page.keyboard.press("Control+Shift+Tab");
  await expect
    .poll(async () => (await stripTabs(page)).map((tab) => tab.active))
    .toEqual([false, true, false]);
  await page.keyboard.press(`${key}+w`);
  await expect
    .poll(async () => (await stripTabs(page)).map((tab) => tab.name))
    .toEqual(["Home", "Other.pdf"]);

  // The last document closing shows Home, which doesn't close.
  await page.keyboard.press(`${key}+w`);
  await homeFrame(page);
  expect(await stripTabs(page)).toMatchObject([{ home: true, active: true }]);
  await page.keyboard.press(`${key}+w`);
  await homeFrame(page);
  expect(await stripTabs(page)).toMatchObject([{ home: true, active: true }]);
});

test("the shortcuts work in the viewer, in Home and in the strip", async ({ page }) => {
  await openApp(page);
  const key = await commandKey(page);
  const home = await homeFrame(page);

  // ⌘N in Home.
  await home.locator("body").press(`${key}+n`);
  const viewer = await documentFrame(page, "Untitled.pdf");
  const pages = () => viewer.evaluate(() => window.PDFViewerApplication.pdfViewer.pagesCount);

  // ⇧⌘N, ⌥⌘6 (Ctrl+Shift+O elsewhere) and ⇧⌘E in the viewer.
  await viewer.locator("#viewerContainer").click();
  await page.keyboard.press(`${key}+Shift+n`);
  await expect.poll(pages).toBe(2);
  await page.keyboard.press(key === "Meta" ? "Meta+Alt+Digit6" : "Control+Shift+o");
  await expect(viewer.locator("#outerContainer.pdflionPageOverview")).toHaveCount(1);
  await page.keyboard.press(key === "Meta" ? "Meta+Alt+Digit6" : "Control+Shift+o");
  await expect(viewer.locator("#outerContainer.pdflionPageOverview")).toHaveCount(0);
  await page.keyboard.press(`${key}+Shift+e`);
  await expect(viewer.locator("#pdflionEditorEraserButton")).toHaveClass(/toggled/);

  // ⌘S saves at once, and says so.
  await page.keyboard.press(`${key}+s`);
  await expect(page.locator(".snackbar .text")).toHaveText("“Untitled.pdf” is saved in PDFLion.");
  expect((await readLibrary(page))[0].revision).toBe(1);

  // ⇧⌘H shows Home, before the document.
  await page.keyboard.press(`${key}+Shift+h`);
  await homeFrame(page);
  expect(await stripTabs(page)).toMatchObject([{ home: true, active: true }, { name: "Untitled.pdf" }]);

  // ⌃⇧Tab in the strip.
  await page.locator("#tabs .tab.active").focus();
  await page.keyboard.press("Control+Shift+Tab");
  await expect.poll(async () => (await stripTabs(page)).map((tab) => tab.active)).toEqual([false, true]);
});

test("pdf.js keeps the keys PDFLion leaves it, such as zooming", async ({ page }) => {
  await openApp(page);
  await openFromHome(page, [TRACEMONKEY]);
  const viewer = await documentFrame(page, "compressed.tracemonkey-pldi-09.pdf");
  const scale = () => viewer.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale);
  const before = await scale();
  await viewer.locator("#viewerContainer").click();
  await page.keyboard.press(`${await commandKey(page)}+Equal`);
  await expect.poll(scale).toBeGreaterThan(before);
});

test("closing a tab that isn't in Files says so, and offers Share", async ({ page }) => {
  await openApp(page);
  await openFromHome(page, [TRACEMONKEY]);
  const viewer = await documentFrame(page, "compressed.tracemonkey-pldi-09.pdf");
  await drawStroke(page, viewer);
  // Closing saves first, so the stroke isn't lost.
  await page.keyboard.press(`${await commandKey(page)}+w`);
  await expect(page.locator(".snackbar .text")).toHaveText(
    "“compressed.tracemonkey-pldi-09.pdf” is saved in PDFLion, not in Files.",
  );
  await expect(page.locator(".snackbar .action")).toHaveText("Share…");
  expect((await readLibrary(page))[0].revision).toBe(1);
});

test("Home's ⓘ menu has About, the pen setting and the storage used", async ({ page }) => {
  const home = await openApp(page);
  await home.locator("#info").click();
  await expect(page.locator(".menu .info")).toHaveText(/ of storage used$/);
  const penOnly = page.getByRole("menuitemcheckbox", { name: "Draw Only with a Pen" });
  await expect(penOnly).toHaveAttribute("aria-checked", "false");
  await penOnly.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const open = indexedDB.open("pdflion");
            open.onsuccess = () => {
              const get = open.result.transaction("settings").objectStore("settings").get("toolSettings");
              get.onsuccess = () => resolve(get.result?.penOnly);
            };
          }),
      ),
    )
    .toBe(true);

  await home.locator("#info").click();
  await page.getByRole("menuitem", { name: "About PDFLion" }).click();
  await expect(page.locator("dialog.about .detail")).toHaveText(/^Version .+ · pdf\.js \d+\.\d+\.\d+$/);
  await expect(page.locator("dialog.about").getByRole("link", { name: "pdf.js" })).toHaveAttribute(
    "href",
    "https://github.com/mozilla/pdf.js",
  );
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.locator("dialog")).toHaveCount(0);
});

test("the viewer and Home run only in the shell", async ({ page }) => {
  await page.goto("viewer/web/viewer.html");
  await expect(page).toHaveURL("about:blank");
  await page.goto("home/home.html");
  await expect(page).toHaveURL("about:blank");
});

test("links in documents open only for http, https and mailto", async ({ page, dir }) => {
  const file = path.join(dir, "Links.pdf");
  await writeLinks(file);
  await openApp(page);
  await openFromHome(page, [file]);
  const viewer = await documentFrame(page, "Links.pdf");
  await page.context().route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Example</title>" }),
  );
  // pdf.js makes only the https link clickable: it drops file: and javascript: links.
  const links = viewer.locator(".annotationLayer .linkAnnotation a");
  await expect(links).toHaveCount(1);
  const popup = page.context().waitForEvent("page");
  await links.click();
  expect((await popup).url()).toBe(LINKS[0]);

  // What a page could still try.
  const opened = await viewer.evaluate(() => {
    const tries = ["file:///etc/passwd", "smb://example.com/share", "javascript:void 0"];
    const windows = tries.map((url) => window.open(url));
    for (const url of tries) {
      const link = Object.assign(document.createElement("a"), { href: url, target: "_blank" });
      document.body.append(link);
      link.click();
      link.remove();
    }
    return windows.filter(Boolean).length;
  });
  expect(opened).toBe(0);
  await page.waitForTimeout(500);
  expect(page.context().pages()).toHaveLength(2);
});

test.describe("in French", () => {
  test.use({ locale: "fr-FR" });

  test("PDFLion's own texts follow the browser's language, as pdf.js's do", async ({ page }) => {
    const home = await openAppExplained(page);
    await expect(home.locator("#empty .message")).toHaveText("Aucun document récent");
    await expect(page.locator("#tabs")).toHaveAttribute("aria-label", "Documents");
    await expect(page.locator("#tabs .tab.home")).toHaveAttribute("title", "Accueil");
    await home.locator("#info").click();
    await expect(page.getByRole("menuitem", { name: "À propos de PDFLion" })).toBeVisible();
  });
});

test("the Home Screen icon follows the appearance, on a dark background in dark mode", async ({ page }) => {
  await openAppExplained(page);
  const icon = page.locator('link[rel="apple-touch-icon"]');
  await page.emulateMedia({ colorScheme: "light" });
  await expect(icon).toHaveAttribute("href", "web/icons/apple-touch-icon.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(icon).toHaveAttribute("href", "web/icons/apple-touch-icon-dark.png");
  // The service worker has it for offline use, like every file of the app.
  const response = await page.request.get("web/icons/apple-touch-icon-dark.png");
  expect(response.headers()["content-type"]).toBe("image/png");
});

/**
 * Makes the shell's registrations of its service worker never settle, as
 * WebKit's have been seen to, the first `stalls` times the page loads.
 *
 * @param {import("@playwright/test").Page} page
 * @param {number} stalls
 */
const stallRegistering = (page, stalls) =>
  page.addInitScript((stalls) => {
    if (window.top !== window) return;
    const loads = Number(sessionStorage.getItem("test-loads") ?? 0) + 1;
    sessionStorage.setItem("test-loads", String(loads));
    if (loads <= stalls) ServiceWorkerContainer.prototype.register = () => new Promise(() => {});
  }, stalls);

test("a first launch whose service worker never registers reloads once", async ({ page }) => {
  await stallRegistering(page, 1);
  await openApp(page);
  expect(await page.evaluate(() => sessionStorage.getItem("test-loads"))).toBe("2");
});

test("a first launch whose service worker never registers, also after reloading, says so", async ({
  page,
}) => {
  await stallRegistering(page, 2);
  await page.goto("./");
  await expect(page.getByText("PDFLion couldn’t be downloaded.")).toBeVisible({ timeout: 40_000 });
  expect(await page.evaluate(() => sessionStorage.getItem("test-loads"))).toBe("2");
});
