/**
 * Local end-to-end harness for /allocation. LOCAL ONLY: everything it starts
 * listens on 127.0.0.1 and is torn down on exit.
 *
 *   npx tsx app/scripts/allocation/e2e-local.ts --mode synthetic --out <evidence dir>
 *   npx tsx app/scripts/allocation/e2e-local.ts --mode private --out <private dir> --cases <cases.json> \
 *     --eligible <csv> --manifest <json> --all-holders <csv> --snapshot-date YYYY-MM-DD --snapshot-slot N --token-decimals N \
 *     [--base-manifest <v1 json> --exception <json>]
 *
 * 1. throwaway Postgres cluster (temp dir, 0700), Supabase-like roles
 * 2. migration applied as a non-superuser migrator; random reader password
 * 3. snapshot imported through the real importer CLI (--apply, local host)
 * 4. `next start` (production build must exist) with the reader URL + random secret
 * 5. Playwright: playwright.allocation.config.ts
 *
 * Synthetic mode generates its own files and cases. Private mode reads real
 * files and a private cases file; neither mode prints a wallet address.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import bs58 from "bs58";
import { Client } from "pg";
import { allocateAll } from "../../lib/allocation-vote/math";
import { main as importMain } from "./import-snapshot";

const APP = path.resolve(__dirname, "../..");
const REPO = path.resolve(APP, "..");
const MIGRATION = path.join(REPO, "supabase/waitlist-migrations/20261108000000_perc_alloc_private_lookup.sql");

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

function pgBin(): string {
  for (const c of [process.env.PERC_ALLOC_PG_BIN, "/opt/homebrew/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin"]) {
    if (c && fs.existsSync(path.join(c, "initdb"))) return c;
  }
  throw new Error("no Postgres binaries (set PERC_ALLOC_PG_BIN)");
}

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const synthOwner = (i: string) => bs58.encode(createHash("sha256").update(`SYNTHETIC-e2e-owner-${i}`).digest());
const fmtBal = (raw: bigint, d: number) => {
  const s = raw.toString().padStart(d + 1, "0");
  const f = s.slice(-d).replace(/0+$/, "");
  return f ? `${s.slice(0, -d)}.${f}` : s.slice(0, -d);
};

/**
 * Synthetic export in the real file formats: a v1 export of 25 holders plus a
 * derived (v2) export that adds one approved balance-exception owner, so the
 * floor (20% of $250,000) is re-divided over 26 holders.
 */
