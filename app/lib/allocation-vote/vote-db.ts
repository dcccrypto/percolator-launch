/**
 * The vote's database calls: one parameterized call of a perc_vote SECURITY
 * DEFINER function each, over the checker's runtime-role pool. The role has
 * no table privileges, so nothing here can list voters or ballots.
 */
import "server-only";
import type { AllocationConfig } from "./server-config";
import { getPool } from "./lookup-db";
import type { VoteChoice } from "./vote-message";

export interface StatusRow {
  outcome: string; retry_after_seconds: number; state: string | null; poll_key: string | null;
  starts_at: string | null; ends_at: string | null; server_now: string | null;
}
export interface NonceRow {
  outcome: string; retry_after_seconds: number; poll_key: string | null; nonce: string | null;
  issued_at: string | null; expires_at: string | null; message: string | null;
}
export interface CastRow {
  outcome: string; retry_after_seconds: number; choice: string | null; revision: number | null;
  cast_at: string | null; ends_at: string | null;
}
export interface TallyRow {
  outcome: string; retry_after_seconds: number; state: string | null; poll_key: string | null; ends_at: string | null;
  weekly_fee_claims_raw: string | null; buy_and_burn_raw: string | null;
  weekly_fee_claims_wallets: number | null; buy_and_burn_wallets: number | null;
  eligible_raw_total: string | null; eligible_wallets: number | null; token_decimals: number | null; winner: string | null;
}
export interface StartRow { outcome: string; starts_at: string | null; ends_at: string | null; snapshot_label: string | null }

async function one<T>(cfg: AllocationConfig, text: string, values: unknown[]): Promise<T | undefined> {
  const r = await getPool(cfg).query({ text, values });
  return r.rows.length === 1 ? (r.rows[0] as T) : undefined;
}

export const voteDb = {
  status: (cfg: AllocationConfig, key: Buffer) =>
    one<StatusRow>(cfg, "select * from perc_vote.status($1::bytea)", [key]),
  issueNonce: (cfg: AllocationConfig, wallet: string, choice: VoteChoice, key: Buffer) =>
    one<NonceRow>(cfg, "select * from perc_vote.issue_nonce($1::text, $2::text, $3::bytea)", [wallet, choice, key]),
  cast: (
    cfg: AllocationConfig,
    v: { wallet: string; choice: VoteChoice; nonce: string; issuedAt: string; expiresAt: string; message: string; signature: Uint8Array },
    key: Buffer,
  ) =>
    one<CastRow>(cfg, "select * from perc_vote.cast_vote($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::bytea, $8::bytea)", [
      v.wallet, v.choice, v.nonce, v.issuedAt, v.expiresAt, v.message, Buffer.from(v.signature), key,
    ]),
  tally: (cfg: AllocationConfig, key: Buffer) => one<TallyRow>(cfg, "select * from perc_vote.tally($1::bytea)", [key]),
  submitGate: async (cfg: AllocationConfig, key: Buffer): Promise<number> => {
    const r = await one<{ retry: number }>(cfg, "select perc_vote.submit_gate($1::bytea) as retry", [key]);
    return typeof r?.retry === "number" ? r.retry : 3600;
  },
  adminGate: async (cfg: AllocationConfig, key: Buffer): Promise<number> => {
    const r = await one<{ retry: number }>(cfg, "select perc_vote.admin_gate($1::bytea) as retry", [key]);
    return typeof r?.retry === "number" ? r.retry : 3600;
  },
  start: (cfg: AllocationConfig, pollKey: string) =>
    one<StartRow>(cfg, "select * from perc_vote.start_poll($1::text)", [pollKey]),
};

/** Log a database failure by error code only (no values, no connection details). */
export function logDbError(where: string, e: unknown): void {
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "unknown";
  console.error(`[vote] ${where} failed (${code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16)})`);
}
