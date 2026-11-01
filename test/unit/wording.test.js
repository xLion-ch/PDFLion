import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  backupError,
  closeUnsavedPrompt,
  documentsNotImported,
  exportError,
  exportProgress,
  exportPrompt,
  formatSize,
  importBackupPrompt,
  importProgress,
  importedNow,
  notEnoughSpace,
  nothingInBackup,
  closedNotInFiles,
  deletePrompt,
  importSettingsPrompt,
  isPageDialog,
  missingRecent,
  notAPdf,
  notInFilesExplanation,
  notInFilesLabel,
  nothingToImport,
  openError,
  pageDialog,
  renamePrompt,
  saveError,
  savePrompt,
  savedNotInFiles,
  savedNow,
  settingsExportError,
  settingsFileError,
  shareError,
  shareReady,
  updateCheckFailed,
  updateDownloadFailed,
  updateNotInstallable,
  updateNotInstalled,
  updateOnReadOnlyVolume,
  updateReady,
  upToDate,
  restartUnsavedPrompt,
  webAppNotDownloaded,
  webAppUnavailable,
  webUpdateReady,
} from "../../src/shared/wording.js";

describe("wording isPageDialog", () => {
  it("takes every reason, without items but for rewrite", () => {
    for (const reason of ["locked-encrypted", "locked-xfa", "failed", "signed"]) {
      assert.ok(isPageDialog(reason, undefined), reason);
      assert.ok(!isPageDialog(reason, ["xmp"]), `${reason} with items`);
    }
  });

  it("takes rewrite with known, distinct items", () => {
    assert.ok(isPageDialog("rewrite", ["xmp"]));
    assert.ok(
      isPageDialog("rewrite", [
        "xmp",
        "layers",
        "scripts",
        "viewer-settings",
        "tagging",
        "language",
        "info",
        "page-labels",
      ]),
    );
  });

  for (const [description, reason, items] of [
    ["an unknown reason", "format-disk", undefined],
    ["a reason from Object's prototype", "toString", undefined],
    ["a reason that isn't a string", 1, undefined],
    ["rewrite without items", "rewrite", undefined],
    ["rewrite with no items", "rewrite", []],
    ["rewrite with an unknown item", "rewrite", ["xmp", "everything"]],
    ["rewrite with an item from Object's prototype", "rewrite", ["constructor"]],
    ["rewrite with a repeated item", "rewrite", ["xmp", "xmp"]],
    ["rewrite with items that aren't a list", "rewrite", "xmp"],
  ]) {
    it(`refuses ${description}`, () => {
      assert.ok(!isPageDialog(reason, items));
    });
  }
});

describe("wording pageDialog", () => {
  it("words the alerts, which have OK alone", () => {
    assert.deepEqual(pageDialog("locked-encrypted", "a.pdf"), {
      message: "The pages of the document “a.pdf” can’t be changed.",
      detail: "The document is protected with a password.",
      confirm: undefined,
      cancelByDefault: false,
    });
    assert.equal(
      pageDialog("locked-xfa", "a.pdf").detail,
      "The document is an XFA form, which PDFLion can’t change pages of.",
    );
    assert.deepEqual(pageDialog("failed", "a.pdf"), {
      message: "The pages of the document “a.pdf” couldn’t be changed.",
      detail: "PDFLion can’t read the document well enough. It’s unchanged.",
      confirm: undefined,
      cancelByDefault: false,
    });
  });

  it("words the prompts, with the button that goes ahead", () => {
    assert.deepEqual(pageDialog("signed", "a.pdf"), {
      message: "Changing pages invalidates the signatures in “a.pdf”.",
      detail: "Checking them will show that the document changed after it was signed.",
      confirm: "Change Pages",
      cancelByDefault: true,
    });
    assert.deepEqual(pageDialog("rewrite", "a.pdf", ["xmp", "info", "page-labels"]), {
      message: "Saving removes some information from “a.pdf”.",
      detail:
        "Saving the changed pages removes its XMP metadata, its title, author, subject and keywords, and its page labels.",
      confirm: "Save",
      cancelByDefault: false,
    });
  });
});

