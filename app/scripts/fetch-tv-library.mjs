#!/usr/bin/env node
/**
 * Build-time fetch of the TradingView Advanced Charts library.
 *
 * The library is licensed for self-hosting but may NOT be committed to a public
 * repository (this one is public). So it is never tracked: this script
 * downloads a pinned commit from a private GitHub repo at build time and
 * unpacks the runtime files into app/public/charting_library/ (gitignored).
 *
 *   TV_LIBRARY_TOKEN     GitHub token with read access to TV_LIBRARY_REPO.
 *                        Unset (fork PRs, CI, most local dev) -> nothing is
 *                        fetched, the build still succeeds, and the trade page
 *                        uses the built-in lightweight-charts chart.
 *   TV_LIBRARY_REPO      owner/name of the private repo. Default
 *                        tradingview/charting_library (or a private mirror that
 *                        holds the same tree — the digest check is over file
 *                        contents, so a mirror passes as long as it is identical).
 *   TV_LIBRARY_REQUIRED  "1" -> a failed download fails the build instead of
 *                        degrading to the fallback chart.
 *
 * Integrity: the commit is pinned in tv-library-lock.json together with a
 * SHA-256 over the whole charting_library/ tree (sorted "path NUL sha256(file)"
 * lines). A digest mismatch ALWAYS fails the build — it means the pinned commit
 * no longer has the content we reviewed.
 *
 * The token is only ever sent in an Authorization header; it is never printed.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, "..");
export const LOCK_PATH = path.join(HERE, "tv-library-lock.json");
export const DEST_DIR = path.join(APP_DIR, "public", "charting_library");
/** Written next to the runtime files; next.config.ts reads it to decide availability. */
export const VERSION_FILE = ".percolator-version.json";

/** Only these are copied into public/: the loader, the same-origin iframe page and the bundles. */
export const RUNTIME_ENTRIES = ["charting_library.standalone.js", "sameorigin.html", "bundles"];

/** All files under `dir`, as POSIX-style paths relative to it, sorted. */
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(a).isDirectory()) walk(a, r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * Content digest of a directory tree: SHA-256 over the sorted lines
 * `<relative path>\0<sha256 hex of the file>\n`. Independent of archive
 * compression, timestamps and the archive's top-level folder name.
 */
export function treeDigest(dir) {
  const h = createHash("sha256");
  for (const rel of listFiles(dir)) {
    const fileHash = createHash("sha256").update(readFileSync(path.join(dir, rel))).digest("hex");
    h.update(`${rel}\0${fileHash}\n`);
  }
  return h.digest("hex");
}

export function readLock(lockPath = LOCK_PATH) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!/^v\d+\.\d+\.\d+$/.test(lock.tag ?? "")) throw new Error("tv-library-lock.json: bad tag");
  if (!/^[0-9a-f]{40}$/.test(lock.commit ?? "")) throw new Error("tv-library-lock.json: commit must be a full SHA");
  if (!/^[0-9a-f]{64}$/.test(lock.treeSha256 ?? "")) throw new Error("tv-library-lock.json: treeSha256 must be 64 hex chars");
  return lock;
}

/** The version marker in DEST, or null. */
export function installedVersion(destDir = DEST_DIR) {
  try {
    return JSON.parse(readFileSync(path.join(destDir, VERSION_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** Is DEST already holding exactly the locked tree's runtime files? */
export function isInstalled(lock, destDir = DEST_DIR) {
  const v = installedVersion(destDir);
  return (
    v != null &&
    v.commit === lock.commit &&
    v.treeSha256 === lock.treeSha256 &&
    existsSync(path.join(destDir, "charting_library.standalone.js")) &&
    existsSync(path.join(destDir, "sameorigin.html"))
  );
}

/**
 * Copy the runtime subset of an extracted `charting_library/` folder into DEST.
 * Never copies typings, package.json or the non-standalone module builds.
 */
export function installRuntime(srcLibDir, destDir, lock) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const entry of RUNTIME_ENTRIES) {
    const from = path.join(srcLibDir, entry);
    if (!existsSync(from)) throw new Error(`library archive is missing ${entry}`);
    cpSync(from, path.join(destDir, entry), { recursive: true });
  }
  writeFileSync(
    path.join(destDir, VERSION_FILE),
    JSON.stringify({ tag: lock.tag, commit: lock.commit, treeSha256: lock.treeSha256 }) + "\n",
  );
}

/** Find the single top-level folder a GitHub tarball extracts to. */
function archiveRoot(extractDir) {
  const dirs = readdirSync(extractDir).filter((n) => statSync(path.join(extractDir, n)).isDirectory());
  if (dirs.length !== 1) throw new Error(`expected one top-level folder in the archive, found ${dirs.length}`);
  return path.join(extractDir, dirs[0]);
}

async function download(repo, commit, token, file) {
  const url = `https://api.github.com/repos/${repo}/tarball/${commit}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "percolator-build",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${repo} tarball -> HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

class DigestMismatch extends Error {}

export async function main(env = process.env) {
  const log = (m) => console.log(`[tv-library] ${m}`);
  const lock = readLock();

  if (isInstalled(lock)) {
    log(`${lock.tag} already present in public/charting_library — skipping download.`);
    return 0;
  }

  const token = env.TV_LIBRARY_TOKEN;
  if (!token) {
    // A stale or partial copy must not be served as if it were the locked one.
    rmSync(DEST_DIR, { recursive: true, force: true });
    log("TV_LIBRARY_TOKEN is not set — library not fetched; the trade page will use the fallback chart.");
    return 0;
  }

  const repo = env.TV_LIBRARY_REPO || "tradingview/charting_library";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("TV_LIBRARY_REPO must look like owner/name");
  const work = mkdtempSync(path.join(tmpdir(), "tv-library-"));
  try {
    const tarball = path.join(work, "lib.tar.gz");
    const extract = path.join(work, "x");
    mkdirSync(extract);
    log(`downloading ${repo}@${lock.commit.slice(0, 12)} (${lock.tag})…`);
    await download(repo, lock.commit, token, tarball);
    execFileSync("tar", ["-xzf", tarball, "-C", extract], { stdio: "ignore" });
    const libDir = path.join(archiveRoot(extract), "charting_library");
    if (!existsSync(libDir)) throw new Error("archive has no charting_library/ folder");
    const digest = treeDigest(libDir);
    if (digest !== lock.treeSha256) {
      throw new DigestMismatch(
        `charting_library tree digest mismatch: expected ${lock.treeSha256}, got ${digest}. ` +
          "Refusing to install. If this is an intentional upgrade, update tv-library-lock.json.",
      );
    }
    installRuntime(libDir, DEST_DIR, lock);
    log(`installed ${lock.tag} (${listFiles(DEST_DIR).length} files) into public/charting_library.`);
    return 0;
  } catch (err) {
    rmSync(DEST_DIR, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof DigestMismatch || env.TV_LIBRARY_REQUIRED === "1") {
      console.error(`[tv-library] FATAL: ${msg}`);
      return 1;
    }
    console.warn(`[tv-library] WARNING: ${msg} — continuing without the library (fallback chart).`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[tv-library] FATAL: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
