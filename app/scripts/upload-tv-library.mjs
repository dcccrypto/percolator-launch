#!/usr/bin/env node
/**
 * One-time upload of the pinned TradingView runtime tarball to Vercel Blob (PRIVATE access), where
 * scripts/fetch-tv-library.mjs reads it at build time. Publishing licensed files is a deliberate act, so
 * this refuses to run without --yes, and refuses a tarball whose sha256 is not the one pinned in
 * tv-library-lock.json.
 *
 *   BLOB_READ_WRITE_TOKEN=... node scripts/upload-tv-library.mjs <tarball.tgz> --yes
 *
 * The token comes from the environment only and is never printed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readLock } from "./fetch-tv-library.mjs";

const file = process.argv[2];
if (!file || !process.argv.includes("--yes")) {
  console.error("usage: BLOB_READ_WRITE_TOKEN=... node scripts/upload-tv-library.mjs <tarball.tgz> --yes");
  process.exit(2);
}
const lock = readLock();
if (!lock.blob) throw new Error("tv-library-lock.json has no blob entry");
const buf = readFileSync(file);
const sha = createHash("sha256").update(buf).digest("hex");
if (sha !== lock.blob.tarballSha256) {
  console.error(`refusing: tarball sha256 ${sha} != pinned ${lock.blob.tarballSha256}`);
  process.exit(1);
}
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
const { put } = await import("@vercel/blob");
const res = await put(lock.blob.pathname, buf, {
  access: "private",
  token,
  addRandomSuffix: false,
  allowOverwrite: false,
  contentType: "application/gzip",
});
console.log(`uploaded ${res.pathname} (${buf.length} bytes, sha256 ${sha})`);
