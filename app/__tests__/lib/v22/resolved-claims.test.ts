// @vitest-environment node
/**
 * Claim flow after a market resolves (lib/v22/resolved-claims.ts, lib/v22/retired-holdings.ts, hooks/useRecoverToStakers.ts).
 * Fixture bytes are REAL v2.2 devnet accounts: CHILLHOUSE-T and SWORDCAT-T markets (Earn markets: the dead-share floor is funded),
 * the QA flat-winner portfolio (v22-flat-winner-portfolio-2026-10-11.json), the single-asset SOL market.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { decodeStakePoolV5, deriveInsuranceUnitsV22 } from "@/lib/v22/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import {
  CLAIM_COPY,
  EARN_FLOOR_COPY,
  LP_VAULT_BACKING_EXPIRY_SLOT,
  earnDeadShareFloorPresent,
  ownerWindow,
  planClaimRows,
  stakeRecoverState,
  terminalFlat,
  type ClaimMarketState,
  type ClaimViewer,
} from "@/lib/v22/resolved-claims";
import { marketOffsetsOrNull } from "@/lib/v22/market-offsets";
import { classifyRetiredHolding, portfolioMarket, portfolioOwner, readMarketForHoldings } from "@/lib/v22/retired-holdings";
import { buildRecoverTerminalInsuranceIx } from "@/lib/v22/sdk/records/stake-wind-down";
import { SLOT_BACKING_LONG as C_SLOT_BACKING_LONG, SLOT_BACKING_SHORT as C_SLOT_BACKING_SHORT } from "@/lib/limits/constants";
import { buildRecoverIxs, recoverRefusalCopy } from "@/hooks/useRecoverToStakers";
import { isLpPortfolio } from "@/lib/lpPortfolio";
import { decodeResolvedMarket } from "@/lib/limits/decode";
import type { ResolvedMarketView } from "@/lib/limits/decode";

const fx = (f: string): unknown => JSON.parse(readFileSync(path.join(__dirname, "../../fixtures", f), "utf8"));
const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
const chill = (): Uint8Array => b64((fx("v22-growth/chillhouse-t.market.json") as { data: string }).data);
const flatWinner = (): { data: Uint8Array; market: string; owner: string } => {
  const j = fx("v22-flat-winner-portfolio-2026-10-11.json") as { b64: string; market: string; owner: string };
  return { data: b64(j.b64), market: j.market, owner: j.owner };
};

beforeAll(() => __setDevnetV22ForTest(true));
afterAll(() => __setDevnetV22ForTest(null));

/** Absolute offset of a backing bucket (same arithmetic as lib/limits/earn-split-pot.ts decodeBackingBucket). */
function bucketOffset(d: Uint8Array, domain: number): number {
  const M = marketOffsetsOrNull(d, "t")!;
  return M.engineOff(Math.floor(domain / 2)) + M.slotRel(domain % 2 === 0 ? C_SLOT_BACKING_LONG : C_SLOT_BACKING_SHORT);
}

const market = (o: Partial<ClaimMarketState> = {}): ClaimMarketState => ({ mode: 1, resolvedSlot: 1_000n, forceCloseDelaySlots: 216_000n, cTot: 5n, materializedPortfolioCount: 2n, ...o });
const viewer = (o: Partial<ClaimViewer> = {}): ClaimViewer => ({ positions: 1, earnShares: 10n, stakeShares: 7n, stakeNeedsRecover: true, ...o });

