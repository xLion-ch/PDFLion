/**
 * Registry of the files the user opened. The renderer only ever sees a token,
 * an unguessable stand-in for the path, so `pdflion://app/doc/<token>/` can
 * serve nothing but files the user chose.
 */
import { randomUUID } from "node:crypto";

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
 * Forgets a token, after which its URL returns 404.
 * @param {string} token
 */
export function unregister(token) {
  files.delete(token);
}
