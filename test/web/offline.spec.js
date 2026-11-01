import fs from "node:fs/promises";
import path from "node:path";
import { OUT } from "../../scripts/build-web.js";
import {
  SERVICE_WORKER_SCRIPTS,
  TRACEMONKEY,
  documentFrame,
  expect,
  openApp,
  openFromHome,
  serveApp,
  test,
} from "./pdflion.js";

const PAPER = "compressed.tracemonkey-pldi-09.pdf";

test("once it has run, the app and its documents open from its own files, also without the network", async ({
  page,
}) => {
  const server = await serveApp(OUT);
  try {
    await openApp(page, server.url);
    await openFromHome(page, [TRACEMONKEY]);
    await documentFrame(page, PAPER);

    // Only the service worker's scripts come from the network, for the
    // browser's check for a new version.
    server.requests.length = 0;
    await page.reload();
    await documentFrame(page, PAPER);
    expect(server.requests.filter((path) => !SERVICE_WORKER_SCRIPTS.includes(path))).toEqual([]);
  } finally {
    await server.close();
  }

  await page.reload();
  const viewer = await documentFrame(page, PAPER);
  expect(await viewer.evaluate(() => window.PDFViewerApplication.pagesCount)).toBe(14);

  // Checks for updates fail, and say nothing.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const checked = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.update().then(
      () => "updated",
      () => "failed",
    );
  });
  expect(checked).toBe("failed");
  await expect(page.locator("dialog")).toHaveCount(0);
});

test("a first visit whose download isn't what the app lists says so", async ({ page, dir }) => {
  const site = path.join(dir, "site");
  await fs.cp(OUT, site, { recursive: true });
  await fs.appendFile(path.join(site, "web", "web.css"), "/* Changed after the build. */\n");
  const server = await serveApp(site);
  try {
    await page.goto(server.url);
    await expect(page.locator("dialog .message")).toHaveText("PDFLion couldn’t be downloaded.");
  } finally {
    await server.close();
  }
});