describe("Earn dead-share floor (Custom 21 on CloseSlab, FC-B5)", () => {
  it("is present on real v2.2 Earn markets", () => {
    expect(earnDeadShareFloorPresent(chill())).toBe(true);
    const j = fx("v22-market-single-asset-SOL.json") as { dataBase64: string };
    expect(earnDeadShareFloorPresent(b64(j.dataBase64))).toBe(true);
  });
  it("is absent once the funded sentinel bucket is gone, and a different expiry is not the floor", () => {
    // Overwrite every bucket's expiry with an ordinary slot: nothing is stamped with the sentinel, so nothing blocks CloseSlab.
    const patched = chill();
    const pv = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
    let changed = 0;
    for (let i = 0; i + 8 <= patched.length; i++) {
      if (pv.getBigUint64(i, true) === LP_VAULT_BACKING_EXPIRY_SLOT) {
        pv.setBigUint64(i, 123n, true);
        changed++;
      }
    }
    expect(changed).toBeGreaterThan(0);
    expect(earnDeadShareFloorPresent(patched)).toBe(false);
  });
  it("an EMPTY bucket that still carries the sentinel expiry is not the floor (only a FUNDED one blocks CloseSlab)", () => {
    // Keep every sentinel stamp but empty the buckets that carry them: status Empty and every amount zero.
    const d = chill();
    const M = marketOffsetsOrNull(d, "t")!;
    const slots = (d.length - (M.g + M.layout.marketGroupLen)) / M.layout.assetSlotStride;
    let emptied = 0;
    for (let dom = 0; dom < slots * 2; dom++) {
      const b = bucketOffset(d, dom);
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      if (dv.getBigUint64(b + 88, true) === LP_VAULT_BACKING_EXPIRY_SLOT) {
        d.fill(0, b + 8, b + 88); // freshUnliened, validLiened, consumed, impaired, utilFeeEarnings
        d[b + 96] = 0; // status Empty
        emptied++;
      }
    }
    expect(emptied).toBeGreaterThan(0);
    expect(earnDeadShareFloorPresent(d)).toBe(false);
  });
  it("claims nothing for foreign, truncated or missing bytes", () => {
    expect(earnDeadShareFloorPresent(null)).toBeNull();
    expect(earnDeadShareFloorPresent(new Uint8Array(500))).toBeNull();
    expect(earnDeadShareFloorPresent(chill().slice(0, 3000))).toBeNull();
  });
  it("the copy is the plan's wording", () => {
    expect(EARN_FLOOR_COPY.line).toMatch(/^Rent is not reclaimable on v2\.2 Earn markets\./);
    expect(EARN_FLOOR_COPY.action).toBe("Settle and withdraw everything");
  });
});

describe("claim action ordering", () => {
  it("rows run senior first: positions, Earn, stake", () => {
    expect(planClaimRows(market(), viewer()).map((r) => r.kind)).toEqual(["positions", "earn", "stake"]);
  });
  it("stake: Recover to stakers comes before Withdraw", () => {
    const stake = planClaimRows(market(), viewer()).find((r) => r.kind === "stake")!;
    expect(stake.actions).toEqual(["recover-to-stakers", "withdraw-stake"]);
    expect(planClaimRows(market(), viewer({ stakeNeedsRecover: false })).find((r) => r.kind === "stake")!.actions).toEqual(["withdraw-stake"]);
  });
  it("Earn waits for open positions; ready once terminal-flat", () => {
    const waiting = planClaimRows(market(), viewer()).find((r) => r.kind === "earn")!;
    expect(waiting.status).toBe("waiting");
    expect(waiting.waitingOn).toBe("positions");
    const flat = planClaimRows(market({ materializedPortfolioCount: 0n, cTot: 0n }), viewer()).find((r) => r.kind === "earn")!;
    expect(flat.status).toBe("ready");
    expect(flat.waitingOn).toBeNull();
    expect(terminalFlat(market({ materializedPortfolioCount: 0n, cTot: 0n }))).toBe(true);
    expect(terminalFlat(market({ materializedPortfolioCount: 0n, cTot: 1n }))).toBe(false);
  });
  it("a wallet with nothing gets no actions; unread reads claim nothing; a live market has no rows", () => {
    const none = planClaimRows(market(), viewer({ positions: 0, earnShares: 0n, stakeShares: 0n }));
    expect(none.every((r) => r.status === "none" && r.actions.length === 0)).toBe(true);
    expect(planClaimRows(market(), viewer({ positions: null, earnShares: null, stakeShares: null })).every((r) => r.actions.length === 0)).toBe(true);
    expect(planClaimRows(market({ mode: 0 }), viewer())).toEqual([]);
  });
});

describe("owner-only window", () => {
  const m = { resolvedSlot: 1_000n, forceCloseDelaySlots: 216_000n };
  it("ends at resolved_slot + force_close_delay_slots (216,000 slots, about 24 h)", () => {
    const w = ownerWindow(m, 1_000n + 108_000n, 1_000_000);
    expect(w.ownerOnly).toBe(true);
    expect(w.endsAtSlot).toBe(217_000n);
    expect(w.endsAtMs).toBe(1_000_000 + 108_000 * 400);
  });
  it("one slot before the end is owner-only; at the end anyone may settle", () => {
    expect(ownerWindow(m, 216_999n, 0).ownerOnly).toBe(true);
    expect(ownerWindow(m, 217_000n, 0).ownerOnly).toBe(false);
    expect(ownerWindow(m, 217_000n, 0).endsAtMs).toBeNull();
  });
  it("no delay configured = no window; unknown clock claims nothing", () => {
    expect(ownerWindow({ ...m, forceCloseDelaySlots: 0n }, 5n, 0).configured).toBe(false);
    expect(ownerWindow(m, null, 0).ownerOnly).toBe(false);
  });
  it("the copy says what happens after the window", () => {
    expect(CLAIM_COPY.ownerWindow("Tue 14:00")).toContain("After that, anyone can settle a position");
    expect(CLAIM_COPY.ownerWindow("Tue 14:00")).toContain("goes to its owner");
  });
});

