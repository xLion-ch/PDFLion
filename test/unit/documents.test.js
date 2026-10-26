import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  register,
  resolve,
  unregister,
  update,
  writeFileAtomic,
} from "../../src/main/documents.js";

const isWindows = process.platform === "win32";

/** Windows has a read-only flag where macOS has POSIX permissions. */
const posixOnly = isWindows && "needs POSIX permissions";

describe("documents", () => {
  it("resolves a registered token to its path", () => {
    const token = register("/Users/me/a.pdf");
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(resolve(token), "/Users/me/a.pdf");
  });

  it("gives each registration its own token", () => {
    assert.notEqual(register("/Users/me/b.pdf"), register("/Users/me/b.pdf"));
  });

  it("points a token at a new path", () => {
    const token = register("/Users/me/c.pdf");
    update(token, "/Users/me/renamed.pdf");
    assert.equal(resolve(token), "/Users/me/renamed.pdf");
  });

  it("doesn't resurrect unregistered tokens", () => {
    const token = register("/Users/me/d.pdf");
    unregister(token);
    update(token, "/Users/me/e.pdf");
    assert.equal(resolve(token), undefined);
  });

  it("knows no other tokens", () => {
    for (const token of ["", "nope", "__proto__", "constructor", "toString"]) {
      assert.equal(resolve(token), undefined);
    }
  });
});

describe("writeFileAtomic", () => {
  /** @type {string} */
  let dir;
  const bytes = (text) => new TextEncoder().encode(text);
  const read = (file) => fs.readFile(file, "utf8");
  const leftovers = async () => (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdflion-test-"));
  });

  after(async () => {
    await fs.chmod(dir, 0o755);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a new file", async () => {
    const file = path.join(dir, "new.pdf");
    await writeFileAtomic(file, bytes("new"));
    assert.equal(await read(file), "new");
    assert.deepEqual(await leftovers(), []);
  });

  it("replaces a file and keeps its permissions", { skip: posixOnly }, async () => {
    const file = path.join(dir, "existing.pdf");
    await fs.writeFile(file, "old");
    await fs.chmod(file, 0o640);
    await writeFileAtomic(file, bytes("new"));
    assert.equal(await read(file), "new");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
    assert.deepEqual(await leftovers(), []);
  });

  it("refuses a read-only file, though its directory is writable", async () => {
    const file = path.join(dir, "read-only.pdf");
    await fs.writeFile(file, "old");
    await fs.chmod(file, 0o444);
    try {
      await assert.rejects(writeFileAtomic(file, bytes("new")), {
        code: isWindows ? "EPERM" : "EACCES",
      });
      assert.equal(await read(file), "old");
      assert.deepEqual(await leftovers(), []);
    } finally {
      await fs.chmod(file, 0o644); // Windows won't delete a read-only file
    }
  });

  it("leaves the file intact when the write fails", { skip: posixOnly }, async () => {
    const locked = path.join(dir, "locked");
    await fs.mkdir(locked);
    const file = path.join(locked, "doc.pdf");
    await fs.writeFile(file, "old");
    await fs.chmod(locked, 0o555); // no new files, so no temporary file
    try {
      await assert.rejects(writeFileAtomic(file, bytes("new")), { code: "EACCES" });
      assert.equal(await read(file), "old");
      assert.deepEqual((await fs.readdir(locked)).sort(), ["doc.pdf"]);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });
});
