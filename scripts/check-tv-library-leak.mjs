#!/usr/bin/env node
/**
 * Leak guard for the TradingView Advanced Charts library.
 *
 * The library's licence forbids it in public repositories, and this repo is
 * public. The library is fetched at build time into app/public/charting_library/
 * (gitignored). This check fails if any library file — or recognisable library
 * content under another name — is tracked by git.
 *
 *   node scripts/check-tv-library-leak.mjs           # every tracked file (CI)
 *   node scripts/check-tv-library-leak.mjs --staged  # staged files only (pre-commit use)
 *
 * The content markers are written as regexes whose own source text does not
 * match them, so this file never flags itself.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Tracked paths that must never exist. */
export const PATH_PATTERNS = [
  /(^|\/)charting_library(\/|\.)/i,
  /(^|\/)datafeed-api\.d\.ts$/i,
  /(^|\/)tv-datafeeds\//i,
  /tradingview/i,
];

/** Strings that only appear inside the library's own files. */
export const CONTENT_PATTERNS = [
  // the standalone loader's first statement
  /var TradingView=function\(e\)\{"use strict"/,
  // the library package.json description
  /CL v\d+\.\d+\.\d+ \(internal id [0-9a-f]{40}/,
  // the typings' module banner
  /@module Charting\sLibrary/,
  // hashed worker bundle names referenced by the runtime
  /chartapi-local-(backend|transport-worker)\.worker\.[0-9a-f]{20}\.js/,
];

const MAX_SCAN_BYTES = 40 * 1024 * 1024;

/** @returns {string[]} the offending paths */
export function scanPaths(paths) {
  return paths.filter((p) => PATH_PATTERNS.some((re) => re.test(p)));
}

/** @returns {boolean} true when `text` contains library content */
export function hasLibraryContent(text) {
  return CONTENT_PATTERNS.some((re) => re.test(text));
}

/**
 * @param {string[]} paths
 * @param {(p: string) => string | null} read  returns file text, or null to skip
 * @returns {{ byPath: string[], byContent: string[] }}
 */
export function findLeaks(paths, read) {
  const byPath = scanPaths(paths);
  const byContent = [];
  for (const p of paths) {
    const text = read(p);
    if (text != null && hasLibraryContent(text)) byContent.push(p);
  }
  return { byPath, byContent };
}

function gitList(staged) {
  const args = staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] : ["ls-files", "-z"];
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

function readTracked(p) {
  try {
    if (!existsSync(p)) return null;
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) return null;
    return readFileSync(p, "latin1");
  } catch {
    return null;
  }
}

export function main(argv = process.argv.slice(2)) {
  const staged = argv.includes("--staged");
  const paths = gitList(staged);
  const { byPath, byContent } = findLeaks(paths, readTracked);
  if (byPath.length === 0 && byContent.length === 0) {
    console.log(`[tv-leak-guard] OK — ${paths.length} ${staged ? "staged" : "tracked"} files, no TradingView library content.`);
    return 0;
  }
  console.error("[tv-leak-guard] TradingView library files must never be committed (licence: no public repos).");
  for (const p of byPath) console.error(`  path:    ${p}`);
  for (const p of byContent) console.error(`  content: ${p}`);
  console.error("Remove them from the index (git rm --cached <path>) — the build fetches the library itself.");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