function writeSynthetic(dir: string) {
  const base = Array.from({ length: 25 }, (_, i) => ({ owner: synthOwner(`e${i}`), raw: BigInt(1_000_000 + i * 7_654_321 + (i % 3) * 13) }));
  const exc = { owner: synthOwner("exception"), raw: 55_555_555n };
  const eligible = [...base, exc];
  const excluded = [
    { owner: synthOwner("x0"), raw: 42_000_000n, reason: "off-curve;LP" },
    { owner: synthOwner("x1"), raw: 5n, reason: "off-curve" },
  ];
  const owners = eligible.map((e) => e.owner);
  const raws = eligible.map((e) => e.raw);
  const total = raws.reduce((a, b) => a + b, 0n);
  const al = allocateAll(raws, total, { mode: "largest_remainder", tie_break: "owner_address_asc" }, [
    { key: "s", decimals: 18, total: 1n },
    { key: "p", decimals: 12, total: 20n },
    { key: "u", decimals: 2, total: 50000n },
  ], owners);
  const eligibleCsv = ["owner_address,raw_balance,holder_share,full_raise_percentage,indicative_usd", ...eligible.map((e, i) => [e.owner, e.raw, al[i]!.s, al[i]!.p, al[i]!.u].join(","))].join("\n") + "\n";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  // The all-holder file is the base (v1) one: the exception owner is not in it,
  // and its USD column is the base export's (re-divided in v2).
  const all = [
    "owner,balance,pct_of_supply,eligible,exclusion_reason,provisional_allocation_usd",
    ...base.map((e) => [e.owner, fmtBal(e.raw, 6), "0", "yes", "", "0.00"].join(",")),
    ...excluded.map((x) => [x.owner, fmtBal(x.raw, 6), "0", "no", x.reason, ""].join(",")),
  ].join("\r\n") + "\r\n";
  const baseManifest = {
    snapshot: "7 Nov 2026",
    eligible_owners: base.length,
    reserve_percent: 20,
    full_raise_usd: "250000.00",
    reserve_usd: "50000.00",
    allocation_status: "provisional until raise",
    sha256: sha("SYNTHETIC base eligible csv"),
    team_exclusion: { basis: "SYNTHETIC", source: "SYNTHETIC e2e fixture", independently_verified: false },
  };
  const manifest = {
    snapshot: "7 Nov 2026",
    snapshot_slot: 1,
    eligible_owners: eligible.length,
    previous_eligible_owners: base.length,
    reserve_percent: 20,
    reserve_usd: "50000.00",
    totals: { indicative_usd: "50000.00", holder_share: "1.000000000000000000", full_raise_percentage: "20.000000000000" },
    previous_eligible_raw: base.reduce((a, e) => a + e.raw, 0n).toString(),
    new_eligible_raw: total.toString(),
    sha256: sha(eligibleCsv),
    source_sha256: baseManifest.sha256,
    override_file: "exception.json",
    rounding: { mode: "largest_remainder", tie_break: "owner_address_asc", share_decimals: 18, pct_decimals: 12, usd_decimals: 2 },
    allocation_status: "provisional until raise",
  };
  const exception = {
    type: "balance_exception_override",
    owner_address: exc.owner,
    raw_balance: exc.raw.toString(),
    decimals: 6,
    basis: "SYNTHETIC approved balance",
    authority: "SYNTHETIC approval",
    ordinary_snapshot_inclusion: false,
  };
  fs.writeFileSync(path.join(dir, "eligible.csv"), eligibleCsv);
  fs.writeFileSync(path.join(dir, "all.csv"), all);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "base-manifest.json"), JSON.stringify(baseManifest));
  fs.writeFileSync(path.join(dir, "exception.json"), JSON.stringify(exception));
  const xi = eligible.length - 1;
  const pick = [0, 12, 24];
  const cases = {
    eligible: pick.map((i) => ({ wallet: eligible[i]!.owner, balance: fmtBal(eligible[i]!.raw, 6), usd: al[i]!.u! })),
    excluded: { wallet: excluded[0]!.owner, reasons: ["Off-curve address", "Liquidity pool, vault or program-owned account"] },
    exception: { wallet: exc.owner, balance: fmtBal(exc.raw, 6), usd: al[xi]!.u! },
    unknown: synthOwner("nobody"),
    screenshots: true,
  };
  fs.writeFileSync(path.join(dir, "cases.json"), JSON.stringify(cases));
  return {
    files: { eligible: path.join(dir, "eligible.csv"), manifest: path.join(dir, "manifest.json"), all: path.join(dir, "all.csv") },
    extra: ["--base-manifest", path.join(dir, "base-manifest.json"), "--exception", path.join(dir, "exception.json")],
    cases: path.join(dir, "cases.json"),
    date: "2026-11-07",
    slot: "1",
    decimals: "6",
  };
}

