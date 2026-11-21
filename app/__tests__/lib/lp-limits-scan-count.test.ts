// @vitest-environment node
/**
 * Review (PR #4005): the asset-0 bound-vault fallback ran a full getProgramAccounts scan on
 * EVERY read (the limits card polls every 20s), because a bound vault LP whose matcher is
 * disabled never passes the canonical resolver, so nothing was cached.
 *
 * - asset 0's vault is bound to the known LP: the scan cannot pick anything else (market-lp
 *   rule 4a), so it must not run at all;
 * - otherwise a scan result (including "no LP") is cached per market for a short TTL.
 *
 * The real resolveMarketLp runs here; only the RPC connection is faked, so the counted
 * getProgramAccounts calls are the real scans.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { marketOffsets } from "@/lib/v22/market-offsets";
import * as C from "@/lib/limits/constants";
import { v22BlankMarket, v22BlankPortfolio } from "../helpers/v22-fixtures";
import { invalidateLpAccounts, resolveLpAccounts } from "@/lib/limits/lp-discovery";

function fixture(bindKnownLp: boolean) {
  const program = Keypair.generate().publicKey;
  const market = Keypair.generate().publicKey;
  const knownLp = Keypair.generate().publicKey;

  const marketData = v22BlankMarket();
  if (bindKnownLp) {
    const base = marketOffsets(marketData).wrapperOff(0) + C.ASSET_VAULT_LP_OFF;
    marketData.set(knownLp.toBytes(), base + C.AV_VAULT_LP_PORTFOLIO);
    marketData[base + C.AV_FLAGS] = C.ASSET_VAULT_LP_FLAG_BOUND;
  }

  // A real portfolio of this market whose matcher config is disabled (a vault LP that has
  // not enabled a matcher): it never qualifies as the canonical trading LP.
  const portfolio = v22BlankPortfolio();
  portfolio.set(market.toBytes(), 16);
  portfolio.set(knownLp.toBytes(), 48);

  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) =>
      key.equals(market)
        ? { owner: program, data: marketData }
        : key.equals(knownLp)
          ? { owner: program, data: portfolio }
          : null,
    ),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(() => null)),
    getProgramAccounts: vi.fn(async () => []),
  };
  return { program, market, knownLp, connection };
}

beforeEach(() => {
  __setDevnetV22ForTest(true);
});

afterEach(() => {
  vi.useRealTimers();
  __setDevnetV22ForTest(null);
});

describe("LP limits discovery: getProgramAccounts budget", () => {
  it("asset 0 bound to the known LP: repeated reads never scan, and still return the vault LP", async () => {
    const f = fixture(true);
    for (let i = 0; i < 3; i++) {
      const r = await resolveLpAccounts(f.connection as never, f.program, f.market, f.knownLp, 0);
      expect(r?.lpPortfolio.equals(f.knownLp)).toBe(true);
      expect(r?.matcherCtx).toBeNull();
    }
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(0);
  });

  it("asset 0 bound to the known LP: a revoked binding is still seen on the next read", async () => {
    const f = fixture(true);
    expect((await resolveLpAccounts(f.connection as never, f.program, f.market, f.knownLp, 0))?.lpPortfolio.equals(f.knownLp)).toBe(true);
    // Revoke: the market now has no bound vault LP.
    const marketData = (await f.connection.getAccountInfo(f.market))!.data;
    const base = marketOffsets(marketData).wrapperOff(0) + C.ASSET_VAULT_LP_OFF;
    marketData.fill(0, base + C.AV_VAULT_LP_PORTFOLIO, base + C.AV_VAULT_LP_PORTFOLIO + 32);
    marketData[base + C.AV_FLAGS] = 0;
    expect(await resolveLpAccounts(f.connection as never, f.program, f.market, f.knownLp, 0)).toBeNull();
  });

  it("no bound vault: a scan that finds no LP is cached per market for a short TTL, then rescanned", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T00:00:00Z"));
    const f = fixture(false);

    for (let i = 0; i < 3; i++) {
      expect(await resolveLpAccounts(f.connection as never, f.program, f.market, null, 0)).toBeNull();
    }
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(1);

    // Another market is not served from this market's cache.
    const g = fixture(false);
    expect(await resolveLpAccounts(g.connection as never, g.program, g.market, null, 0)).toBeNull();
    expect(g.connection.getProgramAccounts).toHaveBeenCalledTimes(1);

    // After the short TTL the market is scanned again.
    vi.setSystemTime(new Date("2026-11-21T00:01:01Z"));
    expect(await resolveLpAccounts(f.connection as never, f.program, f.market, null, 0)).toBeNull();
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it("no bound vault: invalidation forces a fresh scan inside the TTL", async () => {
    const f = fixture(false);
    await resolveLpAccounts(f.connection as never, f.program, f.market, null, 0);
    invalidateLpAccounts(f.program, f.market);
    await resolveLpAccounts(f.connection as never, f.program, f.market, null, 0);
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it("a failed scan is not cached: the next read retries", async () => {
    const f = fixture(false);
    f.connection.getProgramAccounts.mockRejectedValueOnce(new Error("getProgramAccounts: 429"));
    await expect(resolveLpAccounts(f.connection as never, f.program, f.market, null, 0)).rejects.toThrow("429");
    expect(await resolveLpAccounts(f.connection as never, f.program, f.market, null, 0)).toBeNull();
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(2);
  });
});
