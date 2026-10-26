/**
 * Web permissions. Electron grants every permission request unless the
 * session says otherwise, so this denies all but the two pdf.js uses: full
 * screen for presentation mode, and writing text to the clipboard, which it
 * does when copying the text of a whole document. Only the viewer gets them.
 *
 * Device choosers (WebHID, Web Serial, WebUSB, Bluetooth) and screen sharing
 * need handlers of their own in Electron. PDFLion sets none, so they fail.
 */
import { session } from "electron";
import { isViewerUrl } from "./routes.js";

/**
 * Chromium asks for `clipboard-sanitized-write` when a page writes text in
 * response to a click or key press. Without one, it asks for `clipboard-read`,
 * which also allows reading, and which PDFLion denies.
 * @type {ReadonlySet<string>}
 */
const ALLOWED_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write"]);

/** Must run once the app is ready, before any window loads. */
export function handlePermissions() {
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(isAllowed(permission, details));
  });
  // Chromium checks a permission before it requests it, and for some
  // features instead of requesting it.
  defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) =>
    isAllowed(permission, details),
  );
}

/**
 * @param {string} permission
 * @param {{ isMainFrame: boolean, requestingUrl?: string }} details
 * @returns {boolean}
 */
function isAllowed(permission, { isMainFrame, requestingUrl }) {
  return ALLOWED_PERMISSIONS.has(permission) && isMainFrame && isViewerUrl(requestingUrl ?? "");
}
