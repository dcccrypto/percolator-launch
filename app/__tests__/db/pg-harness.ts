/**
 * Throwaway local Postgres cluster for the PERC allocation DB tests.
 *
 * Never connects anywhere but a temp cluster on 127.0.0.1 that this file
 * creates and destroys. Simulates the Supabase role layout that matters here:
 * a non-superuser migrator with CREATEROLE that owns the database (like
 * Supabase's `postgres`), plus `anon`, `authenticated` and `service_role`.
 *
 * Skips (returns null from findPgBin) when no Postgres binaries are installed,
 * e.g. on CI runners without postgres; the skip is reported by each suite.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "pg";

export const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../supabase/waitlist-migrations/20261108000000_perc_alloc_private_lookup.sql",
);

export function findPgBin(): string | null {
  const candidates = [
    process.env.PERC_ALLOC_PG_BIN,
    (() => {
      try {
        return execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
      } catch {
        return undefined;
      }
    })(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "initdb")) && fs.existsSync(path.join(c, "pg_ctl"))) return c;
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface Cluster {
  port: number;
  /** superuser (test setup only: simulates out-of-band operator actions) */
  superUrl: string;
  /** non-superuser migrator, like Supabase's `postgres` */
  migratorUrl: string;
  /** runtime role, the only one the app uses */
  readerUrl: string;
  stop(): void;
}

export const READER_PASSWORD = "local-test-only-reader-password";

export async function startCluster(bin: string): Promise<Cluster> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perc-alloc-pg-"));
  const data = path.join(dir, "data");
  const sock = path.join(dir, "sock");
  fs.mkdirSync(sock);
  const port = await freePort();
  execFileSync(path.join(bin, "initdb"), ["-D", data, "-U", "pgsuper", "--auth=trust", "-E", "UTF8", "--no-locale"], {
    stdio: "ignore",
  });
  execFileSync(
    path.join(bin, "pg_ctl"),
    ["-D", data, "-w", "-l", path.join(dir, "log"), "-o", `-p ${port} -k ${sock} -c listen_addresses=127.0.0.1`, "start"],
    { stdio: "ignore" },
  );
  const stop = () => {
    spawnSync(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const su = new Client({ host: "127.0.0.1", port, user: "pgsuper", database: "postgres" });
    await su.connect();
    await su.query(`create role migrator login createrole password 'migrator'`);
    await su.query(`create database app owner migrator`);
    for (const r of ["anon", "authenticated", "service_role"]) await su.query(`create role ${r} nologin`);
    await su.end();
    // Supabase-style default ACLs (per database, so on `app`): everything the
    // migrator creates is granted to the API roles unless the migration revokes it.
    const ad = new Client({ host: "127.0.0.1", port, user: "pgsuper", database: "app" });
    await ad.connect();
    for (const kind of ["tables", "functions", "sequences"]) {
      await ad.query(`alter default privileges for role migrator grant all on ${kind} to anon, authenticated, service_role`);
    }
    await ad.end();
  } catch (e) {
    stop();
    throw e;
  }
  const url = (u: string, p: string) => `postgresql://${u}:${p}@127.0.0.1:${port}/app`;
  return {
    port,
    superUrl: `postgresql://pgsuper@127.0.0.1:${port}/app`,
    migratorUrl: url("migrator", "migrator"),
    readerUrl: url("perc_alloc_reader", READER_PASSWORD),
    stop,
  };
}

export async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Apply the migration as the non-superuser migrator, then the out-of-band login grant. */
export async function migrate(cluster: Cluster): Promise<void> {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  await withClient(cluster.migratorUrl, (c) => c.query(sql));
  // Out-of-band operator step (documented in the migration, never in the repo):
  await withClient(cluster.migratorUrl, (c) =>
    c.query(`alter role perc_alloc_reader login password '${READER_PASSWORD}'`),
  );
}