describe("Recover to stakers (stake tag 29)", () => {
  it("is not offered once the insurance has been moved (capacity 0), nor on a live market", () => {
    expect(stakeRecoverState({ resolved: true, terminalCapacity: 0n, materializedPortfolioCount: 0n }).offer).toBe(false);
  });
  it("is offered on a Resolved market only; amount is the terminal capacity", () => {
    expect(stakeRecoverState({ resolved: false, terminalCapacity: 9n, materializedPortfolioCount: 0n }).offer).toBe(false);
    expect(stakeRecoverState({ resolved: true, terminalCapacity: 9n, materializedPortfolioCount: 0n })).toMatchObject({ offer: true, amount: 9n, blockedByPositions: false });
  });
  it("open portfolios block the wrapper's insurance withdraw: amount 0 and flagged", () => {
    expect(stakeRecoverState({ resolved: true, terminalCapacity: 9n, materializedPortfolioCount: 1n })).toMatchObject({ offer: true, amount: 0n, blockedByPositions: true });
  });
  it("refusal 31 is calm and done; 21 waits on positions; anything else is generic", () => {
    expect(recoverRefusalCopy(31).ok).toBe(true);
    expect(recoverRefusalCopy(21)).toMatchObject({ ok: false });
    expect(recoverRefusalCopy(undefined).ok).toBe(false);
  });
  it("wire: tag 29 + amount u64 LE; the 9 head accounts match stake 53f5480 instruction.rs, FIRST_LOSS tail is [units, creator]", () => {
    const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
    const ix = buildRecoverTerminalInsuranceIx(
      { stakeProgram: k(100), caller: k(1), pool: k(2), poolVault: k(3), vaultAuth: k(4), market: k(5), wrapperVault: k(6), wrapperVaultAuthority: k(7), wrapperProgram: k(9), riskMode: 1, insuranceUnits: k(10), creatorToken: k(11) },
      5_000_000n,
    );
    expect(Array.from(ix.data)).toEqual([29, ...new Uint8Array(new BigUint64Array([5_000_000n]).buffer)]);
    expect(ix.keys.map((x) => x.pubkey.toBytes()[0])).toEqual([1, 2, 3, 4, 5, 6, 7, TOKEN_PROGRAM_ID.toBytes()[0], 9, 10, 11]);
    expect(ix.keys.map((x) => x.isWritable)).toEqual([false, true, true, false, true, true, false, false, false, true, true]);
    expect(ix.keys.some((x) => x.isSigner)).toBe(false);
  });
});

