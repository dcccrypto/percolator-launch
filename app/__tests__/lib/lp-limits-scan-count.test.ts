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
import { V17_PORTFOLIO_IDENTITY_TRAILER_LEN, deriveMatcherDelegate } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { marketOffsets } from "@/lib/v22/market-offsets";
import * as C from "@/lib/limits/constants";
import { v22BlankMarket, v22BlankPortfolio } from "../helpers/v22-fixtures";
import { invalidateLpAccounts, resolveLpAccounts } from "@/lib/limits/lp-discovery";
import { resolveMarketLp } from "@/lib/market-lp";

const MATCHER = Keypair.generate().publicKey;

function fixture(bindKnownLp: boolean, matcherEnabled = false) {
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
  const portfolio = new Uint8Array(v22BlankPortfolio());
  portfolio.set(market.toBytes(), 16);
  portfolio.set(knownLp.toBytes(), 48);

  // matcherEnabled: an eligible LP (enabled matcher config + a ctx bound to the derived delegate).
  const ctx = Keypair.generate().publicKey;
  const ctxData = new Uint8Array(400);
  if (matcherEnabled) {
    const owner = Keypair.generate().publicKey;
    portfolio.set(owner.toBytes(), 80);
    portfolio.set(owner.toBytes(), 116);
    const cfgOff = portfolio.length - 104 - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
    const [delegate] = deriveMatcherDelegate(program, market, knownLp, owner, MATCHER, ctx);
    portfolio.set(MATCHER.toBytes(), cfgOff);
    portfolio.set(ctx.toBytes(), cfgOff + 32);
    portfolio.set(delegate.toBytes(), cfgOff + 64);
    const dv = new DataView(portfolio.buffer);
    dv.setBigUint64(cfgOff + 96, 1n, true);
    dv.setBigUint64(portfolio.length - V17_PORTFOLIO_IDENTITY_TRAILER_LEN, 1n, true); // portfolio_id
    ctxData.set(delegate.toBytes(), 80);
  }

  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) =>
      key.equals(market)
        ? { owner: program, data: marketData }
        : key.equals(knownLp)
          ? { owner: program, data: portfolio }
          : null,
    ),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) =>
      keys.map((k) => (matcherEnabled && k.equals(ctx) ? { owner: MATCHER, data: ctxData } : null)),
    ),
    getProgramAccounts: vi.fn(async (): Promise<unknown[]> => []),
  };
  return { program, market, knownLp, ctx, portfolio, connection };
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
    // No longer bound to the known LP: the canonical scan runs again.
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it("asset 0 bound to an eligible LP: the no-scan answer equals the full scan's (LP + bound matcher ctx)", async () => {
    const f = fixture(true, true);
    const r = await resolveLpAccounts(f.connection as never, f.program, f.market, f.knownLp, 0);
    expect(r?.lpPortfolio.equals(f.knownLp)).toBe(true);
    expect(r?.matcherCtx?.equals(f.ctx)).toBe(true);
    expect(r?.degraded).toBeUndefined();
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(0);

    f.connection.getProgramAccounts.mockResolvedValue([{ pubkey: f.knownLp, account: { data: f.portfolio } }]);
    const full = await resolveMarketLp(f.connection as never, f.program, f.market, null);
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(full?.pubkey.equals(r!.lpPortfolio)).toBe(true);
    expect(full?.matcherCtx.equals(r!.matcherCtx!)).toBe(true);
  });

  it("scan: false throws a known-LP RPC failure instead of falling through to a scan", async () => {
    const f = fixture(true, true);
    const healthy = f.connection.getAccountInfo.getMockImplementation()!;
    f.connection.getAccountInfo.mockImplementation(async (key: PublicKey) => {
      if (key.equals(f.knownLp)) throw new Error("getAccountInfo: 429");
      return healthy(key);
    });
    await expect(resolveMarketLp(f.connection as never, f.program, f.market, f.knownLp, { scan: false })).rejects.toThrow("429");
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(0);
  });

  it("a failed canonical read answered by the bound-vault fallback is marked degraded (matcher unknown, not absent)", async () => {
    const f = fixture(true, true);
    f.connection.getMultipleAccountsInfo.mockRejectedValue(new Error("getMultipleAccounts: 429"));
    const r = await resolveLpAccounts(f.connection as never, f.program, f.market, f.knownLp, 0);
    expect(r?.lpPortfolio.equals(f.knownLp)).toBe(true);
    expect(r?.matcherCtx).toBeNull();
    expect(r?.degraded).toBe(true);
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(0);
  });

  it("a transient binding/fallback read error is not cached as a miss", async () => {
    const f = fixture(true);
    const healthy = f.connection.getAccountInfo.getMockImplementation()!;
    let marketReads = 0;
    // Read 1: the binding check fails (scan path), the scan finds nothing, the fallback's market read fails.
    f.connection.getAccountInfo.mockImplementation(async (key: PublicKey) => {
      if (key.equals(f.market) && ++marketReads !== 2) throw new Error("getAccountInfo: 429");
      return healthy(key);
    });
    expect(await resolveLpAccounts(f.connection as never, f.program, f.market, f.knownLp, 0)).toBeNull();
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(1);

    f.connection.getAccountInfo.mockImplementation(healthy);
    const r = await resolveLpAccounts(f.connection as never, f.program, f.market, f.knownLp, 0);
    expect(r?.lpPortfolio.equals(f.knownLp)).toBe(true);
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(1);
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

  it("fresh: a fail-closed read never gets a cached miss, but still uses a cached hit", async () => {
    const f = fixture(false);
    expect(await resolveLpAccounts(f.connection as never, f.program, f.market, null, 0)).toBeNull();
    expect(await resolveLpAccounts(f.connection as never, f.program, f.market, null, 0, { fresh: true })).toBeNull();
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(2);

    const g = fixture(true, true);
    g.connection.getProgramAccounts.mockResolvedValue([{ pubkey: g.knownLp, account: { data: g.portfolio } }]);
    expect((await resolveLpAccounts(g.connection as never, g.program, g.market, null, 0))?.lpPortfolio.equals(g.knownLp)).toBe(true);
    expect((await resolveLpAccounts(g.connection as never, g.program, g.market, null, 0, { fresh: true }))?.lpPortfolio.equals(g.knownLp)).toBe(true);
    expect(g.connection.getProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it("a failed scan is not cached: the next read retries", async () => {
    const f = fixture(false);
    f.connection.getProgramAccounts.mockRejectedValueOnce(new Error("getProgramAccounts: 429"));
    await expect(resolveLpAccounts(f.connection as never, f.program, f.market, null, 0)).rejects.toThrow("429");
    expect(await resolveLpAccounts(f.connection as never, f.program, f.market, null, 0)).toBeNull();
    expect(f.connection.getProgramAccounts).toHaveBeenCalledTimes(2);
  });
});
