/**
 * The URL layout of `pdflion://app/`: mounts at `/<mount>/<path>` map to files
 * below each mount's root, `/doc/<token>/<name>` names an opened document, and
 * `/thumb/<id>.png` a recent document's thumbnail. Each window shows the tab
 * strip, and each of its tabs the viewer or Home.
 * Kept free of Electron imports so the unit tests can run it under plain Node.
 */
import path from "node:path";

export const SCHEME = "pdflion";
export const ORIGIN = `${SCHEME}://app`;

/** The page every tab loads, followed by `?file=…`. */
export const VIEWER_URL = `${ORIGIN}/viewer/web/viewer.html`;

/** The page every window loads: its tab strip. */
export const TABS_URL = `${ORIGIN}/tabs/tabs.html`;

/** The page a home tab loads. */
export const HOME_URL = `${ORIGIN}/home/home.html`;

/**
 * The viewer URL for an opened document. `name` sits in the path so pdf.js
 * derives a sensible title and download name from it. pdf.js decodes `file`
 * once and resolves it against the viewer URL, so it stays same-origin.
 *
 * @param {string} token from the documents registry
 * @param {string} name file name, e.g. `Report #2.pdf`
 * @returns {string}
 */
export function viewerUrl(token, name) {
  const params = new URLSearchParams({ file: docPath(token, name) });
  return `${VIEWER_URL}?${params}`;
}

/**
 * The path of an opened document, as pdf.js's `PDFViewerApplication.url`
 * holds it after decoding the viewer URL's `file` parameter.
 *
 * @param {string} token from the documents registry
 * @param {string} name file name
 * @returns {string}
 */
export function docPath(token, name) {
  return `/doc/${token}/${encodeURIComponent(name)}`;
}

/**
 * Whether `url` is the viewer page, whatever its query and fragment.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isViewerUrl(url) {
  return appPathname(url) === new URL(VIEWER_URL).pathname;
}

/**
 * Whether `url` is the tab strip, whatever its query and fragment.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isTabsUrl(url) {
  return appPathname(url) === new URL(TABS_URL).pathname;
}

/**
 * Whether `url` is Home, whatever its query and fragment.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isHomeUrl(url) {
  return appPathname(url) === new URL(HOME_URL).pathname;
}

/**
 * The URL of a recent document's thumbnail, which changes when it's written
 * again, so that Home loads it afresh.
 *
 * @param {string} id the recent document's
 * @param {number} version when the thumbnail was written, in ms
 * @returns {string}
 */
export function thumbnailUrl(id, version) {
  return `${ORIGIN}/thumb/${id}.png?v=${version}`;
}

/**
 * Returns the id of a `/thumb/<id>.png` URL, or null for any other URL. The
 * id must have the form of a recent document's: see recentlist.js.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function thumbnailId(url) {
  return /^\/thumb\/([0-9a-f-]{36})\.png$/.exec(appPathname(url) ?? "")?.[1] ?? null;
}

/**
 * Returns the token of a `/doc/<token>/<name>` URL, or null for any other URL.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function docToken(url) {
  return /^\/doc\/([^/]+)\/[^/]+$/.exec(appPathname(url) ?? "")?.[1] ?? null;
}

/**
 * Returns the file a URL names, or null if it names no mount or escapes the
 * mount's root. URL parsing has already collapsed `..` and `%2e%2e` segments.
 *
 * @param {string} url e.g. `pdflion://app/viewer/web/viewer.html?file=`
 * @param {Record<string, string>} mounts first path segment -> absolute root
 * @returns {string | null}
 */
export function resolveUrl(url, mounts) {
  const [, mount, rest] = /^\/([^/]+)\/(.+)$/.exec(appPathname(url) ?? "") ?? [];
  if (!rest || !Object.hasOwn(mounts, mount)) return null;
  return resolveInside(mounts[mount], rest);
}

/**
 * Resolves a percent-encoded relative path against `root`. Returns null if the
 * decoded path leaves `root`, e.g. through `..%2F`, which URL parsing leaves
 * encoded, or on Windows through `..%5C`, a drive letter or a UNC path.
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

/**
 * @param {string} url
 * @returns {string | null} the still percent-encoded path, if `url` is ours
 */
function appPathname(url) {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== `${SCHEME}:` || parsed.host !== "app") return null;
  return parsed.pathname;
}
