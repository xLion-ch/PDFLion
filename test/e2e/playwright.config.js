import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: ".",
  // One app at a time: parallel apps would take focus from each other's windows.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // On GitHub Actions also an HTML report, which the workflow keeps when a
  // test fails, and a test.only fails the run rather than skipping the rest.
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  forbidOnly: isCI,
});
