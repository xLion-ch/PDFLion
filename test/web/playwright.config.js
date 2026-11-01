/**
 * The web app's end-to-end tests, against dist/web/ as scripts/serve-web.js
 * serves it, the way GitHub Pages does: in Playwright's WebKit as an iPad,
 * and in its Chromium as an Android tablet. `npm run test:web` builds the
 * app first.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;
const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/** Not 8080, which `npm run web:serve` takes. */
const PORT = 8091;

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // On GitHub Actions also an HTML report, which the workflow keeps when a
  // test fails, and a test.only fails the run rather than skipping the rest.
  reporter: isCI ? [["list"], ["html", { open: "never", outputFolder: "../../playwright-report/web" }]] : "list",
  outputDir: "../../test-results/web",
  forbidOnly: isCI,
  webServer: {
    command: `node scripts/serve-web.js --port ${PORT} dist/web`,
    cwd: ROOT,
    url: `http://localhost:${PORT}/PDFLion/`,
    reuseExistingServer: !isCI,
  },
  use: { baseURL: `http://localhost:${PORT}/PDFLion/` },
  projects: [
    { name: "ipad-webkit", use: { ...devices["iPad Pro 11 landscape"], browserName: "webkit" } },
    {
      name: "tablet-chromium",
      use: { ...devices["Galaxy Tab S9 landscape"], browserName: "chromium" },
    },
  ],
});
