// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { V17_PORTFOLIO_IDENTITY_TRAILER_LEN, deriveMatcherDelegate } from "@percolatorct/sdk";

const vaultMock = vi.hoisted(() => ({ fn: null as null | ((d: Uint8Array, i: number) => unknown) }));
vi.mock("@/lib/v22/records", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/records")>();
  return {
    ...real,
    decodeAssetVaultLpP3: (d: Uint8Array, i: number) => (vaultMock.fn ? vaultMock.fn(d, i) : real.decodeAssetVaultLpP3(d, i)),
  };
});

import {
  selectMarketLp,
  selectMarketLpsFromScan,
  resolveMarketLp,
  readEnabledMatcherConfig,
  marketPortfolioFilters,
  ctxAddressesToFetch,
  PORTFOLIO_MARKET_GROUP_OFF,
  type CtxRow,
  type PortfolioRow,
} from "@/lib/market-lp";
import { assetProfileOff } from "@/lib/v18-wire";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { blankMarket, blankPortfolio } from "../helpers/v22-fixtures";

const PROGRAM = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const MATCHER = new PublicKey("EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX");
const MARKET = Keypair.generate().publicKey;
const CREATOR = Keypair.generate().publicKey;

function marketData(admin: PublicKey | null): Uint8Array {
  const d = isDevnetV22Enabled() ? blankMarket() : new Uint8Array(33_900);
  d[10] = 1;
  if (admin) d.set(admin.toBytes(), assetProfileOff(0, d) + 368);
  return d;
}

interface Pf { row: PortfolioRow; ctx: PublicKey; ctxRow: CtxRow }

function portfolio(opts: { pubkey?: PublicKey; owner?: PublicKey; id: bigint; enabled?: boolean; market?: PublicKey }): Pf {
  const pubkey = opts.pubkey ?? Keypair.generate().publicKey;
  const owner = opts.owner ?? CREATOR;
  const market = opts.market ?? MARKET;
  const ctx = Keypair.generate().publicKey;
  const d = new Uint8Array(blankPortfolio());
  d.set(market.toBytes(), 16);
  d.set(pubkey.toBytes(), 48);
  d.set(owner.toBytes(), 80);
  d.set(owner.toBytes(), 116);
  const cfgOff = d.length - 104 - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
  const [delegate] = deriveMatcherDelegate(PROGRAM, market, pubkey, owner, MATCHER, ctx);
  d.set(MATCHER.toBytes(), cfgOff);
  d.set(ctx.toBytes(), cfgOff + 32);
  d.set(delegate.toBytes(), cfgOff + 64);
  const dv = new DataView(d.buffer);
  dv.setBigUint64(cfgOff + 96, opts.enabled === false ? 0n : 1n, true);
  dv.setBigUint64(d.length - V17_PORTFOLIO_IDENTITY_TRAILER_LEN, opts.id, true);
  const ctxData = new Uint8Array(400);
  ctxData.set(delegate.toBytes(), 80);
  return { row: { pubkey, data: d }, ctx, ctxRow: { owner: MATCHER, data: ctxData } };
}

const ctxMap = (pfs: Pf[]) => new Map<string, CtxRow | null>(pfs.map((p) => [p.ctx.toBase58(), p.ctxRow]));
const infoOf = (data: Uint8Array, owner: PublicKey) => ({ data: Buffer.from(data), owner, lamports: 1, executable: false });

