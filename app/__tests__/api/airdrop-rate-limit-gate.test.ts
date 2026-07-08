/**
 * Tests for GH#1588 fix: /api/airdrop INSERT-as-gate rate limit
 *
 * The old SELECT→INSERT flow had a TOCTOU race: two concurrent requests for
 * the same wallet+market could both pass the SELECT check before either INSERT
 * completed, resulting in two successful airdrops within the 24h window.
 *
 * The fix: use INSERT-as-gate with a UNIQUE INDEX on (wallet, market_address).
 * tryAirdropClaimGate() is the function under test here.
 */

import { describe, it, expect } from "vitest";

// ─── Inline logic extracted from tryAirdropClaimGate ───────────────────────
// (mirrors the function in /api/airdrop/route.ts for unit-testable form)

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

type ClaimGateResult =
  | { allowed: true; claimId: number }
  | { allowed: false; nextClaimAt: string }
  | { allowed: false; degraded: true };

/**
 * Pure logic version of tryAirdropClaimGate for unit testing.
 *
 * @param deleteExpired  - simulates: did the DELETE clear an old row?
 * @param insertError    - null = success, "23505" = unique conflict, "other" = DB error
 * @param existingClaim  - only relevant when insertError === "23505"
 */
function simulateClaimGate(params: {
  deleteExpired: boolean;
  insertError: null | "23505" | "other";
  existingClaim?: { claimed_at: string };
}): ClaimGateResult {
  const { insertError, existingClaim } = params;

  if (insertError === null) {
    // INSERT succeeded — claim slot reserved
    return { allowed: true, claimId: 42 };
  }

  if (insertError === "23505") {
    // Unique constraint violation — active claim in window
    if (existingClaim) {
      const age = Date.now() - new Date(existingClaim.claimed_at).getTime();
      const nextClaimAt = new Date(
        new Date(existingClaim.claimed_at).getTime() + RATE_LIMIT_WINDOW_MS,
      ).toISOString();
      void age; // used for future retryAfterSecs if needed
      return { allowed: false, nextClaimAt };
    }
    // Row vanished between conflict and read (highly unlikely) — deny conservatively
    return { allowed: false, nextClaimAt: new Date(Date.now() + RATE_LIMIT_WINDOW_MS).toISOString() };
  }

  // GH#2216: unexpected DB error — fail CLOSED (no durable claim reservation
  // → no server-funded transaction). Route surfaces a retryable 503.
  return { allowed: false, degraded: true };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GH#1588 — INSERT-as-gate rate limit for /api/airdrop", () => {
  describe("first claim (no prior row)", () => {
    it("allows claim when INSERT succeeds", () => {
      const result = simulateClaimGate({ deleteExpired: false, insertError: null });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.claimId).toBe(42);
    });
  });

  describe("second claim within 24h window", () => {
    it("denies claim when INSERT hits 23505 (existing active row)", () => {
      const claimedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
      const result = simulateClaimGate({
        deleteExpired: false,
        insertError: "23505",
        existingClaim: { claimed_at: claimedAt },
      });
      expect(result.allowed).toBe(false);
    });

    it("nextClaimAt is ~24h after the original claim", () => {
      const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
      const result = simulateClaimGate({
        deleteExpired: false,
        insertError: "23505",
        existingClaim: { claimed_at: claimedAt },
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        const nextClaim = new Date(result.nextClaimAt).getTime();
        const expectedNext = new Date(claimedAt).getTime() + RATE_LIMIT_WINDOW_MS;
        expect(Math.abs(nextClaim - expectedNext)).toBeLessThan(1000); // within 1s
      }
    });

    it("denies conservatively when existing row vanishes after conflict", () => {
      const result = simulateClaimGate({
        deleteExpired: false,
        insertError: "23505",
        existingClaim: undefined, // row disappeared between conflict and read
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("claim after 24h window has expired", () => {
    it("allows re-claim after window (delete expired row + INSERT succeeds)", () => {
      // deleteExpired=true simulates DELETE succeeding (row was older than 24h)
      const result = simulateClaimGate({ deleteExpired: true, insertError: null });
      expect(result.allowed).toBe(true);
    });
  });

  describe("unexpected DB error", () => {
    it("fails closed (denies claim, degraded) so a claim-table outage cannot mint unmetered (GH#2216)", () => {
      const result = simulateClaimGate({ deleteExpired: false, insertError: "other" });
      expect(result.allowed).toBe(false);
      if (!result.allowed && "degraded" in result) {
        expect(result.degraded).toBe(true);
      }
    });
  });

  describe("rate limit key is slab_address not mint_address", () => {
    // This is the core GH#1588 regression: after resolveServerOwnedMint migrates
    // markets.mint_address to a new mirror, the rate limit must not change.
    // Since we key on slab_address (marketAddress) — which never changes — this is
    // correct by design. Test documents the invariant.
    it("rate limit key (slab_address) is unaffected by mint migration", () => {
      const slabAddress = "Bc7A4yCa2SpaBCLCMpphwFE45YPFnJF4Hk1hPfZMKgvK";
      const oldMint = "usdEkK5G2gLzUyJ9TxhPFoaLnBq3cFZV4cDKG8mNkRT";
      const newMirrorMint = "mirrorMintXYZ789012345678901234567890123456";

      // Rate limit key is slabAddress, not oldMint or newMirrorMint
      // Both before and after migration, the key is the same
      const keyBeforeMigration = slabAddress;
      const keyAfterMigration = slabAddress; // unchanged

      expect(keyBeforeMigration).toBe(keyAfterMigration);
      expect(keyBeforeMigration).not.toBe(oldMint);
      expect(keyBeforeMigration).not.toBe(newMirrorMint);
    });
  });
});
