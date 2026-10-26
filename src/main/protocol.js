/**
 * The `pdflion://` scheme. Windows load everything from `pdflion://app/`: the
 * pdf.js generic viewer at `/viewer/`, `src/viewer/` at `/pdflion/`, and
 * opened documents at `/doc/<token>/<name>`. One origin for all of it keeps
 * the viewer's same-origin `file=` check happy.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import * as documents from "./documents.js";
import { pdflionRoot, viewerRoot } from "./paths.js";
import { SCHEME, docToken, resolveUrl } from "./routes.js";

const mounts = { viewer: viewerRoot, pdflion: pdflionRoot };
const viewerHtml = path.join(viewerRoot, "web", "viewer.html");

/**
 * Sent with viewer.html. The `<meta>` CSP in pdf.js's viewer.html stays, and
 * Chromium enforces both, so this mirrors that policy. The one difference is
 * connect-src: pdf.js allows `*`, but documents only ever come from our origin.
 */
const VIEWER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Extensions Chromium has no mapping for. It sniffs their content instead, so
 * a `.bcmap` or `.pfb` can come back as `text/plain`.
 * @type {Record<string, string>}
 */
const CONTENT_TYPES = {
  ".ftl": "text/plain; charset=utf-8",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".icc": "application/octet-stream",
};

/** Must run before the app is ready. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Must run once the app is ready, before any window loads. */
export function handleProtocol() {
  protocol.handle(SCHEME, serve);
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function serve(request) {
  const token = docToken(request.url);
  if (token) {
    const file = documents.resolve(token);
    // Whatever the extension, it was opened as a PDF.
    return file ? serveFile(file, { "Content-Type": "application/pdf" }) : notFound();
  }

  const file = resolveUrl(request.url, mounts);
  if (!file) return notFound();

  /** @type {Record<string, string>} */
  const headers = {};
  const type = CONTENT_TYPES[path.extname(file)];
  if (type) headers["Content-Type"] = type;
  if (file === viewerHtml) headers["Content-Security-Policy"] = VIEWER_CSP;
  return serveFile(file, headers);
}

/**
 * @param {string} file absolute path
 * @param {Record<string, string>} overrides headers to set on top of Chromium's
 * @returns {Promise<Response>}
 */
async function serveFile(file, overrides) {
  let response;
  try {
    response = await net.fetch(pathToFileURL(file).href);
  } catch {
    return notFound(); // missing, unreadable, or a directory
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(overrides)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