beforeEach(() => {
  vaultMock.fn = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("selectMarketLp: P3 vault LP (rule 4a)", () => {
  const lp = portfolio({ owner: CREATOR, id: 1n });
  const other = portfolio({ owner: CREATOR, id: 2n });

  it("a bound vault LP is returned with reason vault-lp, even if the admin owns another", () => {
    vaultMock.fn = () => ({ bound: true, vaultLpPortfolio: other.row.pubkey });
    const r = selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: marketData(CREATOR), portfolios: [lp.row, other.row], ctxs: ctxMap([lp, other]), complete: true });
    expect(r?.reason).toBe("vault-lp");
    expect(r?.pubkey.equals(other.row.pubkey)).toBe(true);
    expect(r?.portfolioId).toBe(2n);
    expect(r?.owner.equals(CREATOR)).toBe(true);
    expect(r?.matcherProg.equals(MATCHER)).toBe(true);
  });

  it("a bound vault LP that is not eligible yields null (no fallback to admin/launch)", () => {
    vaultMock.fn = () => ({ bound: true, vaultLpPortfolio: Keypair.generate().publicKey });
    const r = selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: marketData(CREATOR), portfolios: [lp.row], ctxs: ctxMap([lp]), complete: true });
    expect(r).toBeNull();
  });

  it("unbound / missing vault portfolio / decoder throwing all fall through to the admin rule", () => {
    for (const fn of [
      () => ({ bound: false, vaultLpPortfolio: other.row.pubkey }),
      () => ({ bound: true, vaultLpPortfolio: null }),
      () => { throw new Error("no P3 state"); },
    ]) {
      vaultMock.fn = fn;
      const r = selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: marketData(CREATOR), portfolios: [lp.row], ctxs: ctxMap([lp]), complete: true });
      expect(r?.reason).toBe("asset-admin");
    }
  });
});

describe("selectMarketLp: warnings and edge inputs", () => {
  it("several admin-owned candidates: lowest portfolio_id wins and it is logged", () => {
    const a = portfolio({ id: 5n });
    const b = portfolio({ id: 3n });
    const r = selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: marketData(CREATOR), portfolios: [a.row, b.row], ctxs: ctxMap([a, b]), complete: true });
    expect(r?.portfolioId).toBe(3n);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("2 admin-owned LP candidates"));
  });

  it("equal portfolio ids tie-break deterministically by pubkey, independent of input order", () => {
    const a = portfolio({ id: 4n });
    const b = portfolio({ id: 4n });
    const run = (rows: Pf[]) => selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: marketData(CREATOR), portfolios: rows.map((p) => p.row), ctxs: ctxMap(rows), complete: true });
    expect(run([a, b])?.pubkey.toBase58()).toBe(run([b, a])?.pubkey.toBase58());
  });

  it("empty portfolio list is null (complete or not)", () => {
    for (const complete of [true, false]) {
      expect(selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: marketData(null), portfolios: [], ctxs: new Map(), complete })).toBeNull();
    }
  });

  it("missing ctx account (null / absent) or short ctx data refuses the candidate", () => {
    const p = portfolio({ id: 1n });
    const base = { programId: PROGRAM, market: MARKET, marketData: marketData(CREATOR), portfolios: [p.row], complete: true };
    expect(selectMarketLp({ ...base, ctxs: new Map([[p.ctx.toBase58(), null]]) })).toBeNull();
    expect(selectMarketLp({ ...base, ctxs: new Map() })).toBeNull();
    const short = { owner: MATCHER, data: p.ctxRow.data.subarray(0, 100) };
    expect(selectMarketLp({ ...base, ctxs: new Map([[p.ctx.toBase58(), short]]) })).toBeNull();
  });

  it("a config whose delegate is not the derived one is refused", () => {
    const p = portfolio({ id: 1n });
    const cfgOff = p.row.data.length - 104 - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
    p.row.data.set(Keypair.generate().publicKey.toBytes(), cfgOff + 64);
    expect(selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: marketData(CREATOR), portfolios: [p.row], ctxs: ctxMap([p]), complete: true })).toBeNull();
  });

  it("garbage market data (unreadable admin) is treated as no admin", () => {
    const p = portfolio({ id: 1n });
    const r = selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: new Uint8Array(4), portfolios: [p.row], ctxs: ctxMap([p]), complete: true });
    expect(r === null || r.reason === "launch-portfolio").toBe(true);
  });

  it("rows with a wrong provenance account id or non-portfolio data are skipped", () => {
    const p = portfolio({ id: 1n });
    const wrongId = { pubkey: Keypair.generate().publicKey, data: p.row.data };
    const junk = { pubkey: Keypair.generate().publicKey, data: new Uint8Array(10) };
    expect(selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: marketData(CREATOR), portfolios: [wrongId, junk], ctxs: ctxMap([p]), complete: true })).toBeNull();
  });
});

