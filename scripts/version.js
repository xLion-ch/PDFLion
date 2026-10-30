#!/usr/bin/env node
/**
 * Prints the version CI builds PDFLion as: the major and minor version from
 * package.json, and as the patch version the number of commits in the
 * checked-out history. So the same commit always gets the same version, and
 * each push to main a higher one than the last, without CI committing
 * anything. Raising the major or minor version stays a hand edit of
 * package.json, whose patch version stays 0. Plain Node, like update-pdfjs.js.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = `Usage:
  node scripts/version.js              print the release version of the checked-out commit
  node scripts/version.js --pr <n>     print the version of pull request n's build

A release version is <major>.<minor>.<commits>, such as 1.0.412. A pull request
builds <major>.<minor>.<commits>-pr.<n>, which sorts before the release of the
same commit count, so a pull request's build updates to the next release.`;

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/**
 * @param {string} packageVersion package.json's, such as "1.0.0"
 * @param {number} commits how many commits the checked-out history has
 * @param {number} [pullRequest] the pull request's number, for its build
 * @returns {string} such as "1.0.412", or "1.0.412-pr.7" for pull request 7
 */
export function formatVersion(packageVersion, commits, pullRequest) {
  const match = /^(\d+)\.(\d+)\.0$/.exec(packageVersion);
  if (!match) {
    throw new Error(`package.json's version is ${packageVersion}, not <major>.<minor>.0`);
  }
  if (!Number.isSafeInteger(commits) || commits < 1) {
    throw new Error(`${commits} isn't a number of commits`);
  }
  if (pullRequest !== undefined && (!Number.isSafeInteger(pullRequest) || pullRequest < 1)) {
    throw new Error(`${pullRequest} isn't a pull request's number`);
  }
  const version = `${match[1]}.${match[2]}.${commits}`;
  return pullRequest === undefined ? version : `${version}-pr.${pullRequest}`;
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** @param {string[]} args the command line, without node and the script */
function main(args) {
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(USAGE);
    return;
  }
  let pullRequest;
  if (args[0] === "--pr" && args.length === 2) {
    if (!/^\d+$/.test(args[1])) throw new Error(`${args[1]} isn't a pull request's number`);
    pullRequest = Number(args[1]);
  } else if (args.length > 0) {
    throw new Error(`unknown arguments: ${args.join(" ")}\n\n${USAGE}`);
  }

  // A shallow clone counts only the commits it has.
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error("the history is shallow: check out with all of it (fetch-depth: 0)");
  }
  const commits = Number(git(["rev-list", "--count", "HEAD"]));
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  console.log(formatVersion(version, commits, pullRequest));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${/** @type {Error} */ (error).message}`);
    process.exit(1);
  }
}