async function waitFor(url: string, host: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await new Promise<boolean>((res) => {
      const u = new URL(url);
      const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (x) => {
        x.resume();
        res(x.statusCode === 200);
      });
      r.on("error", () => res(false));
      r.end();
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become ready");
}

async function run() {
  const mode = opt("--mode");
  const out = path.resolve(opt("--out") ?? "");
  if ((mode !== "synthetic" && mode !== "private") || !opt("--out")) throw new Error("usage: --mode synthetic|private --out <dir>");
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perc-alloc-e2e-"));
  fs.chmodSync(tmp, 0o700);
  const bin = pgBin();
  const data = path.join(tmp, "pg");
  const sock = path.join(tmp, "sock");
  fs.mkdirSync(sock);
  const pgPort = await freePort();
  let server: ChildProcess | null = null;
  const cleanup = () => {
    if (server && server.exitCode === null) server.kill("SIGTERM");
    spawnSync(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  try {
    execFileSync(path.join(bin, "initdb"), ["-D", data, "-U", "pgsuper", "--auth=trust", "-E", "UTF8", "--no-locale"], { stdio: "ignore" });
    execFileSync(path.join(bin, "pg_ctl"), ["-D", data, "-w", "-l", path.join(tmp, "pg.log"), "-o", `-p ${pgPort} -k ${sock} -c listen_addresses=127.0.0.1`, "start"], { stdio: "ignore" });
    const migratorPw = randomBytes(18).toString("hex");
    const readerPw = randomBytes(18).toString("hex");
    await withClient(`postgresql://pgsuper@127.0.0.1:${pgPort}/postgres`, async (c) => {
      await c.query(`create role migrator login createrole password '${migratorPw}'`);
      await c.query("create database app owner migrator");
      for (const r of ["anon", "authenticated", "service_role"]) await c.query(`create role ${r} nologin`);
    });
    const migratorUrl = `postgresql://migrator:${migratorPw}@127.0.0.1:${pgPort}/app`;
    await withClient(migratorUrl, (c) => c.query(fs.readFileSync(MIGRATION, "utf8")));
    await withClient(migratorUrl, (c) => c.query(`alter role perc_alloc_reader login password '${readerPw}'`));
    console.log("[e2e] local postgres ready, migration applied as non-superuser");

    let src: { files: { eligible: string; manifest: string; all: string }; extra: string[]; cases: string; date: string; slot: string; decimals: string };
    if (mode === "synthetic") src = writeSynthetic(tmp);
    else {
      const need = (n: string) => {
        const v = opt(n);
        if (!v) throw new Error(`missing ${n}`);
        return v;
      };
      src = {
        files: { eligible: need("--eligible"), manifest: need("--manifest"), all: need("--all-holders") },
        extra: [
          ...(opt("--base-manifest") ? ["--base-manifest", need("--base-manifest")] : []),
          ...(opt("--exception") ? ["--exception", need("--exception")] : []),
        ],
        cases: need("--cases"),
        date: need("--snapshot-date"),
        slot: need("--snapshot-slot"),
        decimals: need("--token-decimals"),
      };
    }
    process.env.ALLOCATION_IMPORT_DATABASE_URL = migratorUrl;
    await importMain([
      "--eligible", src.files.eligible, "--manifest", src.files.manifest, "--all-holders", src.files.all,
      "--snapshot-date", src.date, "--snapshot-slot", src.slot, "--token-decimals", src.decimals, ...src.extra, "--apply",
    ]);
    // Re-running the same import is a no-op (the active snapshot is unchanged).
    await importMain([
      "--eligible", src.files.eligible, "--manifest", src.files.manifest, "--all-holders", src.files.all,
      "--snapshot-date", src.date, "--snapshot-slot", src.slot, "--token-decimals", src.decimals, ...src.extra, "--apply",
    ]);
    const act = await withClient(migratorUrl, (c) =>
      c.query("select count(*)::int as n, max(eligible_csv_sha256) filter (where is_active) as sha from perc_alloc.snapshot"),
    );
    console.log(`[e2e] snapshots=${act.rows[0].n} active_eligible_csv_sha256=${act.rows[0].sha}`);
    delete process.env.ALLOCATION_IMPORT_DATABASE_URL;

    const port = await freePort();
    const serverLog = fs.openSync(path.join(out, `next-start-${mode}.log`), "w", 0o600);
    server = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: APP,
      env: {
        // Same placeholders the CI build uses (pr-check.yml); next.config requires them at start.
        NEXT_PUBLIC_API_URL: "http://localhost:4000",
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "dummy",
        NEXT_PUBLIC_PRIVY_APP_ID: "cltestappid00000000000000",
        ...process.env,
        NODE_ENV: "production",
        ALLOCATION_DATABASE_URL: `postgresql://perc_alloc_reader:${readerPw}@127.0.0.1:${pgPort}/app`,
        ALLOCATION_RATE_LIMIT_SECRET: randomBytes(32).toString("hex"),
      },
      stdio: ["ignore", serverLog, serverLog],
    });
    await waitFor(`http://127.0.0.1:${port}/api/allocation/status`, `percolator.trade:${port}`, 60_000);
    console.log("[e2e] next start ready");

    const pw = spawnSync("npx", ["playwright", "test", "-c", "playwright.allocation.config.ts"], {
      cwd: REPO,
      env: {
        ...process.env,
        ALLOC_E2E_PORT: String(port),
        ALLOC_E2E_CASES: src.cases,
        ALLOC_E2E_SHOTS: out,
        ALLOC_E2E_JSON: path.join(out, `playwright-${mode}.json`),
      },
      stdio: "inherit",
    });
    // Rows in the rate-limit table hold only hashed keys; show that, then the count.
    const rl = await withClient(migratorUrl, (c) =>
      c.query("select count(*)::int as n, min(octet_length(bucket)) as minlen, max(octet_length(bucket)) as maxlen from perc_alloc.rate_limit"),
    );
    console.log(`[e2e] rate_limit rows=${rl.rows[0].n} bucket_bytes=${rl.rows[0].minlen}..${rl.rows[0].maxlen}`);
    return pw.status ?? 1;
  } finally {
    cleanup();
  }
}

run().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[e2e] error: ${(e as Error).message}`);
    process.exit(2);
  },
);
