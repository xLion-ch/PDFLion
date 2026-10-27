/**
 * The only module that knows where files live in dev versus a packaged build.
 *
 * In dev, `electron .` makes the app path the repo root. Packaged, the app path
 * is `app.asar` in the resources directory (`Contents/Resources/` on macOS,
 * `resources\` on Windows, `/opt/PDFLion/resources/` on Linux), and the pdf.js
 * build is copied next to it into `pdfjs`.
 */
import path from "node:path";
import { app } from "electron";

const appPath = app.getAppPath();

/** The pdf.js generic viewer build, served at `pdflion://app/viewer/`. */
export const viewerRoot = app.isPackaged
  ? path.join(process.resourcesPath, "pdfjs")
  : path.join(appPath, "vendor", "pdf.js", "build", "generic");

/** The pdf.js build's version.json, e.g. `{ "version": "6.4.299", … }`. */
export const pdfjsVersionPath = app.isPackaged
  ? path.join(process.resourcesPath, "pdfjs", "version.json")
  : path.join(appPath, "vendor", "pdf.js", "build", "version.json");

/**
 * The icon in the About box on Windows and Linux, 48×48 as Electron recommends
 * for Windows. GTK scales it to 64×64.
 */
export const aboutIconPath = path.join(appPath, "resources", "about-icon.png");

/** `src/viewer/` (bridge.js, overrides.css), served at `pdflion://app/pdflion/`. */
export const pdflionRoot = path.join(appPath, "src", "viewer");

/**
 * The browser build of @cantoo/pdf-lib, served at `pdflion://app/lib/`. It
 * runs only in the viewer, which changes pages with it. electron-builder packs
 * production dependencies into `app.asar`.
 */
export const pdfLibRoot = path.join(appPath, "node_modules", "@cantoo", "pdf-lib", "dist");

/** `src/tabs/`, the tab strip, served at `pdflion://app/tabs/`. */
export const tabsRoot = path.join(appPath, "src", "tabs");

/** The sandboxed preload script that exposes `window.pdflion` to the viewer. */
export const preloadPath = path.join(appPath, "src", "preload", "preload.cjs");

/** The sandboxed preload script that exposes `window.pdflionTabs` to the tab strip. */
export const tabsPreloadPath = path.join(appPath, "src", "preload", "tabs.cjs");