describe("wording saving and opening", () => {
  it("asks before changes are lost", () => {
    assert.deepEqual(savePrompt("a.pdf"), {
      message: "Do you want to save the changes made to the document “a.pdf”?",
      detail: "Your changes will be lost if you don’t save them.",
    });
  });

  it("says why a save failed, by the error's code", () => {
    assert.deepEqual(saveError("a.pdf", { code: "ENOSPC", message: "no space left" }), {
      message: "The document “a.pdf” could not be saved.",
      detail: "There isn’t enough space on the disk.",
    });
    assert.equal(
      saveError("a.pdf", { code: "EPERM", message: "" }).detail,
      "You don’t have permission to save the file.",
    );
  });

  it("says when the browser's storage is full", () => {
    assert.equal(
      saveError("a.pdf", { code: "QuotaExceededError", message: "" }).detail,
      "There isn’t enough space on this device.",
    );
  });

  it("gives the error's own message for other codes", () => {
    for (const code of ["EIO", "constructor", undefined]) {
      assert.equal(saveError("a.pdf", { code, message: "it broke" }).detail, "it broke", code);
    }
  });

  it("says why a file couldn't be opened, or gives the error's message", () => {
    assert.deepEqual(openError("a.pdf", { code: "ENOENT", message: "ENOENT: …" }), {
      message: "The file “a.pdf” couldn’t be opened because there is no such file.",
    });
    assert.deepEqual(openError("a.pdf", { code: "EISDIR", message: "" }), {
      message: "The file “a.pdf” couldn’t be opened because it isn’t a file.",
    });
    assert.deepEqual(openError("a.pdf", { code: "toString", message: "it broke" }), {
      message: "The file “a.pdf” couldn’t be opened.",
      detail: "it broke",
    });
  });
});

describe("wording Home", () => {
  it("offers to remove a recent document whose file is gone", () => {
    assert.deepEqual(missingRecent("a.pdf"), {
      message: "The file “a.pdf” couldn’t be opened because there is no such file.",
      detail:
        "It may have been moved, renamed or deleted. Do you want to remove it from the recent documents?",
    });
  });
});

describe("wording the web app's copies", () => {
  it("labels a document that isn't in Files, or never was", () => {
    assert.equal(notInFilesLabel(false), "Not in Files");
    assert.equal(notInFilesLabel(true), "Only in PDFLion");
  });

  it("says once that a save went into PDFLion, and the first time what that means", () => {
    assert.equal(savedNotInFiles(false), "Saved in PDFLion. The file in Files hasn’t changed.");
    assert.equal(savedNotInFiles(true), "Saved in PDFLion. To keep it in Files too, share it.");
    assert.equal(notInFilesExplanation("a.pdf", false).message, "Your changes to “a.pdf” are saved in PDFLion.");
    assert.match(notInFilesExplanation("a.pdf", false).detail ?? "", /The file in Files stays as it was/);
    assert.equal(notInFilesExplanation("a.pdf", true).message, "“a.pdf” is saved in PDFLion.");
  });

  it("says where a closed or saved document is", () => {
    assert.equal(closedNotInFiles("a.pdf", false), "“a.pdf” is saved in PDFLion, not in Files.");
    assert.equal(closedNotInFiles("a.pdf", true), "“a.pdf” is saved only in PDFLion.");
    assert.equal(savedNow("a.pdf"), "“a.pdf” is saved in PDFLion.");
    assert.deepEqual(closeUnsavedPrompt("a.pdf"), {
      message: "The changes to “a.pdf” couldn’t be saved.",
      detail: "If you close the document, they’re lost.",
    });
  });

  it("says what deleting a document loses", () => {
    assert.equal(deletePrompt("a.pdf", { notInFiles: false, made: false }).message, "Delete “a.pdf” from PDFLion?");
    assert.equal(
      deletePrompt("a.pdf", { notInFiles: false, made: false }).detail,
      "The file in Files stays as it is.",
    );
    assert.match(deletePrompt("a.pdf", { notInFiles: true, made: false }).detail ?? "", /changes you made in PDFLion are lost/);
    assert.match(deletePrompt("a.pdf", { notInFiles: true, made: true }).detail ?? "", /gone for good/);
  });

  it("words renaming, sharing and what can't be opened", () => {
    assert.deepEqual(renamePrompt("a.pdf"), { message: "Rename “a.pdf”" });
    assert.deepEqual(shareReady("a.pdf"), { message: "“a.pdf” is ready to share." });
    assert.deepEqual(shareError("a.pdf", { message: "no" }), {
      message: "“a.pdf” couldn’t be shared.",
      detail: "no",
    });
    assert.deepEqual(notAPdf("a.txt"), {
      message: "The file “a.txt” couldn’t be opened.",
      detail: "It isn’t a PDF document.",
    });
    assert.match(webAppUnavailable("No service workers.").detail ?? "", /No service workers\.$/);
  });
});

