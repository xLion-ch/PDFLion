/**
 * The only module that knows where files live in dev versus a packaged build.
 *
 * In dev, `electron .` makes the app path the repo root. Packaged, the app path
 * is `Contents/Resources/app.asar`, and the pdf.js build is copied next to it
 * into `Contents/Resources/pdfjs`.
 */
import path from "node:path";
import { app } from "electron";

const appPath = app.getAppPath();

/** The pdf.js generic viewer build, served at `pdflion://app/viewer/`. */
export const viewerRoot = app.isPackaged
  ? path.join(process.resourcesPath, "pdfjs")
  : path.join(appPath, "vendor", "pdf.js", "build", "generic");

/** `src/viewer/` (bridge.js, overrides.css), served at `pdflion://app/pdflion/`. */
export const pdflionRoot = path.join(appPath, "src", "viewer");

/** The sandboxed preload script that exposes `window.pdflion`. */
export const preloadPath = path.join(appPath, "src", "preload", "preload.cjs");
