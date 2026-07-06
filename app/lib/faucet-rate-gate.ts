/**
 * GH#1595: INSERT-as-gate rate limiter for faucet + auto-fund.
 *
 * Uses the `faucet_claims` table with UNIQUE(wallet, fund_type).
 * Concurrent requests race on INSERT — exactly one wins, others get 23505.
 * Eliminates the SELECT→INSERT TOCTOU window.
 *
 * GH#1803: Pre-check SELECT added before INSERT to catch rate-limited wallets
 * immediately, before any INSERT attempt or RPC call. Prevents fail-open on
 * transient DB errors (cold connection, etc.) from allowing rate-limited wallets
 * to reach the RPC path and receive a confusing "devnet unavailable" error.
 *
 * Airdrop routes (`/api/airdrop`, `/api/devnet-airdrop`) use the same pre-check +
 * INSERT-as-gate shape.
 */

const RATE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface GateResult {
  allowed: boolean;
  nextClaimAt: string | null;
  claimId?: number;
}

/**
 * Attempt to claim a faucet rate-limit slot.
 *
 * @param supabase  Service-role Supabase client
 * @param wallet    Wallet address
 * @param fundType  "sol" | "usdc" | "auto-fund"
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryFaucetGate(supabase: any, wallet: string, fundType: string): Promise<GateResult> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_MS).toISOString();

  try {
    // GH#1803: Step 0 — Pre-check SELECT FIRST.
    // Catches rate-limited wallets BEFORE any INSERT or RPC call attempt.
    // This is the canonical rate-limit check: if an active claim exists in the
    // window, return denied immediately without touching the INSERT path.
    // Prevents fail-open on INSERT errors (e.g., cold DB connection on first call)
    // from allowing rate-limited wallets to reach the RPC airdrop path.
    //
    // Note: this does NOT re-introduce the TOCTOU race fixed by GH#1595.
    // The race applies to concurrent FIRST-time requests (two requests both see
    // no row and race to INSERT). For already-rate-limited wallets (active claim
    // already exists), the SELECT reliably returns the row without any race.
    const { data: activeClaim, error: preCheckError } = await supabase
      .from("faucet_claims")
      .select("claimed_at")
      .eq("wallet", wallet)
      .eq("fund_type", fundType)
      .gte("claimed_at", windowStart)
      .maybeSingle();

    if (preCheckError) {
      console.warn(`[faucet-gate] pre-check SELECT error: ${preCheckError.message}`);
      return { allowed: false, nextClaimAt: null };
    }

    if (activeClaim) {
      const nextClaimAt = new Date(
        new Date(activeClaim.claimed_at as string).getTime() + RATE_LIMIT_MS,
      ).toISOString();
      return { allowed: false, nextClaimAt };
    }

    // Step 1: Clear expired claim so unique slot is free for re-claim.
    await supabase
      .from("faucet_claims")
      .delete()
      .eq("wallet", wallet)
      .eq("fund_type", fundType)
      .lt("claimed_at", windowStart);

    // Step 2: INSERT-as-gate — race winner records the claim; all others hit 23505.
    const { data, error } = await supabase
      .from("faucet_claims")
      .insert({ wallet, fund_type: fundType, claimed_at: new Date().toISOString() })
      .select("id, claimed_at")
      .maybeSingle();

    if (error) {
      if (error.code === "23505") {
        // Concurrent request won the INSERT race — compute nextClaimAt from existing row.
        const { data: existing } = await supabase
          .from("faucet_claims")
          .select("claimed_at")
          .eq("wallet", wallet)
          .eq("fund_type", fundType)
          .maybeSingle();

        const nextClaimAt = existing
          ? new Date(new Date(existing.claimed_at as string).getTime() + RATE_LIMIT_MS).toISOString()
          : null;
        return { allowed: false, nextClaimAt };
      }

      // Unexpected DB error — fail closed
      console.warn(`[faucet-gate] INSERT error (code=${error.code}): ${error.message}`);
      return { allowed: false, nextClaimAt: null };
    }

    return { allowed: true, nextClaimAt: null, claimId: (data as { id: number } | null)?.id };
  } catch (err) {
    console.warn("[faucet-gate] threw:", err instanceof Error ? err.message : String(err));
    return { allowed: false, nextClaimAt: null };
  }
}

/**
 * Release a faucet claim slot (on mint failure so user isn't locked out).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function releaseFaucetClaim(supabase: any, claimId: number): Promise<void> {
  const { error } = await supabase.from("faucet_claims").delete().eq("id", claimId);
  if (error) {
    console.warn(`[faucet-gate] release failed (id=${claimId}): ${error.message}`);
  }
}