describe("readEnabledMatcherConfig / ctxAddressesToFetch / filters", () => {
  it("returns the config for an enabled portfolio and null for disabled, junk and empty data", () => {
    const on = portfolio({ id: 1n });
    const off = portfolio({ id: 2n, enabled: false });
    const cfg = readEnabledMatcherConfig(on.row.data);
    expect(cfg?.matcherProg.equals(MATCHER)).toBe(true);
    expect(cfg?.matcherCtx.equals(on.ctx)).toBe(true);
    expect(readEnabledMatcherConfig(off.row.data)).toBeNull();
    expect(readEnabledMatcherConfig(new Uint8Array(0))).toBeNull();
    expect(readEnabledMatcherConfig(new Uint8Array(500))).toBeNull();
  });

  it("ctxAddressesToFetch skips disabled configs and dedupes the same ctx", () => {
    const a = portfolio({ id: 1n });
    const off = portfolio({ id: 2n, enabled: false });
    expect(ctxAddressesToFetch([a.row, a.row, off.row]).map((k) => k.toBase58())).toEqual([a.ctx.toBase58()]);
    expect(ctxAddressesToFetch([])).toEqual([]);
  });

  it("marketPortfolioFilters pins the magic at 0 and the market at the provenance offset", () => {
    const f = marketPortfolioFilters(MARKET);
    expect(f).toHaveLength(2);
    expect(f[0].memcmp.offset).toBe(0);
    expect(Buffer.from(f[0].memcmp.bytes, "base64")).toEqual(Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]));
    expect(f[1].memcmp).toEqual({ offset: PORTFOLIO_MARKET_GROUP_OFF, bytes: MARKET.toBase58() });
  });
});

