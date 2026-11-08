/**
 * Scan build output for holder-list leakage. Prints counts only.
 *
 *   npx tsx app/scripts/allocation/scan-build-leaks.ts --owners <private all-holders.csv> --dir app/.next [--dir app/public]
 *
 * 1. Every base58 token (32-44 chars) in every file is checked against the
 *    private owner set. Any hit fails the scan (exit 1). Hit counts are
 *    reported per area; the addresses themselves are never printed.
 * 2. Browser-delivered files (.next/static, public) must not contain
 *    server-only markers (the database schema/function, env var names, the
 *    pg driver) and must not ship source maps.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const SERVER_ONLY_MARKERS = [
  "perc_alloc",
  "check_allocation",
  "ALLOCATION_DATABASE_URL",
  "ALLOCATION_RATE_LIMIT_SECRET",
  "ALLOCATION_DATABASE_CA_PEM",
  "perc-alloc-rl",
  "pg-connection-string",
  "pgpass",
];

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      // Follow file links only (directory links could loop); count them as scanned files.
      if (fs.statSync(p, { throwIfNoEntry: false })?.isFile()) yield p;
      continue;
    }
    if (e.isDirectory()) {
      if (e.name === "cache") continue; // webpack/turbopack cache is not served
      yield* walk(p);
    } else yield p;
  }
}

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => a === name && process.argv[i + 1] && out.push(process.argv[i + 1]!));
  return out;
}

const ownersFile = args("--owners")[0];
const dirs = args("--dir");
if (!ownersFile || dirs.length === 0) {
  console.error("usage: --owners <csv> --dir <dir> [--dir <dir>]");
  process.exit(2);
}
const owners = new Set(
  fs
    .readFileSync(ownersFile, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split(",")[0]!),
);

let files = 0;
let bytes = 0;
let ownerHits = 0;
const hitAreas = new Map<string, number>();
const markerHits = new Map<string, number>();
let browserMaps = 0;
let browserFiles = 0;

for (const d of dirs) {
  for (const f of walk(d)) {
    const buf = fs.readFileSync(f);
    files++;
    bytes += buf.length;
    const text = buf.toString("latin1");
    const rel = path.relative(d, f);
    const browser = rel.startsWith("static" + path.sep) || path.basename(d) === "public";
    for (const m of text.matchAll(B58)) {
      if (owners.has(m[0])) {
        ownerHits++;
        const area = `${path.basename(d)}/${rel.split(path.sep).slice(0, 2).join("/")}`;
        hitAreas.set(area, (hitAreas.get(area) ?? 0) + 1);
      }
    }
    if (browser) {
      browserFiles++;
      if (f.endsWith(".map")) browserMaps++;
      for (const k of SERVER_ONLY_MARKERS) if (text.includes(k)) markerHits.set(k, (markerHits.get(k) ?? 0) + 1);
    }
  }
}

const report = {
  owners_checked: owners.size,
  files_scanned: files,
  bytes_scanned: bytes,
  owner_address_hits: ownerHits,
  owner_hit_areas: Object.fromEntries(hitAreas),
  browser_files: browserFiles,
  browser_source_maps: browserMaps,
  browser_server_only_marker_hits: Object.fromEntries(markerHits),
};
console.log(JSON.stringify(report, null, 2));
process.exit(ownerHits === 0 && browserMaps === 0 && markerHits.size === 0 ? 0 : 1);
