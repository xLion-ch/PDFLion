#!/usr/bin/env node
/**
 * Pins vendor/pdf.js to a pdf.js release and builds its generic viewer into
 * vendor/pdf.js/build/generic, which is what the app loads. Plain Node rather
 * than a shell script, so it runs the same on macOS and Windows.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage:
  node scripts/update-pdfjs.js                     update to the latest stable release
  node scripts/update-pdfjs.js v6.4.299            switch to a specific release (the "v" is optional)
  node scripts/update-pdfjs.js --build             rebuild the currently pinned release
  node scripts/update-pdfjs.js --build-if-missing  build the pinned release unless it is built
  node scripts/update-pdfjs.js --check             print the pinned and latest releases, change nothing`;

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const PDFJS_DIR = "vendor/pdf.js";
const PDFJS = path.join(ROOT, PDFJS_DIR);
const VIEWER_HTML = path.join(PDFJS, "build", "generic", "web", "viewer.html");
// Only plain vX.Y.Z tags are releases; upstream also has stray tags such as "vundefined".
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/**
 * Runs git in the repo root. Its errors go to stderr, and a failure throws.
 *
 * @param {string[]} args
 * @param {{ quiet?: boolean }} [options] quiet: hide git's stderr
 * @returns {string} git's output, trimmed
 */
function git(args, { quiet = false } = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  }).trim();
}

/**
 * Runs an npm or npx command in vendor/pdf.js. It goes through the shell
 * because on Windows npm is a .cmd script, which only a shell can start.
 *
 * @param {string} command a constant: it isn't escaped
 */
function npm(command) {
  const { status, error } = spawnSync(command, {
    cwd: PDFJS,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" },
  });
  if (error) throw error;
  if (status !== 0) die(`\`${command}\` failed in ${PDFJS_DIR}`);
}

function currentTag() {
  try {
    return git(["-C", PDFJS, "describe", "--tags", "--exact-match", "HEAD"], { quiet: true });
  } catch {
    return git(["-C", PDFJS, "rev-parse", "--short", "HEAD"]);
  }
}

function latestTag() {
  const tags = git(["-C", PDFJS, "ls-remote", "--tags", "--refs", "origin", "v*"])
    .split("\n")
    .map((line) => line.replace(/.*refs\/tags\//, ""))
    .filter((tag) => RELEASE_TAG_RE.test(tag));
  return tags.sort(compareReleases).at(-1) ?? die("upstream has no release tags");
}

/**
 * @param {string} a release tag
 * @param {string} b release tag
 */
function compareReleases(a, b) {
  const [x, y] = [a, b].map((tag) => tag.slice(1).split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

function build() {
  console.log(`==> Building pdf.js ${currentTag()} generic viewer`);
  fs.rmSync(path.join(PDFJS, "build", "generic"), { recursive: true, force: true });
  npm("npm ci --no-audit --no-fund");
  npm("npx gulp generic");
  if (!fs.existsSync(VIEWER_HTML)) die("build finished but viewer.html is missing");
  console.log(`==> Built ${PDFJS_DIR}/build/generic`);
}

/** @param {string | undefined} requested a release tag, or undefined for the latest */
function update(requested) {
  let tag = requested ?? latestTag();
  if (!tag.startsWith("v")) tag = `v${tag}`;
  if (!RELEASE_TAG_RE.test(tag)) {
    die(`'${tag}' is not a pdf.js release tag (expected e.g. v6.4.299)`);
  }

  const current = currentTag();
  if (tag === current) {
    console.log(`==> pdf.js is already at ${tag} (use --build to rebuild)`);
    if (!fs.existsSync(VIEWER_HTML)) build();
    return;
  }

  if (git(["-C", PDFJS, "status", "--porcelain"]) !== "") {
    die(`${PDFJS_DIR} has local changes; pdf.js must stay unmodified (see CLAUDE.md)`);
  }

  console.log(`==> Switching pdf.js ${current} -> ${tag}`);
  git(["-C", PDFJS, "fetch", "--quiet", "origin", "tag", tag]);
  git(["-C", PDFJS, "-c", "advice.detachedHead=false", "checkout", "--quiet", tag]);
  git(["add", PDFJS_DIR]);

  build();

  console.log(`\npdf.js is now pinned to ${tag} (staged). Smoke-test the app, then commit:`);
  console.log(`  git commit -m "Update pdf.js to ${tag}"`);
}

const arg = process.argv[2];
if (arg === "-h" || arg === "--help") {
  console.log(USAGE);
  process.exit(0);
}

try {
  // Initialise on fresh clones only: on an existing checkout `submodule update`
  // would reset vendor/pdf.js to the commit recorded in the index.
  if (!fs.existsSync(path.join(PDFJS, ".git"))) git(["submodule", "update", "--init", PDFJS_DIR]);

  switch (arg) {
    case "--build":
      build();
      break;
    case "--build-if-missing":
      if (!fs.existsSync(VIEWER_HTML)) build();
      break;
    case "--check":
      console.log(`pinned: ${currentTag()}`);
      console.log(`latest: ${latestTag()}`);
      break;
    default:
      update(arg);
  }
} catch (error) {
  die(/** @type {Error} */ (error).message);
}
