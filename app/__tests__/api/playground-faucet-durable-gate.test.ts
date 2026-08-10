/**
 * PoC + regression — the playground faucet's per-wallet limit must be durable.
 *
 * /api/playground/faucet gates on an in-memory `Map` (wallet → last-claim ts).
 * That Map is process-local, so a serverless cold start (or landing on a
 * different warm instance) resets it — the same wallet can re-claim inside its
 * 1h window by hitting a fresh instance. /api/faucet and /api/auto-fund avoid
 * this by backing the gate with the shared `faucet_claims` table (tryFaucetGate)
 * and only falling back to in-memory when Supabase is unavailable.
 *
 * This models the two stores: a per-instance in-memory gate loses its state when
 * the instance recycles, while a durable (shared) gate keyed on (wallet, window)
 * still denies the second claim. tryFaucetGate's window is 24h by default; the
 * fix threads a per-call windowMs so the playground faucet keeps its 1h window
 * while gaining durability.
 */
import { describe, it, expect } from "vitest";

// A per-instance in-memory gate (what the route uses today).
function makeInMemoryGate(windowMs: number) {
  const store = new Map<string, number>();
  return {
    allow(wallet: string, now: number): boolean {
      const last = store.get(wallet);
      if (last !== undefined && now - last < windowMs) return false;
      store.set(wallet, now);
      return true;
    },
  };
}

// A durable gate — shared state that survives an instance recycle (models the DB row).
function makeDurableGate(windowMs: number, shared: Map<string, number>) {
  return {
    allow(wallet: string, now: number): boolean {
      const last = shared.get(wallet);
      if (last !== undefined && now - last < windowMs) return false;
      shared.set(wallet, now);
      return true;
    },
  };
}

const ONE_HOUR = 60 * 60 * 1000;

describe("playground faucet: durable per-wallet gate", () => {
  it("in-memory gate lets one wallet re-claim after an instance recycle (the bug)", () => {
    const now = 1_000_000;
    let gate = makeInMemoryGate(ONE_HOUR);
    expect(gate.allow("W", now)).toBe(true);        // first claim
    expect(gate.allow("W", now + 60_000)).toBe(false); // blocked, same instance
    gate = makeInMemoryGate(ONE_HOUR);               // <-- cold start / new instance
    expect(gate.allow("W", now + 60_000)).toBe(true);  // re-claims within the hour
  });

  it("durable gate denies re-claim within the window even across recycles (the fix)", () => {
    const now = 1_000_000;
    const shared = new Map<string, number>();        // survives instance recycle
    let gate = makeDurableGate(ONE_HOUR, shared);
    expect(gate.allow("W", now)).toBe(true);
    gate = makeDurableGate(ONE_HOUR, shared);         // new instance, same shared store
    expect(gate.allow("W", now + 60_000)).toBe(false); // still blocked — 1h window holds
    expect(gate.allow("W", now + ONE_HOUR + 1)).toBe(true); // window elapsed → allowed
  });
});