describe("resolveMarketLp", () => {
  const lp = portfolio({ id: 1n });
  const mkt = marketData(CREATOR);

  function conn(over: Record<string, unknown>) {
    return {
      getAccountInfo: vi.fn(async () => null),
      getProgramAccounts: vi.fn(async () => []),
      getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((k) => (k.equals(lp.ctx) ? infoOf(lp.ctxRow.data, MATCHER) : null))),
      ...over,
    } as unknown as Connection & Record<string, ReturnType<typeof vi.fn>>;
  }

  it("market account missing -> null without scanning", async () => {
    const c = conn({});
    expect(await resolveMarketLp(c, PROGRAM, MARKET)).toBeNull();
    expect(c.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("full scan finds the LP and fetches its ctx", async () => {
    const c = conn({
      getAccountInfo: vi.fn(async () => infoOf(mkt, PROGRAM)),
      getProgramAccounts: vi.fn(async () => [{ pubkey: lp.row.pubkey, account: infoOf(lp.row.data, PROGRAM) }]),
    });
    const r = await resolveMarketLp(c, PROGRAM, MARKET);
    expect(r?.pubkey.equals(lp.row.pubkey)).toBe(true);
    expect(r?.reason).toBe("asset-admin");
    expect(c.getProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it("scan with no portfolios -> null; unreadable ctx (null) -> null", async () => {
    const c = conn({ getAccountInfo: vi.fn(async () => infoOf(mkt, PROGRAM)) });
    expect(await resolveMarketLp(c, PROGRAM, MARKET)).toBeNull();
    const c2 = conn({
      getAccountInfo: vi.fn(async () => infoOf(mkt, PROGRAM)),
      getProgramAccounts: vi.fn(async () => [{ pubkey: lp.row.pubkey, account: infoOf(lp.row.data, PROGRAM) }]),
      getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(() => null)),
    });
    expect(await resolveMarketLp(c2, PROGRAM, MARKET)).toBeNull();
  });

  it("scan RPC failure propagates", async () => {
    const c = conn({
      getAccountInfo: vi.fn(async () => infoOf(mkt, PROGRAM)),
      getProgramAccounts: vi.fn(async () => { throw new Error("rpc down"); }),
    });
    await expect(resolveMarketLp(c, PROGRAM, MARKET)).rejects.toThrow("rpc down");
  });

  it("knownLp fast path: a valid curated LP returns without a scan", async () => {
    const c = conn({
      getAccountInfo: vi.fn(async (k: PublicKey) => (k.equals(MARKET) ? infoOf(mkt, PROGRAM) : infoOf(lp.row.data, PROGRAM))),
    });
    // partial list: admin rule applies, so the creator-owned LP is found
    const r = await resolveMarketLp(c, PROGRAM, MARKET, lp.row.pubkey);
    expect(r?.pubkey.equals(lp.row.pubkey)).toBe(true);
    expect(c.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("knownLp with wrong owner, missing account, or a throwing fetch falls back to the scan", async () => {
    const scan = vi.fn(async () => [{ pubkey: lp.row.pubkey, account: infoOf(lp.row.data, PROGRAM) }]);
    const variants: Array<(k: PublicKey) => Promise<unknown>> = [
      async (k) => (k.equals(MARKET) ? infoOf(mkt, PROGRAM) : infoOf(lp.row.data, Keypair.generate().publicKey)),
      async (k) => (k.equals(MARKET) ? infoOf(mkt, PROGRAM) : null),
      async (k) => { if (k.equals(MARKET)) return infoOf(mkt, PROGRAM); throw new Error("boom"); },
    ];
    for (const v of variants) {
      scan.mockClear();
      const c = conn({ getAccountInfo: vi.fn(v), getProgramAccounts: scan });
      const r = await resolveMarketLp(c, PROGRAM, MARKET, lp.row.pubkey);
      expect(r?.pubkey.equals(lp.row.pubkey)).toBe(true);
      expect(scan).toHaveBeenCalledTimes(1);
    }
  });
});

describe("selectMarketLpsFromScan", () => {
  const lp = portfolio({ id: 1n });
  const mkt = marketData(CREATOR);

  it("no rows / only junk / only disabled matchers -> empty map, no RPC", async () => {
    const getMultipleAccountsInfo = vi.fn();
    const c = { getMultipleAccountsInfo } as unknown as Connection;
    const off = portfolio({ id: 2n, enabled: false });
    const junk = { pubkey: Keypair.generate().publicKey, data: new Uint8Array(8) };
    expect((await selectMarketLpsFromScan(c, PROGRAM, [])).size).toBe(0);
    expect((await selectMarketLpsFromScan(c, PROGRAM, [junk, off.row])).size).toBe(0);
    expect(getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it("groups by market and returns the LP keyed by market base58", async () => {
    const trader = portfolio({ id: 2n, enabled: false, owner: Keypair.generate().publicKey });
    const c = {
      getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) =>
        keys.map((k) => (k.equals(MARKET) ? infoOf(mkt, PROGRAM) : k.equals(lp.ctx) ? infoOf(lp.ctxRow.data, MATCHER) : null))),
    } as unknown as Connection;
    const out = await selectMarketLpsFromScan(c, PROGRAM, [trader.row, lp.row]);
    expect(out.size).toBe(1);
    expect(out.get(MARKET.toBase58())?.pubkey.equals(lp.row.pubkey)).toBe(true);
  });

  it("skips a market whose account is missing or not owned by the program", async () => {
    for (const info of [null, infoOf(mkt, Keypair.generate().publicKey)]) {
      const c = {
        getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) =>
          keys.map((k) => (k.equals(MARKET) ? info : k.equals(lp.ctx) ? infoOf(lp.ctxRow.data, MATCHER) : null))),
      } as unknown as Connection;
      expect((await selectMarketLpsFromScan(c, PROGRAM, [lp.row])).size).toBe(0);
    }
  });

  it("market with an enabled matcher but no qualifying LP is omitted", async () => {
    const c = { getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((k) => (k.equals(MARKET) ? infoOf(mkt, PROGRAM) : null))) } as unknown as Connection;
    expect((await selectMarketLpsFromScan(c, PROGRAM, [lp.row])).size).toBe(0);
  });
});