describe("wording settings", () => {
  it("says what an import replaces and adds", () => {
    const name = "PDFLion Settings.json";
    const all = ["eraser", "penOnly", "automaticUpdates"];
    assert.deepEqual(
      importSettingsPrompt(name, { replaced: all, added: 12 }),
      {
        message: "Import the settings from “PDFLion Settings.json”?",
        detail:
          "Your eraser, pen, and update settings are replaced, and its 12 favourites you don’t have yet are added after yours.",
      },
    );
    assert.equal(
      importSettingsPrompt(name, { replaced: ["eraser", "penOnly"], added: 1 }).detail,
      "Your eraser and pen settings are replaced, and its one favourite you don’t have yet is added after yours.",
    );
    assert.equal(
      importSettingsPrompt(name, { replaced: ["eraser"], added: 0 }).detail,
      "Your eraser settings are replaced, and it has no favourites you don’t have yet.",
    );
    assert.equal(
      importSettingsPrompt(name, { replaced: [], added: 3 }).detail,
      "Its 3 favourites you don’t have yet are added after yours.",
    );
  });

  it("says when there's nothing to import", () => {
    assert.deepEqual(nothingToImport("a.json"), {
      message: "There’s nothing to import from “a.json”.",
      detail: "It has no settings, and no favourites you don’t have yet.",
    });
  });

  it("says why a file couldn't be imported or written", () => {
    assert.deepEqual(settingsFileError("a.json", "not-settings"), {
      message: "The settings in “a.json” couldn’t be imported.",
      detail: "It isn’t a PDFLion settings file.",
    });
    assert.equal(
      settingsFileError("a.json", "newer").detail,
      "They come from a newer version of PDFLion. Update PDFLion, and try again.",
    );
    assert.equal(
      settingsFileError("a.json", "too-large").detail,
      "The file is larger than a settings file can be.",
    );
    assert.deepEqual(settingsExportError("a.json", { code: "EROFS", message: "" }), {
      message: "The settings couldn’t be exported to “a.json”.",
      detail: "The volume is read-only.",
    });
  });
});

describe("wording updates", () => {
  const mac = { checkForUpdates: "PDFLion > Check for Updates…", needsPassword: false };
  const linux = { checkForUpdates: "Help > Check for Updates…", needsPassword: true };

  it("words the checks", () => {
    assert.deepEqual(updateCheckFailed(), {
      message: "PDFLion couldn’t check for updates.",
      detail: "Check your internet connection, and try again later.",
    });
    assert.deepEqual(upToDate("1.0.7"), {
      message: "PDFLion is up to date.",
      detail: "PDFLion 1.0.7 is the latest version.",
    });
    assert.deepEqual(updateDownloadFailed("1.0.8"), {
      message: "PDFLion 1.0.8 couldn’t be downloaded.",
      detail: "Try again later.",
    });
  });

  it("names where Check for Updates… is", () => {
    assert.deepEqual(updateOnReadOnlyVolume("1.0.8", mac), {
      message: "PDFLion 1.0.8 can’t be installed here.",
      detail:
        "PDFLion can’t update itself while it runs from a disk image or from Downloads. Move it to the Applications folder, open it from there, and choose PDFLion > Check for Updates… again.",
    });
    assert.deepEqual(updateNotInstallable("1.0.8"), {
      message: "PDFLion 1.0.8 can’t be installed.",
      detail: "Download it from PDFLion’s releases on GitHub instead.",
    });
  });

  it("says when an update installs, and that Linux asks for a password", () => {
    assert.deepEqual(updateReady("1.0.8", mac), {
      message: "PDFLion 1.0.8 is ready to install.",
      detail: "It installs when PDFLion quits.",
    });
    assert.equal(
      updateReady("1.0.8", linux).detail,
      "Installing it asks for an administrator’s password. Help > Check for Updates… offers it again later.",
    );
    assert.deepEqual(updateNotInstalled("1.0.8", mac), {
      message: "PDFLion 1.0.8 wasn’t installed.",
      detail: "PDFLion > Check for Updates… offers it again.",
    });
    assert.equal(
      updateNotInstalled("1.0.8", linux).detail,
      "Installing it needs an administrator’s password. Help > Check for Updates… offers it again.",
    );
  });

  it("says when the web app's update starts, and what a restart loses", () => {
    assert.deepEqual(webUpdateReady("1.0.8"), {
      message: "PDFLion 1.0.8 is ready.",
      detail:
        "Restart PDFLion to use it: your documents are saved first, and your tabs come back. Otherwise it starts the next time you open PDFLion.",
    });
    assert.equal(webUpdateReady(null).message, "A new version of PDFLion is ready.");
    assert.deepEqual(webAppNotDownloaded(), {
      message: "PDFLion couldn’t be downloaded.",
      detail: "Check your internet connection, and reload the page.",
    });
    assert.deepEqual(restartUnsavedPrompt("A.pdf"), {
      message: "The changes to “A.pdf” couldn’t be saved.",
      detail: "If PDFLion restarts now, they’re lost.",
    });
  });
});

