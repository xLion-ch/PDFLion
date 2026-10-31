#!/usr/bin/env node
/**
 * Runs the trials that need no hands in Playwright's WebKit and Chromium, as
 * an iPad Pro 11 and a Galaxy Tab S9, and prints what they found. That is
 * Playwright's side of the question whether its WebKit is close enough to
 * an iPad's Safari for a web app's tests, and a first answer to the others,
 * on a Mac. Each browser gets a server of its own, which it loses
 * before the offline check, so that only the service worker can answer.
 * The pages' reports go to test/trials/results.jsonl, as an iPad's do.
 *
 * The browsers get persistent profiles, as Safari has: in Playwright's
 * default contexts, WebKit stores no Blobs in IndexedDB ("Error preparing
 * Blob/File data to be stored in object store").
 *
 *   node test/trials/run.js [webkit|chromium]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "@playwright/test";
import { serve } from "../../scripts/serve-web.js";
import { OUT, build } from "./build.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BROWSERS = {
  webkit: { type: webkit, device: devices["iPad Pro 11"] },
  chromium: { type: chromium, device: devices["Galaxy Tab S9"] },
};

/** The file the storage trial writes and reads, in MiB. */
const STORAGE_SIZE = 200;

/** Frames the memory trial opens. A Mac has memory for many more. */
const MEMORY_FRAMES = 4;

/**
 * @param {keyof typeof BROWSERS} name
 * @returns {Promise<Record<string, unknown>>}
 */
async function trial(name) {
  const { type, device } = BROWSERS[name];
  const { server, urls } = await serve({
    root: OUT,
    port: 0,
    report: path.join(HERE, "results.jsonl"),
  });
  const origin = urls[0];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `pdflion-trials-${name}-`));
  // A persistent context doesn't say its browser's version.
  const browser = await type.launch();
  /** @type {Record<string, unknown>} */
  const results = { browser: `${name} ${browser.version()}` };
  await browser.close();
  const context = await type.launchPersistentContext(profile, device);
  /** @type {Set<string>} */
  const errors = new Set();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("pageerror", (error) => errors.add(`${page.url()}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.add(`${page.url()}: ${message.text()}`);
    });

    const started = Date.now();
    await page.goto(`${origin}index.html`);
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, {
      timeout: 120_000,
    });
    results.installSeconds = (Date.now() - started) / 1000;

    /**
     * @param {string} query trial.html's
     * @param {number} timeout
     */
    const runTrial = async (query, timeout) => {
      await page.goto(`${origin}trial.html?${query}&auto`);
      await page.waitForSelector("body[data-done]", { timeout });
      return page.evaluate(() => /** @type {any} */ (window).trialResults);
    };
    results.features = await runTrial("name=features", 120_000);
    results.storage = await runTrial(`name=storage&size=${STORAGE_SIZE}`, 600_000);
    results.memory = await runTrial(
      `name=memory&frames=${MEMORY_FRAMES}&document=scans.pdf`,
      600_000,
    );

    // Offline: no server, and no network.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await context.setOffline(true);
    await page.goto(`${origin}index.html`);
    results.offlineIndex = (await page.title()) === "PDFLion trials";
    await page.goto(`${origin}viewer/web/viewer.html?file=..%2F..%2Fdocs%2Ftracemonkey.pdf`);
    results.offlineViewer = await page
      .waitForSelector("#viewer .page canvas", { timeout: 60_000 })
      .then(() => true, (error) => String(error).split("\n")[0]);
    // bridge.js ran, under host.js.
    results.offlineBridge = (await page.locator("#pdflionEditorEraserButton").count()) === 1;
    await context.setOffline(false);
  } catch (error) {
    results.error = String(error).split("\n")[0];
  } finally {
    await context.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  results.errors = [...errors];
  return results;
}

async function main() {
  const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(BROWSERS);
  for (const name of names) {
    if (!Object.hasOwn(BROWSERS, name)) throw new Error(`no browser ${name}: webkit or chromium`);
  }
  build();
  for (const name of names) {
    console.log(`\n==> ${name}`);
    console.log(JSON.stringify(await trial(/** @type {keyof typeof BROWSERS} */ (name)), null, 2));
  }
}

main().catch((error) => {
  console.error(`error: ${/** @type {Error} */ (error).message}`);
  process.exit(1);
});
