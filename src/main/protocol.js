/**
 * The `pdflion://` scheme. Windows load everything from `pdflion://app/`: the
 * pdf.js generic viewer at `/viewer/`, `src/viewer/` at `/pdflion/`, and
 * opened documents at `/doc/<token>/<name>`, whole or in byte ranges. One
 * origin for all of it keeps the viewer's same-origin `file=` check happy.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import * as documents from "./documents.js";
import { pdflionRoot, viewerRoot } from "./paths.js";
import { answerRange } from "./ranges.js";
import { SCHEME, docToken, resolveUrl } from "./routes.js";

/** Read size for documents. Larger than Node's 64 KiB, for fewer, bigger chunks to the viewer. */
const DOCUMENT_CHUNK_SIZE = 1024 * 1024;

const mounts = { viewer: viewerRoot, pdflion: pdflionRoot };
const viewerHtml = path.join(viewerRoot, "web", "viewer.html");

/**
 * Added before `</head>` of viewer.html. The classic bridge.js runs before the
 * viewer's deferred module scripts, and overrides.css comes after viewer.css.
 */
const VIEWER_INJECTION =
  '<link rel="stylesheet" href="/pdflion/overrides.css"><script src="/pdflion/bridge.js"></script>';

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
    return file ? serveDocument(request, file) : notFound();
  }

  const file = resolveUrl(request.url, mounts);
  if (!file) return notFound();
  if (file === viewerHtml) return serveViewerHtml();

  const type = CONTENT_TYPES[path.extname(file)];
  return serveFile(file, type ? { "Content-Type": type } : {});
}

/** @returns {Promise<Response>} viewer.html with PDFLion's additions */
async function serveViewerHtml() {
  const html = await fs.readFile(viewerHtml, "utf8");
  if (!html.includes("</head>")) {
    throw new Error(`No </head> in ${viewerHtml} to inject bridge.js before`);
  }
  return new Response(html.replace("</head>", `${VIEWER_INJECTION}</head>`), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": VIEWER_CSP,
    },
  });
}

/**
 * Serves an opened document, whole or a byte range of it. The `ETag` changes
 * when the file is replaced or written, and a request whose `If-Match` names
 * an older one gets 412, so that bridge.js never mixes parts of two versions.
 *
 * @param {Request} request
 * @param {string} file absolute path
 * @returns {Promise<Response>}
 */
async function serveDocument(request, file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return notFound(); // moved, deleted or no longer readable
  }

  /** @type {ReadableStream | null} */
  let body = null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return notFound();
    const headers = new Headers({
      // Whatever the extension, it was opened as a PDF.
      "Content-Type": "application/pdf",
      "Accept-Ranges": "bytes",
      ETag: `"${stats.ino}-${stats.size}-${stats.mtimeMs}"`,
    });

    // bridge.js sends exactly the ETag it got.
    const ifMatch = request.headers.get("If-Match");
    if (ifMatch !== null && ifMatch !== headers.get("ETag")) {
      return new Response(null, { status: 412, headers });
    }

    const range = answerRange(request.headers.get("Range"), stats.size);
    if (range.status === 416) {
      headers.set("Content-Range", `bytes */${stats.size}`);
      return new Response(null, { status: 416, headers });
    }

    const { start, end } = range.status === 206 ? range : { start: 0, end: stats.size - 1 };
    headers.set("Content-Length", String(end - start + 1));
    if (range.status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${stats.size}`);
    if (stats.size > 0) {
      // Closes the file once read, or once the viewer cancels the request.
      const stream = handle.createReadStream({ start, end, highWaterMark: DOCUMENT_CHUNK_SIZE });
      body = /** @type {ReadableStream} */ (Readable.toWeb(stream));
    }
    return new Response(body, { status: range.status, headers });
  } finally {
    if (!body) await handle.close();
  }
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
