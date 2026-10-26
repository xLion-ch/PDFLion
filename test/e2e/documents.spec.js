import fs from "node:fs/promises";
import path from "node:path";
import {
  answerMessages,
  clickMenu,
  expect,
  isEdited,
  tempDir,
  test,
  tracemonkey,
} from "./pdflion.js";
import { writeForm } from "./pdfs.js";

/** @returns {Promise<string>} a new, empty one-field form */
async function newForm() {
  const file = path.join(await tempDir(), "form.pdf");
  await writeForm(file);
  return file;
}

test("saves form data into the file, and the edited marker follows", async ({ pdflion }) => {
  const file = await newForm();
  let { app, page } = await pdflion([file]);

  expect(await isEdited(app, page)).toBe(false);
  await page.locator(".annotationLayer input").fill("Ada Lovelace");
  await expect.poll(() => isEdited(app, page)).toBe(true);

  await clickMenu(app, page, "save");
  await expect.poll(() => isEdited(app, page)).toBe(false);
  await app.close();

  ({ app, page } = await pdflion([file]));
  await expect(page.locator(".annotationLayer input")).toHaveValue("Ada Lovelace");
  expect(await isEdited(app, page)).toBe(false);
});

test("Save As writes the document to the chosen file and shows its name", async ({ pdflion }) => {
  const dir = await tempDir();
  const file = await tracemonkey(dir);
  const copy = path.join(dir, "copy.pdf");
  const { app, page } = await pdflion([file]);
  await app.evaluate(({ dialog }, copy) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: copy });
  }, copy);

  await clickMenu(app, page, "saveAs");
  await expect(page).toHaveTitle("copy.pdf");
  expect(await fs.readFile(copy)).toEqual(await fs.readFile(file));
  if (process.platform === "darwin") {
    const win = await app.browserWindow(page);
    expect(await win.evaluate((win) => win.getRepresentedFilename())).toBe(copy);
  }
});

test("asks before closing an edited window", async ({ pdflion }) => {
  const { app, page } = await pdflion([await newForm()]);
  await page.locator(".annotationLayer input").fill("changed");
  await expect.poll(() => isEdited(app, page)).toBe(true);
  const win = await app.browserWindow(page);
  const messages = () => app.evaluate(() => globalThis.messages);

  await answerMessages(app, "Cancel");
  await win.evaluate((win) => win.close());
  await expect
    .poll(messages)
    .toEqual(["Do you want to save the changes made to the document “form.pdf”?"]);
  expect(page.isClosed()).toBe(false);

  await answerMessages(app, "Don’t Save");
  const closed = page.waitForEvent("close");
  await win.evaluate((win) => win.close());
  await closed;
});

test("asks before quitting with an edited window", async ({ pdflion }) => {
  const { app, page } = await pdflion([await newForm()]);
  await page.locator(".annotationLayer input").fill("changed");
  await expect.poll(() => isEdited(app, page)).toBe(true);

  await answerMessages(app, "Cancel");
  await app.evaluate(({ app }) => app.quit());
  await expect.poll(() => app.evaluate(() => globalThis.messages.length)).toBe(1);
  expect(page.isClosed()).toBe(false);

  await answerMessages(app, "Don’t Save");
  const quit = app.waitForEvent("close");
  await app.evaluate(({ app }) => app.quit()).catch(() => {}); // it may be gone before answering
  await quit;
});
