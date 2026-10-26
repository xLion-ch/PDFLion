/**
 * Maps `pdflion://app/<mount>/<path>` URLs to files below each mount's root.
 * Kept free of Electron imports so the unit tests can run it under plain Node.
 */
import path from "node:path";

export const SCHEME = "pdflion";
export const ORIGIN = `${SCHEME}://app`;

/**
 * Returns the file a URL names, or null if it names no mount or escapes the
 * mount's root. URL parsing has already collapsed `..` and `%2e%2e` segments.
 *
 * @param {string} url e.g. `pdflion://app/viewer/web/viewer.html?file=`
 * @param {Record<string, string>} mounts first path segment -> absolute root
 * @returns {string | null}
 */
export function resolveUrl(url, mounts) {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== `${SCHEME}:` || parsed.host !== "app") return null;
  const [, mount, rest] = /^\/([^/]+)\/(.+)$/.exec(parsed.pathname) ?? [];
  if (!rest || !Object.hasOwn(mounts, mount)) return null;
  return resolveInside(mounts[mount], rest);
}

/**
 * Resolves a percent-encoded relative path against `root`. Returns null if the
 * decoded path leaves `root`, e.g. through `..%2F`, which URL parsing leaves
 * encoded.
 *
 * @param {string} root absolute directory
 * @param {string} encodedPath
 * @returns {string | null}
 */
export function resolveInside(root, encodedPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return null; // malformed escape such as "%E0%A4%A"
  }
  if (decoded.includes("\0")) return null;

  const file = path.resolve(root, decoded);
  const relative = path.relative(root, file);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return file;
}
