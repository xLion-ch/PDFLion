import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // One app at a time: parallel apps would take focus from each other's windows.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
});