describe("wording for the web app's backups", () => {
  it("gives sizes in decimal units, as Files does", () => {
    assert.equal(formatSize(512), "0.5 kB");
    assert.equal(formatSize(1_234_567), "1.2 MB");
    assert.equal(formatSize(2_500_000_000), "2.5 GB");
  });

  it("asks what to export, and says how it goes", () => {
    assert.deepEqual(exportPrompt(23, 1_200_000_000), {
      message: "What do you want to export?",
      detail:
        "The settings are your favourites, and the eraser and pen settings. With the documents, the backup also has the 23 documents PDFLion keeps (1.2 GB), and brings them back on this device or another.",
    });
    assert.match(exportPrompt(1, 1000).detail ?? "", /has the document PDFLion keeps \(1 kB\)/);
    assert.equal(exportProgress(45), "Preparing the backup… 45%");
    assert.deepEqual(exportError({ message: "Disk full" }), { message: "The backup couldn’t be made.", detail: "Disk full" });
    assert.equal(importProgress(3, 23), "Importing 3 of 23 documents…");
    assert.equal(importProgress(1, 1), "Importing the document…");
  });

  it("says what a backup brings, before it's imported", () => {
    assert.deepEqual(
      importBackupPrompt("B.zip", {
        documents: 23,
        bytes: 1_200_000_000,
        here: 4,
        copies: 1,
        settings: { replaced: ["eraser", "penOnly"], added: 12 },
      }),
      {
        message: "Import 23 documents (1.2 GB) and the settings from “B.zip”?",
        detail:
          "One of them has other changes here, which stay, and the backup’s comes in as a copy. 4 other documents in it are here already, as they are. Your eraser and pen settings are replaced, and its 12 favourites you don’t have yet are added after yours.",
      },
    );
    assert.deepEqual(importBackupPrompt("B.zip", { documents: 1, bytes: 1000, here: 1, copies: 2, settings: null }), {
      message: "Import one document (1 kB) from “B.zip”?",
      detail:
        "2 of them have other changes here, which stay, and the backup’s come in as copies. Another document in it is here already, as it is.",
    });
    assert.equal(
      importBackupPrompt("B.zip", { documents: 0, bytes: 0, here: 3, copies: 0, settings: { replaced: [], added: 1 } }).message,
      "Import the settings from “B.zip”?",
    );
  });

  it("says why a backup or its documents couldn't be imported", () => {
    assert.equal(nothingInBackup("B.zip").message, "There’s nothing to import from “B.zip”.");
    assert.deepEqual(notEnoughSpace("B.zip", 2_000_000), {
      message: "There isn’t enough space to import “B.zip”.",
      detail: "It needs 2 MB more. Delete documents you don’t need, or free space on the device, and try again.",
    });
    assert.match(notEnoughSpace("B.zip", null).detail ?? "", /^It needs more space\. /);
    assert.deepEqual(backupError("B.zip", "not-backup"), {
      message: "“B.zip” couldn’t be imported.",
      detail: "It isn’t a PDFLion backup or settings file.",
    });
    for (const reason of /** @type {const} */ (["damaged", "newer", "too-large"])) {
      assert.ok(backupError("B.zip", reason).detail, reason);
    }
    assert.deepEqual(documentsNotImported(["A.pdf", "B.pdf", "C.pdf"]), {
      message: "3 documents couldn’t be imported.",
      detail: "They’re missing or damaged in the backup: “A.pdf”, “B.pdf”, and “C.pdf”.",
    });
    assert.equal(importedNow(2, true), "Imported 2 documents and the settings.");
    assert.equal(importedNow(1, false), "Imported one document.");
    assert.equal(importedNow(0, true), "The settings are imported.");
  });
});
