/**
 * GH#2216 — tryFaucetGate must fail CLOSED on database errors.
 *
 * The gate's invariant: no durable claim reservation → no server-funded
 * transaction. Previously, a Supabase outage (pre-check error, unexpected
 * INSERT error, or a thrown exception) returned `allowed: true` with no
 * claimId, letting requests reach the SOL-airdrop / MintTo path unmetered.
 *
 * These tests drive the REAL tryFaucetGate with a mock Supabase client.
 */
import { describe, it, expect } from "vitest";
import { tryFaucetGate } from "@/lib/faucet-rate-gate";

type SupabaseResult = { data: unknown; error: { code?: string; message: string } | null };

/**
 * Minimal Supabase mock: `results` are consumed in call order —
 * pre-check SELECT, (DELETE), INSERT, [23505 re-SELECT].
 * The DELETE step is auto-inserted since the gate ignores its result.
 */
function mockSupabase(results: SupabaseResult[]) {
  let call = 0;
  const withDelete: Array<SupabaseResult | "delete"> = [results[0]!, "delete", ...results.slice(1)];

  const next = () => {
    const r = withDelete[call++];
    if (r === "delete") return { data: null, error: null };
    return r ?? { data: null, error: null };
  };

  const chain = () => {
    const promise = new Promise((resolve) => queueMicrotask(() => resolve(next())));
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === "then") return promise.then.bind(promise);
        if (prop === "catch") return promise.catch.bind(promise);
        if (prop === "finally") return promise.finally.bind(promise);
        return () => new Proxy({}, handler);
      },
    };
    return new Proxy({}, handler);
  };

  return { from: () => chain() };
}

describe("GH#2216 — tryFaucetGate fails closed on DB errors", () => {
  it("denies (degraded) when the pre-check SELECT returns an error", async () => {
    const supabase = mockSupabase([
      { data: null, error: { code: "08006", message: "connection failure" } },
    ]);
    const gate = await tryFaucetGate(supabase, "WALLET_A", "sol");
    expect(gate.allowed).toBe(false);
    expect(gate.degraded).toBe(true);
    expect(gate.claimId).toBeUndefined();
  });

  it("denies (degraded) when the gate INSERT returns an unexpected error", async () => {
    const supabase = mockSupabase([
      { data: null, error: null }, // pre-check: no active claim
      { data: null, error: { code: "57014", message: "statement timeout" } }, // INSERT
    ]);
    const gate = await tryFaucetGate(supabase, "WALLET_A", "sol");
    expect(gate.allowed).toBe(false);
    expect(gate.degraded).toBe(true);
    expect(gate.claimId).toBeUndefined();
  });

  it("denies (degraded) when the Supabase client throws", async () => {
    const supabase = {
      from: () => {
        throw new Error("fetch failed");
      },
    };
    const gate = await tryFaucetGate(supabase, "WALLET_A", "sol");
    expect(gate.allowed).toBe(false);
    expect(gate.degraded).toBe(true);
  });

  it("still allows a first-time claim when the DB is healthy (not degraded)", async () => {
    const supabase = mockSupabase([
      { data: null, error: null }, // pre-check: no active claim
      { data: { id: 7, claimed_at: new Date().toISOString() }, error: null }, // INSERT wins
    ]);
    const gate = await tryFaucetGate(supabase, "WALLET_A", "sol");
    expect(gate.allowed).toBe(true);
    expect(gate.degraded).toBeUndefined();
    expect(gate.claimId).toBe(7);
  });

  it("still returns a plain rate-limit denial (not degraded) on 23505 conflict", async () => {
    const claimedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const supabase = mockSupabase([
      { data: null, error: null }, // pre-check: no active claim (race)
      { data: null, error: { code: "23505", message: "duplicate key" } }, // INSERT loses race
      { data: { claimed_at: claimedAt }, error: null }, // re-SELECT existing row
    ]);
    const gate = await tryFaucetGate(supabase, "WALLET_A", "sol");
    expect(gate.allowed).toBe(false);
    expect(gate.degraded).toBeUndefined();
    expect(gate.nextClaimAt).not.toBeNull();
  });
});
