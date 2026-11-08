/**
 * The single database call behind the allocation checker: one parameterized
 * call of perc_alloc.check_allocation for one owner. The runtime role can do
 * nothing else (no table privileges), so this module cannot list holders.
 *
 * No result is cached anywhere: every request is its own lookup, and the pool
 * shares connections only, never rows.
 */
import "server-only";
import { Pool } from "pg";
import type { AllocationConfig } from "./server-config";
import type { CheckRow } from "./check-result";

const SQL =
  "select outcome, retry_after_seconds, eligible, balance_raw, token_decimals, " +
  "allocation_usd_cents::text as allocation_usd_cents, exclusion_reasons, snapshot_label, allocation_status, balance_basis " +
  "from perc_alloc.check_allocation($1::text, $2::bytea)";

let pool: Pool | null = null;
let poolKey = "";

/** Shared with the vote (vote-db.ts): one small pool per instance for the one runtime role. */
export function getPool(cfg: AllocationConfig): Pool {
  const key = `${cfg.connectionString}|${cfg.ssl ? "tls" : "local"}`;
  if (pool && poolKey === key) return pool;
  if (pool) void pool.end().catch(() => {});
  pool = new Pool({
    connectionString: cfg.connectionString,
    ssl: cfg.ssl ?? false,
    max: 3,
    idleTimeoutMillis: 10 * 1000,
    connectionTimeoutMillis: 3 * 1000,
    query_timeout: 5 * 1000,
    application_name: "perc-alloc-check",
    allowExitOnIdle: true,
  });
  // An idle client error must not crash the function; the next query reconnects.
  pool.on("error", () => {});
  poolKey = key;
  return pool;
}

export async function lookupAllocation(cfg: AllocationConfig, owner: string, clientKey: Buffer): Promise<CheckRow | undefined> {
  const r = await getPool(cfg).query<CheckRow>({ text: SQL, values: [owner, clientKey] });
  return r.rows.length === 1 ? r.rows[0] : undefined;
}
