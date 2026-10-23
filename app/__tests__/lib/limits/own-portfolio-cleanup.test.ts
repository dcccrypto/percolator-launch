// @vitest-environment node
/** E2E B12 app side: the reclaim flow closes the wallet's OWN portfolios on a Resolved market. */
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as C from "@/lib/limits/constants";
import { decodeResolvedPortfolio } from "@/lib/limits/decode";
import { planOwnPortfolioCleanup, runOwnPortfolioCleanup, type OwnPortfolio } from "@/lib/limits/own-portfolio-cleanup";
import { encodeClosePortfolio } from "@/lib/limits/p3-ix";
import { afterLegsShift, blankMarket, blankPortfolio } from "../../helpers/v22-fixtures";
import { marketOffsets } from "@/lib/v22/market-offsets";


const k = () => Keypair.generate().publicKey;
const PROG = k(), MARKET = k(), MINT = k(), OWNER = k(), VT = k(), VA = k();
function pf(owner: PublicKey, o: { capital?: bigint; receipt?: [boolean, boolean] } = {}): OwnPortfolio {
  const d = new Uint8Array(blankPortfolio());
  const v = new DataView(d.buffer);
  d[10] = C.KIND_PORTFOLIO;
  d.set(owner.toBytes(), C.PF_OWNER);
  v.setBigUint64(C.PF_CAPITAL, o.capital ?? 0n, true);
  if (o.receipt) {
    d[C.PF_RESOLVED_PAYOUT_RECEIPT + afterLegsShift() + C.RECEIPT_PRESENT] = o.receipt[0] ? 1 : 0;
    d[C.PF_RESOLVED_PAYOUT_RECEIPT + afterLegsShift() + C.RECEIPT_FINALIZED] = o.receipt[1] ? 1 : 0;
  }
  return { key: k(), view: decodeResolvedPortfolio(d)!, portfolioId: 3n, matcherSequence: 4n, positionEpoch: 5n };
}
const plan = (ps: OwnPortfolio[]) => planOwnPortfolioCleanup({ programId: PROG, owner: OWNER, market: MARKET, collateralMint: MINT, vaultToken: VT, vaultAuthority: VA, portfolios: ps });

describe("planOwnPortfolioCleanup", () => {
  it("skips portfolios the wallet does not own", () => {
    expect(plan([pf(k(), { capital: 5n })])).toEqual([]);
  });
  it("empty => [8] owner-signed with the v18 identity", () => {
    const [g] = plan([pf(OWNER)]);
    expect(g.kind).toBe("close-empty");
    expect(g.withoutClose).toBeNull();
    const [i8] = g.withClose;
    expect(i8.keys.map((x) => [x.isSigner, x.isWritable])).toEqual([[true, true], [false, true], [false, true]]);
    expect(i8.keys[0].pubkey.equals(OWNER)).toBe(true);
    expect(Buffer.from(i8.data).equals(Buffer.from(encodeClosePortfolio(3n, 4n, 5n)))).toBe(true);
  });
  it("holding capital => [ATA idempotent, 30 OWNER-SIGNED paying the owner's ATA, 8]; fallback without the 8", () => {
    const [g] = plan([pf(OWNER, { capital: 9n })]);
    expect(g.kind).toBe("close-resolved");
    const [, i30, i8] = g.withClose;
    expect(i30.data[0]).toBe(C.TAG_CLOSE_RESOLVED);
    expect(i30.keys[0]).toEqual({ pubkey: OWNER, isSigner: true, isWritable: false });
    expect(i30.keys[3].pubkey.equals(getAssociatedTokenAddressSync(MINT, OWNER))).toBe(true);
    expect(i8.data[0]).toBe(C.TAG_CLOSE_PORTFOLIO);
    expect(g.withoutClose?.map((i) => i.data[0])).toEqual([1, C.TAG_CLOSE_RESOLVED]);
  });
  it("open payout receipt => 46 then 8", () => {
    const [g] = plan([pf(OWNER, { receipt: [true, false] })]);
    expect(g.kind).toBe("claim-topup");
    expect(g.withClose[1].data[0]).toBe(C.TAG_CLAIM_RESOLVED_PAYOUT_TOPUP);
  });
});

describe("runOwnPortfolioCleanup", () => {
  it("full group when it sims; else without the 8 (progress-only); else refused", async () => {
    const gs = plan([pf(OWNER), pf(OWNER, { capital: 1n }), pf(OWNER, { capital: 2n })]);
    const sent: number[] = [];
    const r = await runOwnPortfolioCleanup(gs, {
      simulate: async (ixs) => {
        if (ixs === gs[0].withClose) return null;
        if (ixs === gs[1].withClose) return "8 fails: loser not settled";
        if (ixs === gs[1].withoutClose) return null;
        return "refused";
      },
      send: async (ixs) => {
        sent.push(ixs.length);
        return `s${sent.length}`;
      },
    });
    expect(r.closed).toEqual([gs[0].portfolio.toBase58()]);
    expect(r.progressOnly).toEqual([gs[1].portfolio.toBase58()]);
    expect(r.refused.map((x) => x.portfolio)).toEqual([gs[2].portfolio.toBase58()]);
    expect(sent).toEqual([1, 2]);
  });
});
