// @vitest-environment node
/** Branch coverage for own-portfolio-cleanup: chain load, cleanup-before-reclaim, one-approval plan. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";

const h = vi.hoisted(() => ({
  market: null as null | { materializedPortfolioCount: bigint; cTot: bigint },
  identity: vi.fn(),
  simulate: vi.fn(),
}));

vi.mock("@/lib/limits/decode", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/decode")>()),
  decodeResolvedMarket: () => h.market,
}));
vi.mock("@/lib/v18-wire", async (orig) => ({
  ...(await orig<typeof import("@/lib/v18-wire")>()),
  readPortfolioIdentity: (d: Uint8Array) => h.identity(d),
}));
vi.mock("@/lib/self-heal", async (orig) => ({
  ...(await orig<typeof import("@/lib/self-heal")>()),
  connectionSelfHealDeps: () => ({ simulate: h.simulate }),
}));

import {
  CLEANUP_CU,
  cleanupOwnPortfoliosBeforeReclaim,
  loadOwnPortfolios,
  planOwnCleanupForOneApproval,
} from "@/lib/limits/own-portfolio-cleanup";
import { blankPortfolio } from "../../helpers/v22-fixtures";

const k = () => Keypair.generate().publicKey;
const PROG = k(), MARKET = k(), MINT = k(), OWNER = k(), VT = k(), VA = k();

function pfData(owner: PublicKey, capital: bigint, kind = C.KIND_PORTFOLIO): Buffer {
  const d = Buffer.from(blankPortfolio());
  d[10] = kind;
  d.set(owner.toBytes(), C.PF_OWNER);
  d.writeBigUInt64LE(capital, C.PF_CAPITAL);
  return d;
}
const acct = (data: Buffer) => ({ pubkey: k(), account: { data } });

function conn(accts: ReturnType<typeof acct>[], marketInfo: { data: Buffer } | null = { data: Buffer.alloc(1) }) {
  return {
    getProgramAccounts: vi.fn(async () => accts),
    getAccountInfo: vi.fn(async () => marketInfo),
  } as never;
}
const base = (connection: never) => ({ connection, programId: PROG, market: MARKET, owner: OWNER, collateralMint: MINT, vaultToken: VT, vaultAuthority: VA });

beforeEach(() => {
  h.market = { materializedPortfolioCount: 0n, cTot: 0n };
  h.identity.mockReset().mockReturnValue({ portfolioId: 1n, matcherSequence: 2n, positionEpoch: 3n });
  h.simulate.mockReset().mockResolvedValue({ err: null });
});

describe("loadOwnPortfolios", () => {
  it("filters by market memcmp, kind, owner and unreadable identity", async () => {
    const mine = acct(pfData(OWNER, 0n));
    const notPortfolio = acct(pfData(OWNER, 0n, 0));
    const other = acct(pfData(k(), 0n));
    const bad = acct(pfData(OWNER, 0n));
    let n = 0;
    h.identity.mockImplementation(() => {
      if (++n === 2) throw new Error("not v18");
      return { portfolioId: 7n, matcherSequence: 8n, positionEpoch: 9n };
    });
    const c = conn([mine, notPortfolio, other, bad, acct(pfData(OWNER, 5n))]);
    const out = await loadOwnPortfolios(c, PROG, MARKET, OWNER);
    // `bad` is the 2nd identity read (notPortfolio and other never reach it) and is dropped.
    expect(out).toHaveLength(2);
    expect(out[0]!.key.equals(mine.pubkey)).toBe(true);
    expect(out.some((p) => p.key.equals(bad.pubkey))).toBe(false);
    expect(out[0]).toMatchObject({ portfolioId: 7n, matcherSequence: 8n, positionEpoch: 9n });
    expect(out[1]!.view.capital).toBe(5n);
    const args = (c as unknown as { getProgramAccounts: ReturnType<typeof vi.fn> }).getProgramAccounts.mock.calls[0]!;
    expect(args[1]).toEqual({ commitment: "confirmed", filters: [{ memcmp: { offset: 16, bytes: MARKET.toBase58() } }] });
  });
  it("skips accounts whose layout does not decode as a portfolio", async () => {
    const out = await loadOwnPortfolios(conn([acct(Buffer.concat([Buffer.alloc(11), Buffer.from([0])]).fill(0, 0, 10))]), PROG, MARKET, OWNER);
    expect(out).toEqual([]);
  });
});

describe("cleanupOwnPortfoliosBeforeReclaim", () => {
  it("ok: closes every own group and the market is terminal-flat", async () => {
    const send = vi.fn(async () => "sig1");
    const r = await cleanupOwnPortfoliosBeforeReclaim({ ...base(conn([acct(pfData(OWNER, 0n))])), send });
    expect(r).toEqual({ ok: true, closed: 1, signatures: ["sig1"] });
    expect(send.mock.calls[0]![0]).toHaveLength(1);
    // simulate is prefixed with compute-budget ixs
    const simmed = h.simulate.mock.calls[0]![0] as { data: Buffer }[];
    expect(simmed.length).toBeGreaterThan(1); // compute-budget prefix + the 8
    expect(simmed.at(-1)!.data[0]).toBe(C.TAG_CLOSE_PORTFOLIO);
    expect(CLEANUP_CU).toBe(600_000);
  });
  it("ok when the market account is gone", async () => {
    const send = vi.fn(async () => "s");
    const r = await cleanupOwnPortfoliosBeforeReclaim({ ...base(conn([], null)), send });
    expect(r).toEqual({ ok: true, closed: 0, signatures: [] });
  });
  it("refused when neither form simulates", async () => {
    h.simulate.mockResolvedValue({ err: "boom" });
    const send = vi.fn(async () => "s");
    const r = await cleanupOwnPortfoliosBeforeReclaim({ ...base(conn([acct(pfData(OWNER, 9n))])), send });
    expect(r).toEqual({ ok: false, reason: "refused", signatures: [] });
    expect(send).not.toHaveBeenCalled();
  });
  it("progress-only when only the group without the 8 simulates", async () => {
    h.simulate.mockImplementation(async (ixs: { data: Buffer }[]) => ({ err: ixs.at(-1)!.data[0] === C.TAG_CLOSE_PORTFOLIO ? "8 fails" : null }));
    const send = vi.fn(async () => "sigP");
    const r = await cleanupOwnPortfoliosBeforeReclaim({ ...base(conn([acct(pfData(OWNER, 9n))])), send });
    expect(r).toEqual({ ok: false, reason: "progress-only", signatures: ["sigP"] });
  });
  it("others-remain when portfolios or capital are left on the market", async () => {
    h.market = { materializedPortfolioCount: 2n, cTot: 0n };
    const r = await cleanupOwnPortfoliosBeforeReclaim({ ...base(conn([])), send: vi.fn() });
    expect(r).toEqual({ ok: false, reason: "others-remain", remaining: 2n, signatures: [] });
    h.market = { materializedPortfolioCount: 0n, cTot: 5n };
    const r2 = await cleanupOwnPortfoliosBeforeReclaim({ ...base(conn([])), send: vi.fn() });
    expect(r2).toMatchObject({ ok: false, reason: "others-remain", remaining: 0n });
  });
});

describe("planOwnCleanupForOneApproval", () => {
  it("returns every group's full instruction list when all simulate", async () => {
    h.market = { materializedPortfolioCount: 2n, cTot: 0n };
    const r = await planOwnCleanupForOneApproval(base(conn([acct(pfData(OWNER, 0n)), acct(pfData(OWNER, 9n))])));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.groups.map((g) => g.length)).toEqual([1, 3]);
  });
  it("ok with no groups when the market account is missing", async () => {
    const r = await planOwnCleanupForOneApproval(base(conn([], null)));
    expect(r).toEqual({ ok: true, groups: [] });
  });
  it("progress-only when the without-8 fallback simulates", async () => {
    h.simulate.mockImplementation(async (ixs: { data: Buffer }[]) => ({ err: ixs.at(-1)!.data[0] === C.TAG_CLOSE_PORTFOLIO ? "e" : null }));
    const r = await planOwnCleanupForOneApproval(base(conn([acct(pfData(OWNER, 9n))])));
    expect(r).toEqual({ ok: false, reason: "progress-only" });
  });
  it("refused when the fallback also fails", async () => {
    h.simulate.mockResolvedValue({ err: "e" });
    const r = await planOwnCleanupForOneApproval(base(conn([acct(pfData(OWNER, 9n))])));
    expect(r).toEqual({ ok: false, reason: "refused" });
  });
  it("refused for an empty (close-empty) group that fails: no fallback exists", async () => {
    h.simulate.mockResolvedValue({ err: "e" });
    const r = await planOwnCleanupForOneApproval(base(conn([acct(pfData(OWNER, 0n))])));
    expect(r).toEqual({ ok: false, reason: "refused" });
    expect(h.simulate).toHaveBeenCalledTimes(1);
  });
  it("others-remain when the market still counts more portfolios than we close", async () => {
    h.market = { materializedPortfolioCount: 3n, cTot: 0n };
    const r = await planOwnCleanupForOneApproval(base(conn([acct(pfData(OWNER, 0n))])));
    expect(r).toEqual({ ok: false, reason: "others-remain", remaining: 2n });
  });
});