describe("settled-market holdings on the v2.2 portfolio layout", () => {
  const view = (o: Partial<ResolvedMarketView> = {}): ResolvedMarketView => ({ mode: 1, currentSlot: 5n, resolvedSlot: 100n, forceCloseDelaySlots: 216_000n, cTot: 1n, materializedPortfolioCount: 1n, marketauth: new Uint8Array(32), ...o });
  it("reads owner @116 and market @16 from a real v2.2 portfolio", () => {
    const f = flatWinner();
    expect(portfolioOwner(f.data)).toBe(f.owner);
    expect(portfolioMarket(f.data)).toBe(f.market);
  });
  it("lists a real portfolio with capital when its market is Resolved, with the owner-window end", () => {
    const f = flatWinner();
    const h = classifyRetiredHolding({ portfolio: f.data, slabAddress: f.market, market: view(), blocked: false });
    expect(h).not.toBeNull();
    expect(h!.settled).toBe(true);
    expect(h!.reason).toBe("settled");
    expect(h!.capital).toBeGreaterThan(0n);
    expect(h!.ownerOnlyEndsAtSlot).toBe(216_100n);
  });
  it("does not list it while the market is Live, unless the blocklist says so", () => {
    const f = flatWinner();
    expect(classifyRetiredHolding({ portfolio: f.data, slabAddress: f.market, market: view({ mode: 0 }), blocked: false })).toBeNull();
    expect(classifyRetiredHolding({ portfolio: f.data, slabAddress: f.market, market: view({ mode: 0 }), blocked: true })?.reason).toBe("blocklisted");
    expect(classifyRetiredHolding({ portfolio: f.data, slabAddress: f.market, market: null, blocked: false })).toBeNull();
  });
  it("a real market-LP portfolio: listed on a settled market (the wallet can close it), left to the Earn flow when only blocklisted", () => {
    const lp = b64((fx("v22-growth/chillhouse-t.lp.json") as { data: string }).data);
    expect(isLpPortfolio(lp)).toBe(true);
    const slab = "11111111111111111111111111111112";
    const settled = classifyRetiredHolding({ portfolio: lp, slabAddress: slab, market: view(), blocked: false });
    const live = classifyRetiredHolding({ portfolio: lp, slabAddress: slab, market: view({ mode: 0 }), blocked: true });
    expect(live).toBeNull();
    expect(settled?.settled).toBe(true);
  });
  it("lists nothing for a portfolio that is empty", () => {
    const f = flatWinner();
    const empty = new Uint8Array(f.data);
    expect(classifyRetiredHolding({ portfolio: empty.slice(0, 40), slabAddress: f.market, market: view(), blocked: false })).toBeNull();
  });
  it("reads a market header prefix for its mode (what the hook slices), and refuses a short one", () => {
    const d = chill();
    expect(readMarketForHoldings(d.slice(0, 1400))?.mode).toBe(0);
    expect(readMarketForHoldings(d.slice(0, 1000))).toBeNull();
    expect(decodeResolvedMarket(d.slice(0, 1400))?.forceCloseDelaySlots).toBe(216_000n);
  });
});

describe("Recover to stakers: transaction per pool mode", () => {
  const pools = (fx("v22-stake-pools-2026-10-11.json") as { pools: { pubkey: string; b64: string }[] }).pools;
  const pool = decodeStakePoolV5(b64(pools[0]!.b64));
  const caller = new PublicKey("EXC8LS3YzsbyadhaQPqaeGjb2ttfGgDLno9jeCFWqqyi");
  const stakeProgram = new PublicKey("11111111111111111111111111111112");
  const poolKey = new PublicKey(pools[0]!.pubkey);
  const market = new PublicKey("GrKZUtyeaqbg1Q1J1kPWznui92sbLpX5F62LrBVGkifL");
  const build = (riskMode: 0 | 1 | 2) => buildRecoverIxs({ caller, stakeProgram, pool: poolKey, market, poolState: { ...pool, riskMode }, amount: 42n });
  const creatorAta = getAssociatedTokenAddressSync(pool.collateralMint, pool.admin, true);

  it("FIRST_LOSS: creator ATA created first (idempotent), then tag 29 with [..9 head, insurance units, creator token]", () => {
    const ixs = build(1);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    expect(ixs[0]!.keys[1]!.pubkey.toBase58()).toBe(creatorAta.toBase58());
    expect(ixs[0]!.data[0]).toBe(1); // CreateIdempotent
    const k = ixs[1]!.keys;
    expect(ixs[1]!.data[0]).toBe(29);
    expect(k).toHaveLength(11);
    expect(k[0]!.pubkey.toBase58()).toBe(caller.toBase58());
    expect(k[1]!.pubkey.toBase58()).toBe(poolKey.toBase58());
    expect(k[2]!.pubkey.toBase58()).toBe(pool.vault.toBase58());
    expect(k[4]!.pubkey.toBase58()).toBe(market.toBase58());
    expect(k[8]!.pubkey.toBase58()).toBe(pool.percolatorProgram.toBase58());
    expect(k[9]!.pubkey.toBase58()).toBe(deriveInsuranceUnitsV22(pool.percolatorProgram, market)[0].toBase58());
    expect(k[10]!.pubkey.toBase58()).toBe(creatorAta.toBase58());
  });
  it("FEE_ONLY: creator ATA created first, tag 29 takes the creator token and no insurance units", () => {
    const ixs = build(2);
    expect(ixs).toHaveLength(2);
    expect(ixs[1]!.keys).toHaveLength(10);
    expect(ixs[1]!.keys[9]!.pubkey.toBase58()).toBe(creatorAta.toBase58());
  });
  it("legacy (mode 0): no creator account and no pre-instruction", () => {
    const ixs = build(0);
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.keys).toHaveLength(9);
  });
});
