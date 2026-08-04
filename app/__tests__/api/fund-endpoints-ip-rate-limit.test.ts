/**
 * PoC + regression — fund endpoints must be rate-limited per-IP, not only per-wallet.
 *
 * /api/faucet, /api/playground/faucet, /api/auto-fund and /api/devnet-airdrop each
 * gate on the caller-supplied WALLET only (1 claim per wallet per window). Every
 * mint/airdrop spends the shared DEVNET_MINT_AUTHORITY_KEYPAIR's SOL, so an
 * attacker generating fresh keypairs bypasses the gate entirely and can drain the
 * shared signer (playground-wide DoS) — unlike /api/devnet-mirror-mint, which
 * already applies a per-IP limit.
 *
 * This shows a per-wallet gate lets one IP make unlimited claims via fresh
 * wallets, while a per-IP limiter (the fix, reusing the app's own
 * createUpstashRateLimiter) caps one IP regardless of wallet.
 */
import { describe, it, expect } from "vitest";
import { createUpstashRateLimiter } from "@/lib/upstash-rate-limit";

describe("fund endpoints: per-IP rate limiting", () => {
  it("a per-wallet gate lets ONE IP drain via fresh keypairs (the bug)", () => {
    const claimedWallets = new Set<string>();
    const perWalletGate = (wallet: string): boolean => {
      if (claimedWallets.has(wallet)) return false; // already claimed this window
      claimedWallets.add(wallet);
      return true;
    };
    let allowed = 0;
    // One attacker, one IP, 100 freshly-generated wallets:
    for (let i = 0; i < 100; i++) if (perWalletGate(`freshWallet_${i}`)) allowed++;
    expect(allowed).toBe(100); // every claim goes through — no per-IP bound
  });

  it("a per-IP limiter caps one IP regardless of wallet (the fix)", async () => {
    // No Upstash env in tests → deterministic in-memory sliding window.
    const limiter = createUpstashRateLimiter({ limit: 10, windowMs: 60_000, prefix: "rl:test-fund-poc" });
    const attackerIp = "203.0.113.7";
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      const r = await limiter.check(attackerIp); // wallet is irrelevant to the IP key
      if (r.allowed) allowed++;
    }
    expect(allowed).toBe(10);          // hard per-IP cap holds
    const after = await limiter.check(attackerIp);
    expect(after.allowed).toBe(false);
    expect(after.retryAfterSecs).toBeGreaterThan(0);
  });

  it("a different IP has its own independent budget", async () => {
    const limiter = createUpstashRateLimiter({ limit: 10, windowMs: 60_000, prefix: "rl:test-fund-poc2" });
    for (let i = 0; i < 10; i++) await limiter.check("198.51.100.1"); // exhaust IP A
    const b = await limiter.check("198.51.100.2");                    // IP B unaffected
    expect(b.allowed).toBe(true);
  });
});
