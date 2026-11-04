import fs from "node:fs/promises";
import path from "node:path";
import {
  LIBRARY_FILE_NAME,
  readLibraryFile,
  readSettingsFile,
  writeLibraryFile,
  writeSettingsFile,
} from "../../src/shared/backup.js";
import { readEntry, readZip, writeZip } from "../../src/shared/zip.js";
import { writeLabelled } from "../e2e/pdfs.js";
import {
  TRACEMONKEY,
  documentFrame,
  drawStroke,
  expect,
  homeFrame,
  openApp,
  openAppExplained,
  openFromHome,
  readLibrary,
  sharedFile,
  storedBytes,
  stubShare,
  test,
} from "./pdflion.js";

/** @typedef {import("@playwright/test").Page} Page */

const PAPER = "compressed.tracemonkey-pldi-09.pdf";

/** @param {Page} page */
async function showHome(page) {
  await page.keyboard.press(`${(await page.evaluate(() => PDFLionKeys.commandKeyHere())) === "meta" ? "Meta" : "Control"}+Shift+h`);
  return homeFrame(page);
}

/**
 * Export… from Home's ⓘ menu.
 *
 * @param {Page} page
 * @param {string} choice the button that answers what to export
 */
async function exportFromHome(page, choice) {
  const home = await homeFrame(page);
  await home.locator("#info").click();
  await page.getByRole("menuitem", { name: "Export…" }).click();
  await expect(page.locator("dialog .message")).toHaveText("What do you want to export?");
  await page.locator("dialog").getByRole("button", { name: choice }).click();
}

/**
 * Import… from Home's ⓘ menu.
 *
 * @param {Page} page
 * @param {string} file
 */
async function importIntoHome(page, file) {
  const home = await homeFrame(page);
  await home.locator("#info").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Import…" }).click();
  await (await chooser).setFiles(file);
}

/**
 * Empties the library and the settings, as on a new iPad, but for the
 * first save's explanation, and opens the app again.
 *
 * @param {Page} page
 */
async function emptyLibrary(page) {
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("pdflion");
        open.onsuccess = () => {
          const stores = ["documents", "bytes", "thumbnails", "settings", "session"];
          const transaction = open.result.transaction(stores, "readwrite");
          for (const store of stores) transaction.objectStore(store).clear();
          transaction.objectStore("settings").put(true, "notInFilesExplained");
          transaction.oncomplete = () => {
            open.result.close();
            resolve(undefined);
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
  await page.reload();
  return homeFrame(page);
}

/**
 * @param {Page} page
 * @param {string} name
 * @returns {Promise<unknown>} a setting, as the library keeps it
 */
function readSetting(page, name) {
  return page.evaluate(
    (name) =>
      new Promise((resolve) => {
        const open = indexedDB.open("pdflion");
        open.onsuccess = () => {
          const get = open.result.transaction("settings").objectStore("settings").get(name);
          get.onsuccess = () => {
            open.result.close();
            resolve(get.result);
          };
        };
      }),
    name,
  );
}

/** @param {Page} page */
function thumbnailCount(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("pdflion");
        open.onsuccess = () => {
          const count = open.result.transaction("thumbnails").objectStore("thumbnails").count();
          count.onsuccess = () => {
            open.result.close();
            resolve(count.result);
          };
        };
      }),
  );
}

/**
 * Writes a backup as Export… writes one, of PDFs in `dir`.
 *
 * @param {string} dir
 * @param {{ name: string, pages: number, wrongCrc?: boolean }[]} documents
 * @returns {Promise<string>} the backup's path
 */
async function writeBackup(dir, documents) {
  const now = Date.now();
  /** @type {import("../../src/shared/zip.js").ZipInput[]} */
  const entries = [];
  /** @type {import("../../src/shared/backup.js").BackupDocument[]} */
  const records = [];
  for (const { name, pages, wrongCrc } of documents) {
    const file = path.join(dir, name);
    await writeLabelled(file, pages, name);
    const blob = new Blob([await fs.readFile(file)]);
    records.push({
      id: crypto.randomUUID(),
      name,
      size: blob.size,
      createdAt: now,
      openedAt: now,
      modifiedAt: now,
      revision: 0,
      exportedRevision: 0,
      source: "files",
      sha256: null,
      file: `Documents/${name}`,
      thumbnail: null,
    });
    entries.push({ name: `Documents/${name}`, blob, ...(wrongCrc ? { crc32: 12345 } : {}) });
  }
  const exported = { app: "1.0.500", platform: "web", at: new Date() };
  entries.unshift({ name: LIBRARY_FILE_NAME, blob: new Blob([writeLibraryFile(records, exported)]) });
  const zip = await writeZip(entries);
  const backup = path.join(dir, "PDFLion Backup 2026-11-01.zip");
  await fs.writeFile(backup, Buffer.from(await zip.arrayBuffer()));
  return backup;
}

