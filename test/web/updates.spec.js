import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "../../scripts/build-web.js";
import {
  SERVICE_WORKER_SCRIPTS,
  TRACEMONKEY,
  appVersion,
  documentFrame,
  expect,
  homeFrame,
  openApp,
  openFromHome,
  serveApp,
  stripTabs,
  test,
} from "./pdflion.js";

const PAPER = "compressed.tracemonkey-pldi-09.pdf";

/** Two versions of the app, the second differing only in its version. */
const OLD = "1.0.1";
const NEW = "1.0.2";

/** @type {string} where the builds are */
let builds;

test.beforeAll(async () => {
  builds = await fs.mkdtemp(path.join(os.tmpdir(), "pdflion-web-builds-"));
  build({ version: OLD, out: path.join(builds, OLD) });
  build({ version: NEW, out: path.join(builds, NEW) });
});

test.afterAll(async () => {
  await fs.rm(builds, { recursive: true, force: true });
});

/**
 * Serves a version of the app, which `deploy()` replaces, as a release
 * replaces the files on GitHub Pages.
 *
 * @param {string} dir the test's
 * @param {string} version
 */
async function serveVersion(dir, version) {
  const site = path.join(dir, "site");
  /** @param {string} other */
  const deploy = async (other) => {
    await fs.rm(site, { recursive: true, force: true });
    await fs.cp(path.join(builds, other), site, { recursive: true });
  };
  await deploy(version);
  return { ...(await serveApp(site)), site, deploy };
}

/** @param {import("@playwright/test").Page} page */
async function checkNow(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

test("a new version downloads only what changed, and Restart Now brings it up with the tabs, but not Later", async ({
  page,
  dir,
}) => {
  const server = await serveVersion(dir, OLD);
  try {
    await openApp(page, server.url);
    await openFromHome(page, [TRACEMONKEY]);
    const viewer = await documentFrame(page, PAPER);
    expect(await appVersion(page)).toBe(OLD);

    await server.deploy(NEW);
    server.requests.length = 0;
    await checkNow(page);
    const prompt = page.locator("dialog");
    await expect(prompt.locator(".message")).toHaveText(`PDFLion ${NEW} is ready.`);
    await expect(prompt.locator(".buttons button")).toHaveText(["Release Notes", "Later", "Restart Now"]);
    // Its version.js and the service worker, whose list of files changed.
    expect(server.requests.filter((request) => !SERVICE_WORKER_SCRIPTS.includes(request))).toEqual([
      "/PDFLion/web/version.js",
    ]);

    // Later keeps the old version running.
    await prompt.getByRole("button", { name: "Later" }).click();
    await expect(prompt).toHaveCount(0);
    expect(await appVersion(page)).toBe(OLD);

    // Check for Updates… offers it again.
    await viewer.locator("#pdflionHomeButton").click();
    const home = await homeFrame(page);
    await home.locator("#info").click();
    await page.getByRole("menuitem", { name: "Check for Updates…" }).click();
    const reloaded = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
    await prompt.getByRole("button", { name: "Restart Now" }).click();
    await reloaded;
    await homeFrame(page);
    expect(await appVersion(page)).toBe(NEW);
    // The old version's files are gone.
    expect(await page.evaluate(() => caches.keys())).toEqual([expect.stringMatching(/^pdflion-1\.0\.2-[0-9a-f]{12}$/)]);
    expect((await stripTabs(page)).map((tab) => tab.name)).toEqual(["Home", PAPER]);
    await page.locator("#tabs .tab").nth(1).click();
    await documentFrame(page, PAPER);
  } finally {
    await server.close();
  }
});

test("Check for Updates… says when the app is up to date", async ({ page, dir }) => {
  const server = await serveVersion(dir, OLD);
  try {
    const home = await openApp(page, server.url);
    await home.locator("#info").click();
    await page.getByRole("menuitem", { name: "Check for Updates…" }).click();
    await expect(page.locator("dialog .message")).toHaveText("PDFLion is up to date.");
    await expect(page.locator("dialog .detail")).toHaveText(`PDFLion ${OLD} is the latest version.`);
  } finally {
    await server.close();
  }
});

test("a version whose file isn't what it lists doesn't install, and the old one stays", async ({
  page,
  dir,
}) => {
  const server = await serveVersion(dir, OLD);
  try {
    await openApp(page, server.url);
    await server.deploy(NEW);
    await fs.appendFile(path.join(server.site, "web", "version.js"), "// Changed after the build.\n");
    server.requests.length = 0;
    await checkNow(page);
    await expect.poll(() => server.requests).toContain("/PDFLion/web/version.js");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return !registration?.installing && !registration?.waiting;
        }),
      )
      .toBe(true);
    await expect(page.locator("dialog")).toHaveCount(0);
    expect(await appVersion(page)).toBe(OLD);
  } finally {
    await server.close();
  }
});
