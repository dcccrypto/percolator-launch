/**
 * A missing faucet_claims table must NOT read as "rate limited".
 *
 * tryFaucetGate's pre-check treated every SELECT error as a denial:
 *
 *     if (preCheckError) return { allowed: false, nextClaimAt: null };
 *
 * When the table did not exist the SELECT returned PGRST205, so the gate
 * answered "Already pre-funded recently" to EVERY caller — including a wallet's
 * first ever request. And because it RETURNED rather than threw, the caller's
 * catch (which engages the durable Blob fallback) never ran, so there was no
 * second chance. Market creation failed at the deposit step for everyone: the
 * wizard could not fund the LP seed and reported a rate limit on a wallet that
 * had never been funded.
 *
 * Fail-closed is still right for a transient DB error — a faucet must not open
 * because the database hiccuped. The distinction is between "I cannot answer"
 * (schema missing → hand off to the fallback gate) and "something went wrong"
 * (deny).
 */
import { describe, it, expect } from "vitest";
import { tryFaucetGate } from "@/lib/faucet-rate-gate";

/** Minimal Supabase stub whose pre-check SELECT fails with `code`. */
function supabaseFailingWith(code: string, message = "boom") {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    eq: self,
    gte: self,
    lt: self,
    delete: self,
    insert: self,
    maybeSingle: async () => ({ data: null, error: { code, message } }),
  });
  return { from: () => chain };
}

describe("tryFaucetGate — unavailable table vs transient error", () => {
  it("THROWS on PGRST205 so the caller falls back to the durable gate", async () => {
    await expect(
      tryFaucetGate(supabaseFailingWith("PGRST205", "Could not find the table"), "w", "sol"),
    ).rejects.toThrow(/unavailable/i);
  });

  it("THROWS on 42P01 (undefined_table) for the same reason", async () => {
    await expect(
      tryFaucetGate(supabaseFailingWith("42P01", "relation does not exist"), "w", "sol"),
    ).rejects.toThrow(/unavailable/i);
  });

  it("still FAILS CLOSED on a transient error — a blip must not open the faucet", async () => {
    const gate = await tryFaucetGate(supabaseFailingWith("57014", "statement timeout"), "w", "sol");
    expect(gate.allowed).toBe(false);
  });
});