test("Export hands over the settings, or every document with its thumbnail too, which Import brings back once", async ({
  page,
  dir,
}) => {
  const other = path.join(dir, "Other.pdf");
  await writeLabelled(other, 2);
  await openAppExplained(page);
  await openFromHome(page, [TRACEMONKEY, other]);
  await drawStroke(page, await documentFrame(page, "Other.pdf"));
  await page.locator("#tabs .tab").nth(1).click();
  await documentFrame(page, PAPER);
  await expect.poll(async () => (await readLibrary(page)).find((record) => record.name === "Other.pdf")?.revision).toBe(1);
  await expect.poll(() => thumbnailCount(page)).toBe(2);
  const home = await showHome(page);
  await home.locator("#info").click();
  await page.getByRole("menuitemcheckbox", { name: "Draw Only with a Pen" }).click();
  await stubShare(page, "share");

  // Settings only.
  await exportFromHome(page, "Settings Only");
  const settings = await sharedFile(page, 0);
  expect(settings).toMatchObject({ name: "PDFLion Settings.json", type: "application/json" });
  expect(readSettingsFile(settings.bytes.toString("utf8"))).toMatchObject({ settings: { penOnly: true } });

  // Everything.
  await exportFromHome(page, "Settings and Documents");
  const backup = await sharedFile(page, 1);
  expect(backup.name).toMatch(/^PDFLion Backup \d{4}-\d{2}-\d{2}\.zip$/);
  expect(backup.type).toBe("application/zip");
  const records = await readLibrary(page);
  const zip = new Blob([backup.bytes]);
  const entries = await readZip(zip);
  expect(entries.map((entry) => entry.name).sort()).toEqual(
    [
      "Documents/Other.pdf",
      `Documents/${PAPER}`,
      "Library.json",
      "PDFLion Settings.json",
      ...records.map((record) => `Thumbnails/${record.id}.png`),
    ].sort(),
  );
  const listing = /** @type {any} */ (
    readLibraryFile(
      new TextDecoder().decode(
        await (await readEntry(zip, /** @type {any} */ (entries.find((entry) => entry.name === "Library.json")))).arrayBuffer(),
      ),
    )
  );
  expect(listing.documents.map(({ id, revision, exportedRevision }) => ({ id, revision, exportedRevision })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    records.map(({ id, revision, exportedRevision }) => ({ id, revision, exportedRevision })).sort((a, b) => a.id.localeCompare(b.id)),
  );
  for (const record of records) {
    const entry = /** @type {any} */ (entries.find((other) => other.name === `Documents/${record.name}`));
    expect(Buffer.from(await (await readEntry(zip, entry)).arrayBuffer()).equals(await storedBytes(page, record.id))).toBe(true);
  }
  // A backup isn't the file in Files.
  expect((await readLibrary(page)).find((record) => record.name === "Other.pdf")?.exportedRevision).toBe(0);

  // Into an empty library, as on a new iPad.
  const file = path.join(dir, backup.name);
  await fs.writeFile(file, backup.bytes);
  await emptyLibrary(page);
  await importIntoHome(page, file);
  await expect(page.locator("dialog .message")).toHaveText(
    new RegExp(`^Import 2 documents \\(.+ MB\\) and the settings from “${backup.name}”\\?$`),
  );
  await expect(page.locator("dialog .detail")).toHaveText(
    "Your pen settings are replaced, and it has no favourites you don’t have yet.",
  );
  await page.locator("dialog").getByRole("button", { name: "Import" }).click();
  await expect(page.locator(".snackbar .text")).toHaveText("Imported 2 documents and the settings.");
  expect((await readLibrary(page)).map(({ id, name, revision, exportedRevision, source, createdAt }) => ({ id, name, revision, exportedRevision, source, createdAt }))).toEqual(
    records.map(({ id, name, revision, exportedRevision, source, createdAt }) => ({ id, name, revision, exportedRevision, source, createdAt })),
  );
  expect(await thumbnailCount(page)).toBe(2);
  expect(await readSetting(page, "toolSettings")).toMatchObject({ penOnly: true });
  const cards = (await homeFrame(page)).locator(".card");
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "Other.pdf" }).locator(".mark")).toHaveText(["Not in Files"]);
  await expect(cards.locator(".preview img")).toHaveCount(2);

  // Again, nothing.
  await importIntoHome(page, file);
  await expect(page.locator("dialog .message")).toHaveText(`There’s nothing to import from “${backup.name}”.`);
});

