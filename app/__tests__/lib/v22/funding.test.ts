/**
 * v2.2 funding decoder (QA FUND-7). Fixture: REAL devnet market accounts fetched read-only (getAccountInfo, confirmed,
 * slot 510,879,329-331, 2026-10-14) for swordcat 6fonYScx…, SOL BYFuWyuo…, JUP GtUe5hYy…. The expected numbers are hand-derived
 * from the wrapper source (see lib/v22/funding.ts): max_abs 111 e9/slot, skew slope 55 / max 111, vault LP net = -(OI long).
 */
import { describe, expect, it } from "vitest";
import fx from "../../fixtures/v22-devnet-markets-2026-10-14.json";
import { decodeFundingV22, fundingDirectionText } from "@/lib/v22/funding";
import { resolveMarketGeometry } from "@/lib/v22/sdk";

const bytes = (k: "swordcat" | "SOL" | "JUP"): Uint8Array => new Uint8Array(Buffer.from(fx[k].data, "base64"));
const WRAPPER = "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM";

describe("decodeFundingV22 on real devnet market accounts", () => {
  it("fixture is the deployed v2.2 wrapper's account", () => {
    expect(fx.swordcat.owner).toBe(WRAPPER);
  });

  it("swordcat: the vault LP is net short (traders net long) -> skew +55 e9/slot, longs pay shorts, +0.396% per 8h", () => {
    const f = decodeFundingV22(bytes("swordcat"))!;
    expect(f.maxAbsE9).toBe(111n);
    expect(f.premiumE9).toBe(0n); // mark == effective price on the fixture
    expect(f.skewE9).toBe(55n);
    expect(f.rateE9PerSlot).toBe(55n);
    expect(f.bothSides).toBe(true);
    expect(f.direction).toBe("longs-pay-shorts");
    // 55e-9 per slot x 72,000 slots = 0.396 % of notional per 8 h
    expect(f.pctPer8h).toBeCloseTo(0.396, 6);
    expect(fundingDirectionText(f.direction)).toBe("Longs pay shorts");
  });

  it("SOL: vault LP flat -> no skew, no premium -> rate 0, nobody pays", () => {
    const f = decodeFundingV22(bytes("SOL"))!;
    expect(f.rateE9PerSlot).toBe(0n);
    expect(f.direction).toBe("none");
    expect(f.pctPer8h).toBe(0);
  });

  it("JUP: no open interest on either side -> funding is not paid (bothSides false, 0 per 8h)", () => {
    const f = decodeFundingV22(bytes("JUP"))!;
    expect(f.bothSides).toBe(false);
    expect(f.pctPer8h).toBe(0);
    expect(f.direction).toBe("none");
  });

  describe("sign and clamp, by editing the real account", () => {
    const g = resolveMarketGeometry(bytes("swordcat"), { parser: "t", strictLength: false });
    const w = g.slotOff(0);
    const withMark = (delta: bigint): Uint8Array => {
      const d = bytes("swordcat");
      const dv = new DataView(d.buffer);
      dv.setBigUint64(w + 432, dv.getBigUint64(w + 432, true) + delta, true);
      return d;
    };
    it("mark above the index is a POSITIVE premium (+29 e9 for one micro-unit of 33.56) and adds to the skew", () => {
      const f = decodeFundingV22(withMark(1n))!;
      expect(f.premiumE9).toBe(29n);
      expect(f.rateE9PerSlot).toBe(84n);
    });
    it("mark below the index is NEGATIVE and nets against the skew (-29 + 55 = +26): the sign flips with the premium", () => {
      const f = decodeFundingV22(withMark(-1n))!;
      expect(f.premiumE9).toBe(-29n);
      expect(f.rateE9PerSlot).toBe(26n);
      expect(f.direction).toBe("longs-pay-shorts");
    });
    it("a large premium is clamped to max_abs (111) both ways; a negative total reads shorts pay longs", () => {
      expect(decodeFundingV22(withMark(1_000_000n))!.rateE9PerSlot).toBe(111n);
      const neg = decodeFundingV22(withMark(-1_000_000n))!;
      expect(neg.rateE9PerSlot).toBe(-56n); // premium -111 (capped) + skew 55
      expect(neg.direction).toBe("shorts-pay-longs");
      expect(fundingDirectionText(neg.direction)).toBe("Shorts pay longs");
    });
    it("NEGATIVE CONTROL: a non-price-managed oracle mode (manual 0) applies 0 whatever the state says", () => {
      const d = bytes("swordcat");
      d[w] = 0;
      const f = decodeFundingV22(d)!;
      expect(f.managed).toBe(false);
      expect(f.rateE9PerSlot).toBe(0n);
    });
    it("funding disabled (max_abs 0) reads 0", () => {
      const d = bytes("swordcat");
      const base = g.groupOff + 32 + 126; // V16ConfigAccount @ groupOff+32, max_abs_funding_e9_per_slot @ +126
      new DataView(d.buffer).setBigUint64(base, 0n, true);
      expect(decodeFundingV22(d)!.rateE9PerSlot).toBe(0n);
    });
  });

  it("not a market / too short -> null, never a guess", () => {
    expect(decodeFundingV22(new Uint8Array(10))).toBeNull();
  });
});
