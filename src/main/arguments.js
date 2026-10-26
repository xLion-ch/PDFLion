/**
 * The files a launch asks PDFLion to open, from its command line or, on
 * Windows and Linux, from a second process's. They come as paths, or on Linux
 * as `file://` URIs from file managers and `gio open`.
 * Kept free of Electron imports so the unit tests can run it under plain Node.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A URI scheme followed by `//`. A Windows drive letter (`C:\`) has no `//`,
 * and a file name with a colon rarely starts like this.
 */
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Files named on the command line, as in `npm start -- file.pdf`, or the file
 * Explorer or a Linux file manager opens with PDFLion. Under `electron .` the
 * first two arguments are Electron and the app path, otherwise just the app.
 * Flags, and URIs other than `file://`, are dropped.
 *
 * @param {string[]} argv `process.argv`
 * @param {{ defaultApp: boolean, cwd: string }} options defaultApp:
 *   `process.defaultApp`, true under `electron .`; cwd: what relative paths
 *   resolve against
 * @returns {string[]} absolute paths
 */
export function commandLineFiles(argv, { defaultApp, cwd }) {
  return argv
    .slice(defaultApp ? 2 : 1)
    .filter((arg) => !arg.startsWith("-"))
    .map((arg) => (URI_RE.test(arg) ? filePath(arg) : path.resolve(cwd, arg)))
    .filter((file) => file !== null);
}

/**
 * @param {unknown} data what a second instance passed to
 *   requestSingleInstanceLock(): `{ files }`, from its commandLineFiles()
 * @returns {string[]} the files on its command line, as absolute paths
 */
export function secondInstanceFiles(data) {
  const files = /** @type {{ files?: unknown } | null} */ (data)?.files;
  if (!Array.isArray(files)) return [];
  return files
    .filter((file) => typeof file === "string")
    .map((file) => (URI_RE.test(file) ? filePath(file) : file))
    .filter((file) => file !== null && path.isAbsolute(file));
}

/**
 * @param {string} uri
 * @returns {string | null} the path of a `file://` URI, or null for any other
 *   URI, or one that names no local file
 */
function filePath(uri) {
  const url = URL.parse(uri);
  if (url?.protocol !== "file:") return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null; // a host other than localhost, or an encoded slash
  }
}
