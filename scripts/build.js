#!/usr/bin/env node
/**
 * Tests PDFLion and builds every version this machine can build into dist/:
 * on a Mac, the arm64 and x64 .dmg and .zip, plus the Windows installer if
 * Rosetta is installed; on Windows, the installer; on Linux, the .deb. Plain
 * Node, like update-pdfjs.js, so it runs the same on macOS, Windows and Linux.
 *
 * It empties dist/ first, so dist/ ends up holding exactly this build.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage:
  node scripts/build.js   run the tests, then build into dist/ (npm run build)

It builds what this machine can: the Mac apps on a Mac, plus the Windows
installer with Rosetta; the Windows installer on Windows; the .deb on Linux.`;

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const DIST = path.join(ROOT, "dist");
const PDFJS = path.join(ROOT, "vendor", "pdf.js");
const ARTIFACT_RE = /\.(dmg|zip|exe|deb)$/;

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/**
 * Runs a command in the repo root. It goes through the shell because on
 * Windows npm is a .cmd script, which only a shell can start.
 *
 * @param {string} command a constant: it isn't escaped
 */
function run(command) {
  console.log(`\n==> ${command}`);
  const { status, error } = spawnSync(command, { cwd: ROOT, shell: true, stdio: "inherit" });
  if (error) throw error;
  if (status !== 0) die(`\`${command}\` failed`);
}

/**
 * Makes sure the pdf.js build matches the pinned submodule, since that build
 * is what ships. `--build-if-missing` alone would keep a build of an earlier
 * release after the submodule moved.
 */
function preparePdfjs() {
  run("node scripts/update-pdfjs.js --build-if-missing");
  const status = execFileSync("git", ["-C", PDFJS, "status", "--porcelain"], { encoding: "utf8" });
  if (status !== "")
    die("vendor/pdf.js has local changes; pdf.js must stay unmodified (see CLAUDE.md)");

  const head = execFileSync("git", ["-C", PDFJS, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const versionFile = path.join(PDFJS, "build", "version.json");
  const { commit } = JSON.parse(fs.readFileSync(versionFile, "utf8"));
  if (typeof commit !== "string" || !head.startsWith(commit)) {
    console.log(`\npdf.js was built from ${commit}, but ${head.slice(0, 9)} is pinned.`);
    run("node scripts/update-pdfjs.js --build");
  }
}

/** Runs the unit tests, then the end-to-end tests. */
function test() {
  run("npm test");
  run("npm run test:e2e");
}

/** @returns {string[]} electron-builder's platform flags for this machine */
function platforms() {
  switch (process.platform) {
    case "win32":
      return ["--win"];
    case "linux":
      return ["--linux"];
    case "darwin":
      if (canRunIntelCode()) return ["--mac", "--win"];
      console.log(
        "\nSkipping the Windows installer: electron-builder's makensis for macOS is an Intel" +
          " program. Install Rosetta (softwareupdate --install-rosetta) or build on Windows.",
      );
      return ["--mac"];
    default:
      return die(`PDFLion builds on macOS, Windows and Linux, not on ${process.platform}`);
  }
}

/** @returns {boolean} whether this Mac is an Intel Mac, or has Rosetta */
function canRunIntelCode() {
  return spawnSync("arch", ["-x86_64", "/usr/bin/true"]).status === 0;
}

function build() {
  const flags = platforms();
  fs.rmSync(DIST, { recursive: true, force: true });
  run(`npm run dist -- ${flags.join(" ")}`);

  const artifacts = fs.readdirSync(DIST).filter((name) => ARTIFACT_RE.test(name));
  if (artifacts.length === 0) die("electron-builder finished without building anything");
  console.log("\nBuilt in dist/:");
  for (const name of artifacts.sort()) {
    const megabytes = fs.statSync(path.join(DIST, name)).size / 1e6;
    console.log(`  ${name}  ${megabytes.toFixed(0)} MB`);
  }
}

if (process.argv[2] === "-h" || process.argv[2] === "--help") {
  console.log(USAGE);
  process.exit(0);
}

try {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  console.log(`==> Building PDFLion ${version}`);
  preparePdfjs();
  test();
  build();
} catch (error) {
  die(/** @type {Error} */ (error).message);
}
