/**
 * Local end-to-end harness for the PERC holder vote. LOCAL ONLY: a throwaway
 * Postgres on 127.0.0.1 in a 0700 temp dir + `next start`, both torn down on
 * exit. It never reads any real dataset or connects to any remote database.
 *
 *   npx tsx app/scripts/vote/e2e-local.ts --out <evidence dir>
 *
 * 1. temp cluster, checker + vote migrations applied as a non-superuser
 * 2. SYNTHETIC snapshot: freshly generated Ed25519 keypairs (never reused)
 * 3. `next start` (production build must exist) with random runtime secrets
 * 4. Playwright e2e/vote.spec.ts: API flow with genuinely signed messages and
 *    the /vote UI with an injected Wallet Standard wallet that signs in Node
 *
 * The poll is started only inside this throwaway database.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Client } from "pg";
import { applySnapshot, type HolderRow } from "./../allocation/import-lib";

const APP = path.resolve(__dirname, "../..");
const REPO = path.resolve(APP, "..");
const MIGRATIONS = [
  "supabase/waitlist-migrations/20261108000000_perc_alloc_private_lookup.sql",
  "supabase/waitlist-migrations/20261108010000_perc_vote.sql",
  "supabase/waitlist-migrations/20261108020000_perc_private_rls.sql",
].map((m) => path.join(REPO, m));

const argv = process.argv.slice(2);
const out = path.resolve(argv[argv.indexOf("--out") + 1] ?? "");
if (!argv.includes("--out")) throw new Error("usage: --out <dir>");

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
async function waitFor(port: number, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const code = await new Promise<number>((res) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/api/vote/status", headers: { host: `percolator.trade:${port}` } }, (x) => {
        x.resume();
        res(x.statusCode ?? 0);
      });
      r.on("error", () => res(0));
      r.end();
    });
    if (code === 200) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become ready");
}

async function run() {
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perc-vote-e2e-"));
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
    for (const m of MIGRATIONS) await withClient(migratorUrl, (c) => c.query(fs.readFileSync(m, "utf8")));
    await withClient(migratorUrl, (c) => c.query(`alter role perc_alloc_reader login password '${readerPw}'`));
    console.log("[vote-e2e] local postgres ready, both migrations applied as non-superuser");

    // SYNTHETIC voters: fresh keypairs. Balances 1:2:3:4 (+ one excluded).
    const kps = Array.from({ length: 5 }, () => nacl.sign.keyPair());
    const raws = [1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n];
    const holders: HolderRow[] = raws.map((raw, i) => ({
      owner: bs58.encode(kps[i]!.publicKey), eligible: true, balanceRaw: raw, allocationCents: [500n, 1000n, 1500n, 2000n][i]!, reasons: [], basis: "snapshot",
    }));
    holders.push({ owner: bs58.encode(kps[4]!.publicKey), eligible: false, balanceRaw: 9n, allocationCents: 0n, reasons: ["off-curve"], basis: "snapshot" });
    await withClient(migratorUrl, (c) =>
      applySnapshot(c, {
        meta: {
          label: "SYNTHETIC vote e2e", snapshotDate: "2000-01-01", snapshotSlot: 1n, tokenDecimals: 6, fullRaiseCents: 25_000n,
          floorPercent: "20", floorCents: 5_000n, eligibleCsvSha256: "e".repeat(64), allHoldersCsvSha256: "f".repeat(64),
          manifestSha256: "9".repeat(64), teamExclusionBasis: "SYNTHETIC", teamExclusionVerified: false,
          exceptionOwners: 0, exceptionBasis: null, exceptionFilesSha256: [], baseManifestSha256: null,
        },
        holders, eligibleCount: 4, excludedCount: 1, eligibleRawTotal: 10_000_000n,
      }),
    );
    const voterFile = path.join(tmp, "voters.json");
    fs.writeFileSync(
      voterFile,
      JSON.stringify({ eligible: kps.slice(0, 4).map((k) => bs58.encode(k.secretKey)), excluded: bs58.encode(kps[4]!.secretKey) }),
      { mode: 0o600 },
    );

    const port = await freePort();
    const adminSecret = randomBytes(32).toString("hex");
    const serverLog = fs.openSync(path.join(out, "next-start.log"), "w", 0o600);
    server = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: APP,
      env: {
        NEXT_PUBLIC_API_URL: "http://localhost:4000",
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "dummy",
        NEXT_PUBLIC_PRIVY_APP_ID: "cltestappid00000000000000",
        ...process.env,
        NODE_ENV: "production",
        ALLOCATION_DATABASE_URL: `postgresql://perc_alloc_reader:${readerPw}@127.0.0.1:${pgPort}/app`,
        ALLOCATION_RATE_LIMIT_SECRET: randomBytes(32).toString("hex"),
        VOTE_ADMIN_SECRET: adminSecret,
      },
      stdio: ["ignore", serverLog, serverLog],
    });
    await waitFor(port, 60_000);
    console.log("[vote-e2e] next start ready");

    const pw = spawnSync("npx", ["playwright", "test", "-c", "playwright.vote.config.ts"], {
      cwd: REPO,
      env: {
        ...process.env,
        VOTE_E2E_PORT: String(port),
        VOTE_E2E_VOTERS: voterFile,
        VOTE_E2E_ADMIN: adminSecret,
        VOTE_E2E_SUPER_URL: `postgresql://pgsuper@127.0.0.1:${pgPort}/app`,
        VOTE_E2E_SHOTS: out,
        VOTE_E2E_JSON: path.join(out, "playwright-vote.json"),
      },
      stdio: "inherit",
    });
    const counts = await withClient(migratorUrl.replace(`migrator:${migratorPw}`, "pgsuper"), (c) =>
      c.query("select (select count(*) from perc_vote.ballot)::int as ballots, (select count(*) from perc_vote.nonce)::int as nonces, (select count(*) from perc_vote.poll)::int as polls"),
    );
    console.log(`[vote-e2e] local-db ballots=${counts.rows[0].ballots} nonces=${counts.rows[0].nonces} polls=${counts.rows[0].polls}`);
    return pw.status ?? 1;
  } finally {
    cleanup();
  }
}

run().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[vote-e2e] error: ${(e as Error).message}`);
    process.exit(2);
  },
);
