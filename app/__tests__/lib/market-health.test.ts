// @vitest-environment node
/**
 * v18 market health (lib/market-health.ts) on live market bytes captured
 * 2026-09-29 at slot 505580400 (same fixtures as self-heal.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LIST_BADGE_IDS } from "@/lib/market-header-status";
import { join } from "node:path";
import {
  BOUND_SCALE,
  CREDIT_RATE_SCALE,
  MARKET_HEALTH_SLICE_LEN,
  MIN_HAIRCUT_CLAIM_ATOMS,
  decodeMarketHealth,
  formatBpsPercent,
  healthBadges,
  parseSlabsParam,
} from "@/lib/market-health";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(Buffer.from(readFileSync(join(__dirname, "..", "fixtures", "v18-liveness", `${name}.b64`), "utf8").trim(), "base64"));
const SLOT = 505580400n;

// Offsets under test (engine slot 0 base = 592 + 758 + 1024 = 2374).
const ENGINE = 2374;
const SC_SHORT = ENGINE + 779;
function writeU128(d: Uint8Array, off: number, v: bigint) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  dv.setBigUint64(off, v & 0xffff_ffff_ffff_ffffn, true);
  dv.setBigUint64(off + 8, v >> 64n, true);
}

describe("decodeMarketHealth", () => {
  it("works on a 3,675-byte dataSlice exactly like the full account", () => {
    const full = fixture("murphy-market-v18-lapsed");
    const a = decodeMarketHealth(full, SLOT, 0n);
    const b = decodeMarketHealth(full.slice(0, MARKET_HEALTH_SLICE_LEN), SLOT, 0n);
    expect(b).toEqual(a);
    expect(() => decodeMarketHealth(full.slice(0, MARKET_HEALTH_SLICE_LEN - 1), SLOT, 0n)).toThrow();
  });

  it("Murphy (LP capital 0, lapsed buckets, ResetPending short): LP depleted + repairable", () => {
    const h = decodeMarketHealth(fixture("murphy-market-v18-lapsed"), SLOT, 0n);
    expect(h.lpDepleted).toBe(true);
    expect(h.lockReasons).toContain("repairable");
    expect(h.repairs.length).toBe(3);
    const ids = healthBadges(h).map((b) => b.id);
    expect(ids[0]).toBe("lp-depleted");
    expect(ids).toContain("repairable");
  });

  it("NEGATIVE CONTROL: unknown LP capital (null) is never 'depleted'; positive capital is not either", () => {
    expect(decodeMarketHealth(fixture("murphy-market-v18-lapsed"), SLOT, null).lpDepleted).toBe(false);
    expect(decodeMarketHealth(fixture("murphy-market-v18-lapsed"), SLOT, 1n).lpDepleted).toBe(false);
  });

  it("NEGATIVE CONTROL healthy PENGU (capital > 0): no LP / lock badges", () => {
    const h = decodeMarketHealth(fixture("pengu-market-v18-healthy"), SLOT, 49_000_000_000n);
    expect(h.lpDepleted).toBe(false);
    expect(h.lockReasons).toEqual([]);
    expect(healthBadges(h).filter((b) => b.id !== "payout-haircut")).toEqual([]);
  });

  it("payout haircut follows credit_rate_num on the unliened claims (engine formula), claim-weighted", () => {
    const d = fixture("pengu-market-v18-healthy").slice();
    // Short domain: 10 USDC of claims, 4 USDC backing available, rate 40%, no liens.
    const claims = 10_000_000n * BOUND_SCALE;
    writeU128(d, SC_SHORT + 0, claims);
    writeU128(d, SC_SHORT + 16, claims);
    writeU128(d, SC_SHORT + 32, 4_000_000n * BOUND_SCALE); // fresh_reserved_backing
    writeU128(d, SC_SHORT + 80, 0n); // valid_liened_backing
    writeU128(d, SC_SHORT + 112, 0n); // insurance_credit_reserved
    writeU128(d, SC_SHORT + 160, (CREDIT_RATE_SCALE * 4n) / 10n);
    // Long domain: no claims.
    writeU128(d, ENGINE + 595 + 0, 0n);
    const h = decodeMarketHealth(d, SLOT, 1n);
    expect(h.domains[1].payoutRateBps).toBe(4000);
    expect(h.payoutHaircutBps).toBe(6000);
    expect(h.openProfitAtoms).toBe(10_000_000n);
    expect(h.realizableProfitAtoms).toBe(4_000_000n);
    const badge = healthBadges(h).find((b) => b.id === "payout-haircut")!;
    expect(badge.label).toBe("Payout haircut 60%");
    expect(badge.tone).toBe("danger");
  });

  it("a liened claim is paid by its lien, not by the rate", () => {
    const d = fixture("pengu-market-v18-healthy").slice();
    const claims = 10_000_000n * BOUND_SCALE;
    writeU128(d, ENGINE + 595, 0n);
    writeU128(d, SC_SHORT + 0, claims);
    writeU128(d, SC_SHORT + 32, 10_000_000n * BOUND_SCALE); // fresh reserved
    writeU128(d, SC_SHORT + 80, 6_000_000n * BOUND_SCALE); // 6 liened (bucket PENGU short is Fresh + immortal)
    writeU128(d, SC_SHORT + 112, 0n);
    writeU128(d, SC_SHORT + 128, 0n);
    writeU128(d, SC_SHORT + 160, (CREDIT_RATE_SCALE * 4n) / 10n); // available 4 / claims 10
    const h = decodeMarketHealth(d, SLOT, 1n);
    // 6 liened + 4 unliened * 40% = 7.6 of 10
    expect(h.domains[1].payoutRateBps).toBe(7600);
  });

  it("NEGATIVE CONTROL: dust open profit shows no haircut; no claims = no haircut", () => {
    const d = fixture("pengu-market-v18-healthy").slice();
    writeU128(d, ENGINE + 595, 0n);
    writeU128(d, SC_SHORT + 0, (MIN_HAIRCUT_CLAIM_ATOMS - 1n) * BOUND_SCALE);
    writeU128(d, SC_SHORT + 160, 0n);
    expect(decodeMarketHealth(d, SLOT, 1n).payoutHaircutBps).toBe(0);
    writeU128(d, SC_SHORT + 0, 0n);
    const h = decodeMarketHealth(d, SLOT, 1n);
    expect(h.payoutHaircutBps).toBe(0);
    expect(healthBadges(h).some((b) => b.id === "payout-haircut")).toBe(false);
  });

  it("header flags: resolved / bankruptcy / loss-stale", () => {
    const d = fixture("pengu-market-v18-healthy").slice();
    d[592 + 626] = 1;
    d[592 + 621] = 1;
    d[592 + 623] = 1;
    const h = decodeMarketHealth(d, SLOT, 1n);
    expect(h.lockReasons).toEqual(["resolved", "bankruptcy", "loss-stale"]);
    expect(healthBadges(h)[0].id).toBe("resolved");
  });

  it("A-1: the bankruptcy badge is honest (withdrawals only, info tone) and never promises a reopen", () => {
    const d = fixture("pengu-market-v18-healthy").slice();
    d[592 + 621] = 1;
    const h = decodeMarketHealth(d, SLOT, 1n);
    expect(h.lockReasons).toContain("bankruptcy");
    const badge = healthBadges(h).find((b) => b.id === "bankruptcy")!;
    expect(badge.tone).toBe("info");
    expect(badge.label).not.toBe("Catching up");
    expect(badge.detail).toBe(
      "LP and insurance withdrawals are paused until open profits in this market are settled. Trading, closing and your own deposits and withdrawals are not affected.",
    );
    expect(badge.detail).not.toMatch(/reopen|within a minute|automatically/i);
    // It is not a market-list badge and not a header state.
    expect(LIST_BADGE_IDS.has("bankruptcy")).toBe(false);
    // NEGATIVE CONTROL: flag off -> no badge.
    d[592 + 621] = 0;
    expect(healthBadges(decodeMarketHealth(d, SLOT, 1n)).some((b) => b.id === "bankruptcy")).toBe(false);
  });
});

describe("formatBpsPercent / parseSlabsParam", () => {
  it("formats", () => {
    expect(formatBpsPercent(6000)).toBe("60%");
    expect(formatBpsPercent(719)).toBe("7.2%");
    expect(formatBpsPercent(10)).toBe("0.1%");
    expect(formatBpsPercent(100)).toBe("1%");
  });
  it("parses + NEGATIVE CONTROLS", () => {
    expect(parseSlabsParam("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr,AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr")).toEqual([
      "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr",
    ]);
    expect(parseSlabsParam(null)).toBeNull();
    expect(parseSlabsParam("")).toBeNull();
    expect(parseSlabsParam("not-a-key")).toBeNull();
    expect(parseSlabsParam("0OIl" + "1".repeat(40))).toBeNull();
    expect(parseSlabsParam(Array.from({ length: 51 }, (_, i) => `${"1".repeat(31)}${"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[i % 49]}${i}`).join(","))).toBeNull();
  });
});
