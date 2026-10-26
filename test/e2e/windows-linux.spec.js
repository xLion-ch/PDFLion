import { spawn } from "node:child_process";
import electronPath from "electron";
import { ROOT, expect, rendered, tempDir, test, tracemonkey } from "./pdflion.js";

test.skip(process.platform === "darwin", "Windows and Linux behaviour");

test("quits when its last window closes", async ({ pdflion }) => {
  const { app, page } = await pdflion([await tracemonkey(await tempDir())]);
  const quit = app.waitForEvent("close");
  const win = await app.browserWindow(page);
  await win.evaluate((win) => win.close());
  await quit;
});

test("hands a file opened while it runs to the running process", async ({ pdflion }) => {
  const dir = await tempDir();
  const first = await tracemonkey(dir, "first.pdf");
  const second = await tracemonkey(dir, "second.pdf");
  const { app, userData } = await pdflion([first]);

  // What Explorer and Linux file managers do: start another PDFLion with the
  // file. It shares the userData folder, and with it the single-instance lock.
  const nextWindow = app.waitForEvent("window");
  const other = spawn(/** @type {string} */ (/** @type {unknown} */ (electronPath)), [
    ROOT,
    `--user-data-dir=${userData}`,
    second,
  ]);
  const exitCode = await new Promise((resolve) => other.on("exit", resolve));
  expect(exitCode).toBe(0);

  const page = await nextWindow;
  await rendered(page);
  await expect(page).toHaveTitle("second.pdf");
  expect(app.windows()).toHaveLength(2);
});
