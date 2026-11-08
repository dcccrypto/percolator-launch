/**
 * PERC allocation snapshot importer (operator CLI).
 *
 *   npx tsx app/scripts/allocation/import-snapshot.ts \
 *     --eligible <eligible.csv> --manifest <manifest.json> --all-holders <all-holders.csv> \
 *     --snapshot-date YYYY-MM-DD --snapshot-slot <slot> --token-decimals <n> \
 *     [--base-manifest <v1 manifest.json> --exception <exception.json> ...] [--apply]
 *
 * A derived (v2) manifest, which adds approved balance-exception owners to a v1
 * export, needs its v1 base manifest and every exception file (repeat --exception).
 *
 * Default is validate-only: prints counts and hashes (never an address) and
 * exits. --apply writes one snapshot atomically to the database whose URL is in
 * the env var named by --database-url-env (default ALLOCATION_IMPORT_DATABASE_URL),
 * as a role that owns perc_alloc (NOT the runtime reader). Non-local database
 * hosts are refused unless --allow-remote is given; only use that after the
 * owner has approved the external change.
 *
 * Input files are private and must stay outside the repository.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "pg";
import { applySnapshot, ImportError, summarize, validateSnapshot } from "./import-lib";

/** URL parameters pg would use to override host/port/options (same list as lib/allocation-vote/server-config.ts). */
export const OVERRIDE_PARAMS = ["host", "hostaddr", "port", "options", "service", "servicefile"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function all(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name) {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) throw new ImportError("USAGE", `missing value for ${name}`);
      out.push(v);
    }
  });
  return out;
}

function need(argv: string[], name: string): string {
  const v = arg(argv, name);
  if (!v || v.startsWith("--")) throw new ImportError("USAGE", `missing ${name}`);
  return v;
}

function readPrivate(p: string): Buffer {
  // realpath: a symlink cannot smuggle a repository file in, or hide one.
  const abs = fs.realpathSync(path.resolve(p));
  const repo = fs.realpathSync(path.resolve(__dirname, "../../.."));
  if (abs === repo || abs.startsWith(repo + path.sep)) throw new ImportError("IN_REPO", `${path.basename(p)} is inside the repository; keep holder data outside it`);
  return fs.readFileSync(abs);
}

export async function main(argv: string[]): Promise<number> {
  const input = {
    eligibleCsv: readPrivate(need(argv, "--eligible")),
    manifest: readPrivate(need(argv, "--manifest")),
    allHoldersCsv: readPrivate(need(argv, "--all-holders")),
    snapshotDate: need(argv, "--snapshot-date"),
    snapshotSlot: BigInt(need(argv, "--snapshot-slot")),
    tokenDecimals: Number(need(argv, "--token-decimals")),
    baseManifest: arg(argv, "--base-manifest") !== undefined ? readPrivate(need(argv, "--base-manifest")) : undefined,
    exceptions: all(argv, "--exception").map(readPrivate),
  };
  const v = validateSnapshot(input);
  console.log(JSON.stringify({ validated: true, ...summarize(v) }, null, 2));
  if (!argv.includes("--apply")) {
    console.log("validate-only: nothing written (pass --apply to write)");
    return 0;
  }
  const envName = arg(argv, "--database-url-env") ?? "ALLOCATION_IMPORT_DATABASE_URL";
  const url = process.env[envName];
  if (!url) throw new ImportError("NO_DB", `${envName} is not set`);
  const parsed = new URL(url);
  if (OVERRIDE_PARAMS.some((k) => parsed.searchParams.has(k))) {
    throw new ImportError("BAD_DB_URL", "database URL must not carry host/hostaddr/port/options/service parameters");
  }
  const host = parsed.hostname;
  if (!LOCAL_HOSTS.has(host) && !argv.includes("--allow-remote")) {
    throw new ImportError("REMOTE_REFUSED", "non-local database host; requires --allow-remote after owner approval");
  }
  // Remote imports always use verified TLS (URL ssl parameters cannot weaken it).
  const u = new URL(url);
  u.search = "";
  const ca = process.env.ALLOCATION_DATABASE_CA_PEM?.trim();
  const client = new Client({
    connectionString: u.toString(),
    ssl: LOCAL_HOSTS.has(host) ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    application_name: "perc-alloc-import",
  });
  await client.connect();
  try {
    const r = await applySnapshot(client, v);
    console.log(JSON.stringify({ applied: !r.unchanged, unchanged: r.unchanged, snapshot_id: r.snapshotId, superseded_snapshot_ids: r.superseded }));
  } finally {
    await client.end();
  }
  return 0;
}

if (require.main === module || process.argv[1]?.endsWith("import-snapshot.ts")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof ImportError ? e.message : `error: ${(e as Error).message}`);
      process.exit(2);
    },
  );
}
