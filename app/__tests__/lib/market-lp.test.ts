// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN, V17_PORTFOLIO_IDENTITY_TRAILER_LEN, deriveMatcherDelegate } from "@percolatorct/sdk";
import { selectMarketLp, ctxAddressesToFetch, type CtxRow, type PortfolioRow } from "@/lib/market-lp";
import { assetProfileOff } from "@/lib/v18-wire";

const PROGRAM = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const MATCHER = new PublicKey("EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX");
const MARKET = Keypair.generate().publicKey;
const CREATOR = Keypair.generate().publicKey;
const MARKET_LEN = 33_900;

function marketData(admin: PublicKey | null): Uint8Array {
  const d = new Uint8Array(MARKET_LEN);
  d[10] = 1; // kind = market
  if (admin) d.set(admin.toBytes(), assetProfileOff(0, new Uint8Array(0)) + 368);
  return d;
}

/** A pubkey whose base58 sorts FIRST (the old "first enabled" scan + any lexical sort picks it). */
function lowPubkey(): PublicKey {
  const b = new Uint8Array(32);
  b[31] = 1;
  return new PublicKey(b);
}

interface Pf { row: PortfolioRow; ctx: PublicKey; ctxRow: CtxRow }

function portfolio(opts: {
  pubkey?: PublicKey; owner: PublicKey; id: bigint; enabled?: boolean;
  /** Corrupt the ctx binding (ctx.lp_pda != derived delegate). */
  unbound?: boolean; ctxOwner?: PublicKey; market?: PublicKey;
}): Pf {
  const pubkey = opts.pubkey ?? Keypair.generate().publicKey;
  const ctx = Keypair.generate().publicKey;
  const d = new Uint8Array(V17_PORTFOLIO_ACCOUNT_LEN);
  d.set([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50], 0); // PERCV16 magic
  d[8] = 18; // version u16 LE
  d[10] = 2; // kind = portfolio
  d.set((opts.market ?? MARKET).toBytes(), 16);
  d.set(pubkey.toBytes(), 48);
  d.set(opts.owner.toBytes(), 80);
  d.set(opts.owner.toBytes(), 116);
  const cfgOff = d.length - 104 - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
  const [delegate] = deriveMatcherDelegate(PROGRAM, opts.market ?? MARKET, pubkey, opts.owner, MATCHER, ctx);
  d.set(MATCHER.toBytes(), cfgOff);
  d.set(ctx.toBytes(), cfgOff + 32);
  d.set(delegate.toBytes(), cfgOff + 64);
  const dv = new DataView(d.buffer);
  dv.setBigUint64(cfgOff + 96, opts.enabled === false ? 0n : 1n, true);
  dv.setBigUint64(d.length - V17_PORTFOLIO_IDENTITY_TRAILER_LEN, opts.id, true); // portfolio_id
  const ctxData = new Uint8Array(400);
  ctxData.set((opts.unbound ? Keypair.generate().publicKey : delegate).toBytes(), 80);
  return { row: { pubkey, data: d }, ctx, ctxRow: { owner: opts.ctxOwner ?? MATCHER, data: ctxData } };
}

function select(pfs: Pf[], admin: PublicKey | null, complete = true) {
  const ctxs = new Map<string, CtxRow | null>(pfs.map((p) => [p.ctx.toBase58(), p.ctxRow]));
  return selectMarketLp({ programId: PROGRAM, market: MARKET, marketData: marketData(admin), portfolios: pfs.map((p) => p.row), ctxs, complete });
}

/** The pre-fix rule: first portfolio (in the order given) with an enabled matcher. */
function oldFirstEnabled(pfs: Pf[]): PublicKey | null {
  const hit = pfs.find((p) => ctxAddressesToFetch([p.row]).length > 0);
  return hit ? hit.row.pubkey : null;
}

describe("selectMarketLp: the LP is chosen by on-chain identity", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const lp = portfolio({ owner: CREATOR, id: 1n });
  const trader = portfolio({ owner: Keypair.generate().publicKey, id: 2n, enabled: false });

  it("picks the creator's (asset_admin-owned) LP with its bound ctx", () => {
    const r = select([trader, lp], CREATOR);
    expect(r?.pubkey.equals(lp.row.pubkey)).toBe(true);
    expect(r?.matcherCtx.equals(lp.ctx)).toBe(true);
    expect(r?.reason).toBe("asset-admin");
  });

  it("NEGATIVE CONTROL: an attacker portfolio with an enabled, self-bound matcher and a LOW pubkey is NOT picked", () => {
    const attacker = portfolio({ pubkey: lowPubkey(), owner: Keypair.generate().publicKey, id: 3n });
    const order = [attacker, trader, lp]; // RPC order with the attacker first
    // The old "first enabled" rule falls for it ...
    expect(oldFirstEnabled(order)?.equals(attacker.row.pubkey)).toBe(true);
    // ... the identity rule does not, in any order, with or without asset_admin.
    for (const pfs of [order, [lp, attacker], [attacker, lp]]) {
      expect(select(pfs, CREATOR)?.pubkey.equals(lp.row.pubkey)).toBe(true);
      expect(select(pfs, null)?.pubkey.equals(lp.row.pubkey)).toBe(true);
    }
  });

  it("the creator's own second portfolio does not displace the LP: lowest portfolio_id wins", () => {
    const second = portfolio({ pubkey: lowPubkey(), owner: CREATOR, id: 9n });
    expect(select([second, lp], CREATOR)?.pubkey.equals(lp.row.pubkey)).toBe(true);
  });

  it("an LP whose ctx is not bound to it (lp_pda mismatch / foreign ctx owner) is refused", () => {
    const badBind = portfolio({ owner: CREATOR, id: 1n, unbound: true });
    expect(select([badBind], CREATOR)).toBeNull();
    const foreignCtx = portfolio({ owner: CREATOR, id: 1n, ctxOwner: Keypair.generate().publicKey });
    expect(select([foreignCtx], CREATOR)).toBeNull();
  });

  it("a portfolio of ANOTHER market is never a candidate", () => {
    const other = portfolio({ owner: CREATOR, id: 1n, market: Keypair.generate().publicKey });
    expect(select([other], CREATOR)).toBeNull();
  });

  it("asset_admin renounced: the launch portfolio (lowest id) is the LP; an attacker is not", () => {
    const attacker = portfolio({ pubkey: lowPubkey(), owner: Keypair.generate().publicKey, id: 4n });
    const r = select([attacker, trader, lp], null);
    expect(r?.pubkey.equals(lp.row.pubkey)).toBe(true);
    expect(r?.reason).toBe("launch-portfolio");
  });

  it("the creator's LP disabled its matcher: NO LP (fail closed), never the attacker", () => {
    const off = portfolio({ owner: CREATOR, id: 1n, enabled: false });
    const attacker = portfolio({ pubkey: lowPubkey(), owner: Keypair.generate().publicKey, id: 2n });
    expect(select([attacker, off], CREATOR)).toBeNull();
    expect(select([attacker, off], null)).toBeNull();
  });

  it("a partial list (curated fast path) never uses the launch-portfolio fallback", () => {
    const attacker = portfolio({ owner: Keypair.generate().publicKey, id: 1n });
    expect(select([attacker], null, false)).toBeNull();
  });
});
