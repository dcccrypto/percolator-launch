// @vitest-environment node
// Independent review: apyFromFeeSnapshots on a dust senior C (senior fees are a FIXED bps share of
// all fees, vault_lp_v18::split_fee, independent of C, so APY ~ fees / C blows up as C -> 0).
import { describe, expect, it } from "vitest";
import { apyFromFeeSnapshots } from "@/lib/limits/vault-tranche";

const t0 = 1_700_000_000;
describe("navcheck: Earn APY on a dust base", () => {
  it("genesis-minimum senior C (1,001 atoms = $0.001) and $5/day senior fees -> absurd APY", () => {
    const apy = apyFromFeeSnapshots(
      { t: t0, seniorFeeCreditedAtoms: 0n, seniorClaimAtoms: 1_001n },
      { t: t0 + 86_400, seniorFeeCreditedAtoms: 5_000_000n, seniorClaimAtoms: 1_001n },
    )!;
    expect(apy).toBeGreaterThan(1e9); // > 10,000,000 % APY
  });
  it("two-point average hides dust at one end: $0.001 all day, $1,000 deposited at the end", () => {
    const apy = apyFromFeeSnapshots(
      { t: t0, seniorFeeCreditedAtoms: 0n, seniorClaimAtoms: 1_001n },
      { t: t0 + 86_400, seniorFeeCreditedAtoms: 5_000_000n, seniorClaimAtoms: 1_000_000_000n },
    )!;
    // avg C = ~$500 passes a "$500 average" floor, though the capital that earned the fees was $0.001
    expect((1_001n + 1_000_000_000n) / 2n >= 500_000_000n).toBe(true);
    expect(apy).toBe(36_499); // shows 365 % although the capital that earned it was $0.001
  });
  it("even at exactly $500 senior C, $5/day fees reads 365 % APY: the floor bounds absurdity, not dilution", () => {
    const apy = apyFromFeeSnapshots(
      { t: t0, seniorFeeCreditedAtoms: 0n, seniorClaimAtoms: 500_000_000n },
      { t: t0 + 86_400, seniorFeeCreditedAtoms: 5_000_000n, seniorClaimAtoms: 500_000_000n },
    )!;
    expect(apy).toBe(36_500);
  });
});
