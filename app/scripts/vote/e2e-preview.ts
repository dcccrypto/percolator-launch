/**
 * Deployed-PREVIEW end-to-end harness for the PERC holder vote, against an
 * ISOLATED THROWAWAY Postgres (never the production allocation database).
 *
 *   setup: npx tsx app/scripts/vote/e2e-preview.ts setup --owner-url-file <0600 file> --private <0700 dir> \
 *            --confirm-throwaway-host <exact DB hostname>
 *   run:   npx tsx app/scripts/vote/e2e-preview.ts run --owner-url-file <0600 file> --private <0700 dir> \
 *            --confirm-throwaway-host <exact DB hostname> [--ca <CA pem, required for remote DBs>] --base https://<alias>.vercel.app --other-hosts <h1,h2> --out <evidence dir>
 *
 * setup
 *   - refuses unless ALL hold (it can never touch real data):
 *       * --confirm-throwaway-host equals the URL hostname exactly (operator names it);
 *       * the `public` schema has NO tables (a real waitlist/app DB has some);
 *       * perc_alloc is absent, or present with ONLY this harness's SYNTHETIC
 *         snapshot (never an empty or real one), and carries the harness marker;
 *   - applies the checker + vote migrations as the throwaway owner role;
 *   - gives perc_alloc_reader a fresh random password; seeds a SYNTHETIC snapshot
 *     of freshly generated keypairs (balances 1:2:3:4 + one excluded);
 *   - writes <private>/voters.json and <private>/preview.env (0600) holding the
 *     THROWAWAY runtime values for `vercel deploy -e/-b`. Nothing is printed.
 * run
 *   - runs e2e/vote.spec.ts in REMOTE mode; an optional deployment-protection token is
 *     taken from VERCEL_OIDC_TOKEN in the environment (never printed).
 *
 * The poll is started only inside the throwaway database.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
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
const SYNTHETIC_LABEL = "SYNTHETIC vote preview e2e";

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n: string): string => {
  const i = argv.indexOf(n);
  const v = i > 0 ? argv[i + 1] : undefined;
  if (!v || v.startsWith("--")) throw new Error(`${n} is required`);
  return v;
};
const MARKER = "perc_vote_preview_e2e_throwaway";

function privateFile(p: string): string {
  const st = fs.statSync(p);
  if ((st.mode & 0o077) !== 0) throw new Error(`${p} must not be group/world readable`);
  return fs.readFileSync(p, "utf8").trim();
}
function privateDir(p: string): string {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  fs.chmodSync(p, 0o700);
  return p;
}
/** Remote throwaway DBs: verified TLS only (CA from --ca, never rejectUnauthorized:false). */
function caFor(url: string): string | null {
  if (new URL(url).hostname === "127.0.0.1") return null;
  return fs.readFileSync(arg("--ca"), "utf8");
}
function clientFor(url: string): Client {
  const ca = caFor(url);
  // drop URL query params so they cannot override the TLS decision
  const u = new URL(url);
  u.search = "";
  return new Client({ connectionString: u.toString(), ...(ca ? { ssl: { rejectUnauthorized: true, ca } } : {}) });
}
async function withClient<T>(url: string, fn: (c: Client) => Promise<T>) {
  const c = clientFor(url);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function assertHost(ownerUrl: string) {
  const host = new URL(ownerUrl).hostname;
  if (arg("--confirm-throwaway-host") !== host) throw new Error("REFUSING: --confirm-throwaway-host does not equal the DB hostname");
  if (!/\.(neon\.tech|supabase\.co|supabase\.com)$/.test(host) && host !== "127.0.0.1") throw new Error("REFUSING: unexpected throwaway DB host");
}

/** fresh=true: setup may initialise a pristine DB. fresh=false: the harness marker must already exist. */
async function assertThrowaway(c: Client, fresh: boolean) {
  const pub = await c.query("select count(*)::int as n from pg_tables where schemaname = 'public'");
  if (pub.rows[0].n !== 0) throw new Error("REFUSING: public schema has tables (not a throwaway DB)");
  const has = (await c.query("select to_regclass('perc_alloc.snapshot') is not null as has")).rows[0].has;
  const marked = (await c.query("select obj_description(oid, 'pg_namespace') = $1 as m from pg_namespace where nspname = 'perc_alloc'", [MARKER])).rows[0]?.m === true;
  if (!has) {
    if (!fresh) throw new Error("REFUSING: harness marker missing (run setup first)");
    return;
  }
  if (!marked) throw new Error("REFUSING: perc_alloc exists without the harness marker (not created by this harness)");
  const r = await c.query("select count(*)::int as n, count(*) filter (where label <> $1)::int as real from perc_alloc.snapshot", [SYNTHETIC_LABEL]);
  if (r.rows[0].real !== 0 || r.rows[0].n === 0) throw new Error("REFUSING: target database holds a non-synthetic or empty snapshot set");
}

async function setup() {
  const ownerUrl = privateFile(arg("--owner-url-file"));
  const dir = privateDir(path.resolve(arg("--private")));
  assertHost(ownerUrl);
  await withClient(ownerUrl, (c) => assertThrowaway(c, true));
  // Fresh run: drop a previous SYNTHETIC preview poll/snapshot so the run starts NOT STARTED.
  await withClient(ownerUrl, async (c) => {
    if ((await c.query("select to_regclass('perc_vote.poll') is not null as has")).rows[0].has) {
      await c.query("begin");
      await c.query("delete from perc_vote.ballot; delete from perc_vote.nonce; delete from perc_vote.poll; delete from perc_alloc.rate_limit");
      await c.query("delete from perc_alloc.holder; delete from perc_alloc.snapshot");
      await c.query("commit");
    }
  });
  for (const m of MIGRATIONS) await withClient(ownerUrl, (c) => c.query(fs.readFileSync(m, "utf8")));
  await withClient(ownerUrl, (c) => c.query(`comment on schema perc_alloc is '${MARKER}'`));
  const readerPw = randomBytes(24).toString("hex");
  await withClient(ownerUrl, (c) => c.query(`alter role perc_alloc_reader login password '${readerPw}'`));

  const kps = Array.from({ length: 5 }, () => nacl.sign.keyPair());
  const raws = [1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n];
  const holders: HolderRow[] = raws.map((raw, i) => ({
    owner: bs58.encode(kps[i]!.publicKey), eligible: true, balanceRaw: raw, allocationCents: [500n, 1000n, 1500n, 2000n][i]!, reasons: [], basis: "snapshot",
  }));
  holders.push({ owner: bs58.encode(kps[4]!.publicKey), eligible: false, balanceRaw: 9n, allocationCents: 0n, reasons: ["off-curve"], basis: "snapshot" });
  await withClient(ownerUrl, (c) =>
    applySnapshot(c, {
      meta: {
        label: SYNTHETIC_LABEL, snapshotDate: "2000-01-01", snapshotSlot: 1n, tokenDecimals: 6, fullRaiseCents: 25_000n,
        floorPercent: "20", floorCents: 5_000n, eligibleCsvSha256: "e".repeat(64), allHoldersCsvSha256: "f".repeat(64),
        manifestSha256: "9".repeat(64), teamExclusionBasis: "SYNTHETIC", teamExclusionVerified: false,
        exceptionOwners: 0, exceptionBasis: null, exceptionFilesSha256: [], baseManifestSha256: null,
      },
      holders, eligibleCount: 4, excludedCount: 1, eligibleRawTotal: 10_000_000n,
    }),
  );
  fs.writeFileSync(
    path.join(dir, "voters.json"),
    JSON.stringify({ eligible: kps.slice(0, 4).map((k) => bs58.encode(k.secretKey)), excluded: bs58.encode(kps[4]!.secretKey) }),
    { mode: 0o600 },
  );
  const reader = new URL(ownerUrl);
  reader.username = "perc_alloc_reader";
  reader.password = readerPw;
  const env = {
    ALLOCATION_DATABASE_URL: reader.toString(),
    ALLOCATION_RATE_LIMIT_SECRET: randomBytes(32).toString("hex"),
    VOTE_ADMIN_SECRET: randomBytes(32).toString("hex"),
  };
  fs.writeFileSync(path.join(dir, "preview.env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  const n = await withClient(ownerUrl, (c) => c.query("select (select count(*) from perc_vote.poll)::int as polls, (select count(*) from perc_alloc.holder)::int as holders"));
  console.log(`[vote-preview] throwaway DB ready: migrations applied, synthetic holders=${n.rows[0].holders}, polls=${n.rows[0].polls}`);
}

async function run() {
  const ownerUrl = privateFile(arg("--owner-url-file"));
  const dir = path.resolve(arg("--private"));
  const base = arg("--base");
  const others = arg("--other-hosts");
  const out = privateDir(path.resolve(arg("--out")));
  assertHost(ownerUrl);
  await withClient(ownerUrl, (c) => assertThrowaway(c, false));
  const env = Object.fromEntries(privateFile(path.join(dir, "preview.env")).split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const pw = spawnSync("npx", ["playwright", "test", "-c", "playwright.vote.config.ts"], {
    cwd: REPO,
    env: {
      NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME,
      VOTE_E2E_BASE: base,
      VOTE_E2E_OTHER_HOSTS: others,
      // optional: only needed if the project enables Deployment Protection on previews
      ...(process.env.VERCEL_OIDC_TOKEN ? { VOTE_E2E_OIDC: process.env.VERCEL_OIDC_TOKEN } : {}),
      VOTE_E2E_VOTERS: path.join(dir, "voters.json"),
      VOTE_E2E_ADMIN: env.VOTE_ADMIN_SECRET!,
      VOTE_E2E_SUPER_URL: ownerUrl,
      ...(caFor(ownerUrl) ? { VOTE_E2E_SUPER_CA: caFor(ownerUrl)! } : {}),
      VOTE_E2E_SHOTS: out,
      VOTE_E2E_JSON: path.join(out, "playwright-vote.json"),
    },
    stdio: "inherit",
  });
  const n = await withClient(ownerUrl, (c) =>
    c.query("select (select count(*) from perc_vote.ballot)::int as ballots, (select count(*) from perc_vote.nonce)::int as nonces, (select count(*) from perc_vote.poll)::int as polls"),
  );
  console.log(`[vote-preview] throwaway-db ballots=${n.rows[0].ballots} nonces=${n.rows[0].nonces} polls=${n.rows[0].polls}`);
  return pw.status ?? 1;
}

(cmd === "setup" ? setup().then(() => 0) : cmd === "run" ? run() : Promise.reject(new Error("usage: setup|run (see header)"))).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[vote-preview] error: ${(e as Error).message}`);
    process.exit(2);
  },
);
