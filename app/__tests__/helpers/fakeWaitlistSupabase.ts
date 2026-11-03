/**
 * A minimal in-memory stand-in for the waitlist service client — just the
 * calls lib/playground-gate makes: `.from("waitlist").select().eq().maybeSingle()`
 * and `.rpc("waitlist_position" | "waitlist_position_by_email")`.
 *
 * Positions are computed the way the real RPC does (row_number over created
 * order), from the array order of `rows`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type FakeRow = {
  id: string;
  privy_did?: string | null;
  pubkey?: string | null;
  email?: string | null;
  referral_code?: string | null;
};

export type FakeOptions = {
  /** Make `.maybeSingle()` report an error for this column. */
  failColumn?: "privy_did" | "pubkey" | "email";
  /** Make every `.rpc()` report an error. */
  failRpc?: boolean;
  /** Override the RPC's answer (e.g. null for "row vanished"). */
  rpcValue?: number | null;
  /** Make every `.update()` report an error with this Postgres code. */
  failUpdate?: string;
};

export function fakeWaitlistSupabase(rows: FakeRow[], opts: FakeOptions = {}) {
  const calls: { kind: "eq" | "ilike" | "rpc" | "update"; column?: string; value?: unknown; fn?: string }[] = [];
  const client = {
    from(table: string) {
      if (table !== "waitlist") throw new Error(`unexpected table ${table}`);
      return {
        update(patch: Record<string, unknown>) {
          return {
            eq(column: string, value: unknown) {
              return {
                async is(nullCol: string) {
                  calls.push({ kind: "update", column: nullCol, value: patch });
                  if (opts.failUpdate) return { data: null, error: { message: "update failed", code: opts.failUpdate } };
                  const r = rows.find((x) => (x as Record<string, unknown>)[column] === value);
                  if (r && (r as Record<string, unknown>)[nullCol] == null) Object.assign(r, patch);
                  return { data: null, error: null };
                },
              };
            },
          };
        },
        select() {
          const shape = (hit: FakeRow | null) => ({
            data: hit
              ? { id: hit.id, pubkey: hit.pubkey ?? null, email: hit.email ?? null, referral_code: hit.referral_code ?? null, privy_did: hit.privy_did ?? null }
              : null,
            error: null,
          });
          return {
            ilike(column: string, pattern: string) {
              calls.push({ kind: "ilike", column, value: pattern });
              const want = pattern.replace(/\\([\\%_])/g, "$1").toLowerCase();
              return {
                limit() {
                  return {
                    async maybeSingle() {
                      if (opts.failColumn === column) return { data: null, error: { message: "boom", code: "XX000" } };
                      const hit = rows.find((r) => String((r as Record<string, unknown>)[column] ?? "").toLowerCase() === want) ?? null;
                      return shape(hit);
                    },
                  };
                },
              };
            },
            eq(column: string, value: unknown) {
              calls.push({ kind: "eq", column, value });
              return {
                async maybeSingle() {
                  if (opts.failColumn === column) return { data: null, error: { message: "boom", code: "XX000" } };
                  const hit = rows.find((r) => (r as Record<string, unknown>)[column] === value) ?? null;
                  return {
                    data: hit
                      ? { id: hit.id, pubkey: hit.pubkey ?? null, email: hit.email ?? null, referral_code: hit.referral_code ?? null }
                      : null,
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ kind: "rpc", fn });
      if (opts.failRpc) return { data: null, error: { message: "rpc down" } };
      if (opts.rpcValue !== undefined) return { data: opts.rpcValue, error: null };
      const col = fn === "waitlist_position" ? "pubkey" : "email";
      const val = fn === "waitlist_position" ? args.p_pubkey : args.p_email;
      const idx = rows.findIndex((r) => (r as Record<string, unknown>)[col] === val);
      return { data: idx >= 0 ? idx + 1 : null, error: null };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

/** `n` filler members ahead of whoever is appended after. */
export function fillerRows(n: number): FakeRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `filler-${i}`,
    pubkey: `FILLERPUBKEY${i}`,
    referral_code: `F${i}`,
  }));
}