test("a document changed since the backup stays, and the backup's comes in as a copy", async ({ page, dir }) => {
  await openAppExplained(page);
  await openFromHome(page, [TRACEMONKEY]);
  const viewer = await documentFrame(page, PAPER);
  await stubShare(page, "share");
  await showHome(page);
  await exportFromHome(page, "Settings and Documents");
  const backup = await sharedFile(page, 0);
  const file = path.join(dir, backup.name);
  await fs.writeFile(file, backup.bytes);

  await page.locator("#tabs .tab").nth(1).click();
  await drawStroke(page, viewer);
  await expect.poll(async () => (await readLibrary(page))[0].revision).toBe(1);
  await showHome(page);
  await importIntoHome(page, file);
  await expect(page.locator("dialog .message")).toHaveText(
    new RegExp(`^Import one document \\(.+ MB\\) from “${backup.name}”\\?$`),
  );
  await expect(page.locator("dialog .detail")).toHaveText(
    "One of them has other changes here, which stay, and the backup’s comes in as a copy.",
  );
  await page.locator("dialog").getByRole("button", { name: "Import" }).click();
  await expect(page.locator(".snackbar .text")).toHaveText("Imported one document.");
  const records = await readLibrary(page);
  expect(records.map(({ name, revision }) => ({ name, revision })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: "compressed.tracemonkey-pldi-09 2.pdf", revision: 0 },
    { name: PAPER, revision: 1 },
  ]);
  expect(new Set(records.map((record) => record.id)).size).toBe(2);
});

test("a backup with a damaged document imports the others, and names that one", async ({ page, dir }) => {
  const backup = await writeBackup(dir, [
    { name: "Good.pdf", pages: 1 },
    { name: "Bad.pdf", pages: 2, wrongCrc: true },
  ]);
  await openApp(page);
  await importIntoHome(page, backup);
  await expect(page.locator("dialog .message")).toHaveText(/^Import 2 documents \(.+ kB\) from “PDFLion Backup 2026-11-01\.zip”\?$/);
  await page.locator("dialog").getByRole("button", { name: "Import" }).click();
  await expect(page.locator("dialog .message")).toHaveText("“Bad.pdf” couldn’t be imported.");
  await expect(page.locator("dialog .detail")).toHaveText("It’s missing or damaged in the backup.");
  expect((await readLibrary(page)).map((record) => record.name)).toEqual(["Good.pdf"]);
  await page.locator("dialog").getByRole("button", { name: "OK" }).click();
  await expect((await homeFrame(page)).locator(".card")).toHaveCount(1);
});

test("too little space is said before anything is stored", async ({ page, dir }) => {
  const backup = await writeBackup(dir, [{ name: "Good.pdf", pages: 1 }]);
  await openApp(page);
  // On the prototype: WebKit may make navigator.storage anew, without what
  // was set on it, once nothing holds it.
  await page.evaluate(() => {
    StorageManager.prototype.estimate = async () => ({ quota: 1_000_000, usage: 999_500 });
  });
  await importIntoHome(page, backup);
  await page.locator("dialog").getByRole("button", { name: "Import" }).click();
  await expect(page.locator("dialog .message")).toHaveText(
    "There isn’t enough space to import “PDFLion Backup 2026-11-01.zip”.",
  );
  await expect(page.locator("dialog .detail")).toHaveText(/^It needs .+ kB more\. /);
  expect(await readLibrary(page)).toEqual([]);
});

test("a settings file exported on the desktop imports, and what isn't one says so", async ({ page, dir }) => {
  const file = path.join(dir, "PDFLion Settings.json");
  const favourite = { tool: "ink", color: "#1e66f5", thickness: 2, opacity: 1 };
  await fs.writeFile(
    file,
    writeSettingsFile(
      {
        toolSettings: { eraser: { mode: "line", size: 30 }, penOnly: true, penOnlyChosen: true, favourites: [favourite] },
        automaticUpdates: true,
      },
      { app: "1.0.412", platform: "darwin", at: new Date() },
    ),
  );
  await openApp(page);
  await importIntoHome(page, file);
  await expect(page.locator("dialog .message")).toHaveText("Import the settings from “PDFLion Settings.json”?");
  await expect(page.locator("dialog .detail")).toHaveText(
    "Your eraser and pen settings are replaced, and its one favourite you don’t have yet is added after yours.",
  );
  await page.locator("dialog").getByRole("button", { name: "Import" }).click();
  await expect.poll(() => readSetting(page, "favourites")).toEqual([favourite]);
  expect(await readSetting(page, "toolSettings")).toMatchObject({ eraser: { mode: "line", size: 30 }, penOnly: true });

  const notSettings = path.join(dir, "notes.json");
  await fs.writeFile(notSettings, '{"hello": "world"}');
  await importIntoHome(page, notSettings);
  await expect(page.locator("dialog .message")).toHaveText("The settings in “notes.json” couldn’t be imported.");
  await page.locator("dialog").getByRole("button", { name: "OK" }).click();

  const notZip = path.join(dir, "Archive.zip");
  await fs.writeFile(notZip, "PK but not a ZIP");
  await importIntoHome(page, notZip);
  await expect(page.locator("dialog .message")).toHaveText("“Archive.zip” couldn’t be imported.");
  await expect(page.locator("dialog .detail")).toHaveText("It isn’t a PDFLion backup or settings file.");
});
