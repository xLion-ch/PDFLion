/**
 * The Content Security Policies of PDFLion's pages. The desktop's
 * src/main/protocol.js sends them as headers, and scripts/build-web.js puts
 * the web app's into `<meta>` tags, since GitHub Pages sends no headers of
 * its own.
 * Free of Electron and Node, in src/shared/, so that the web build can use it
 * too, and unit tests under plain Node.
 */

/**
 * The viewer's. The `<meta>` CSP in pdf.js's viewer.html stays, and browsers
 * enforce both, so this mirrors that policy. The one difference is
 * connect-src: pdf.js allows `*`, but documents only ever come from PDFLion's
 * own origin.
 */
export const VIEWER_CSP = [
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
 * The desktop's tab strip and Home. They need nothing but their own scripts,
 * styles and images: the icons they share with the viewer, and the
 * thumbnails.
 */
export const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'";

/**
 * The web app's Home, whose thumbnails are blob: URLs of the Blobs the
 * library keeps.
 */
export const WEB_HOME_CSP = `${PAGE_CSP} blob:`;

/**
 * The web app's shell: Home's, and the frames it shows the viewer and Home
 * in, its manifest, and its service worker.
 */
export const WEB_SHELL_CSP = `${WEB_HOME_CSP}; frame-src 'self'; manifest-src 'self'; worker-src 'self'`;
