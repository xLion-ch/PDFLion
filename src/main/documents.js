/**
 * Registry of the files the user opened, and writing them back. The renderer
 * only ever sees a token, an unguessable stand-in for the path, so
 * `pdflion://app/doc/<token>/` can serve nothing but files the user chose.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** @type {Map<string, string>} token -> absolute path */
const files = new Map();

/**
 * @param {string} file absolute path
 * @returns {string} a new token for it
 */
export function register(file) {
  const token = randomUUID();
  files.set(token, file);
  return token;
}

/**
 * @param {string} token
 * @returns {string | undefined} the path, or undefined for an unknown token
 */
export function resolve(token) {
  return files.get(token);
}

/**
 * Points a token at another file, after Save As.
 * @param {string} token
 * @param {string} file absolute path
 */
export function update(token, file) {
  if (files.has(token)) files.set(token, file);
}

/**
 * Forgets a token, after which its URL returns 404.
 * @param {string} token
 */
export function unregister(token) {
  files.delete(token);
}

/**
 * Writes `bytes` to `file` atomically: into a temporary file in the same
 * directory, which then replaces `file`. A failure leaves an existing file as
 * it was. The new file keeps the old one's permissions.
 *
 * Replacing a file needs write access to its directory, not to the file, so
 * this refuses a file the user can't write rather than replace it.
 *
 * @param {string} file absolute path
 * @param {Uint8Array} bytes
 */
export async function writeFileAtomic(file, bytes) {
  const existing = await fs.stat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) await fs.access(file, fs.constants.W_OK);

  const temp = path.join(path.dirname(file), `.pdflion-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, "wx");
    try {
      await handle.writeFile(bytes);
      if (existing) await handle.chmod(existing.mode & 0o7777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}
