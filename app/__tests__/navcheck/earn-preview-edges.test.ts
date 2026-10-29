// @vitest-environment node
// Independent review (v22 navcheck 2026-10-29): previewDepositSharesMinted vs wrapper tag 75
// (v16_program.rs ~31354-31478 @ rc23 686d98d0) and vault_lp_v18::senior_shares_for_deposit.
import { describe, expect, it } from "vitest";
import { depositRefusalReason, EARN_WITHDRAW_COPY, previewDepositSharesMinted } from "@/lib/limits/earn-withdraw";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

// Literal port of the chain (bound and unbound share the same floor formula; the unbound path adds
// the price-collapse floor; both add zero-mint refusal, genesis dead shares and the u64 mint cast).
function chainMint(amount: bigint, total: bigint, value: bigint, bound: boolean): bigint | null {
  if (amount > U64_MAX) return null; // amount_to_u64
  if (!bound && total !== 0n && value * 1000n < total) return null; // LP_VAULT_MAX_PRICE_COLLAPSE (custom 91)
  let shares: bigint;
  if (total === 0n) shares = amount;
  else {
    if (value === 0n) return null;
    const p = amount * total;
    if (p > U128_MAX) return null; // checked_mul
    shares = p / value;
  }
  if (shares === 0n) return null; // LpVaultZeroSharesMinted
  const mint = total === 0n ? shares - 1000n : shares;
  if (mint <= 0n) return null; // LpVaultDepositBelowMinimumLiquidity
  if (mint > U64_MAX) return null; // u64::try_from -> EngineArithmeticOverflow
  return mint;
}

describe("navcheck: preview == chain at the edges (bound vault, no collapse floor)", () => {
  const cases: Array<[string, bigint, bigint, bigint]> = [
    ["0 atoms", 0n, 0n, 0n],
    ["1 atom genesis", 1n, 0n, 0n],
    ["1001 atoms genesis", 1001n, 0n, 0n],
    ["1 atom normal", 1n, 1_000_000n, 1_000_000n],
    ["dust value, shares out", 1_000_000n, 1_000_000_000n, 1n],
    ["floor rounding", 7n, 3n, 2n],
    ["decimals-9 1 token genesis", 1_000_000_000n, 0n, 0n],
    ["decimals-0 500 tokens genesis", 500n, 0n, 0n],
  ];
  for (const [name, a, s, v] of cases) {
    it(name, () => expect(previewDepositSharesMinted(a, s, v)).toBe(chainMint(a, s, v, true)));
  }
});

describe("navcheck: divergences", () => {
  it("near-total loss: minted shares exceed u64 -> chain refuses, preview shows a mint", () => {
    // 1e12 shares outstanding, C collapsed to 1 atom; a $1,000 deposit (1e9 atoms)
    const a = 1_000_000_000n, s = 1_000_000_000_000n, v = 1n;
    expect(chainMint(a, s, v, true)).toBeNull();
    expect(previewDepositSharesMinted(a, s, v)).toBeNull();
  });
  it("amount above u64 -> chain refuses (amount_to_u64)", () => {
    expect(previewDepositSharesMinted(U64_MAX + 1n, 0n, 0n)).toBeNull();
  });
  it("unbound vault price-collapse floor (nav*1000 < S) -> chain refuses", () => {
    // documents that previewDepositSharesMinted has no collapse input; it cannot see custom 91
    const a = 1_000_000n, s = 2_000_000n, v = 1_000n;
    expect(chainMint(a, s, v, false)).toBeNull();
    expect(previewDepositSharesMinted(a, s, v)).toBe(chainMint(a, s, v, true));
  });
});


describe("navcheck: depositRefusalReason names the program's refusal", () => {
  it("genesis at or below the dead shares", () => {
    expect(depositRefusalReason(1_000n, 0n, null)).toBe("genesis-minimum");
    expect(depositRefusalReason(1_001n, 0n, null)).toBeNull();
  });
  it("shares outstanding at a zero value: every amount is refused", () => {
    expect(depositRefusalReason(10n ** 12n, 5_000n, 0n)).toBe("no-value");
  });
  it("a deposit that floors to 0 shares", () => {
    expect(depositRefusalReason(1n, 1_000n, 2_000n)).toBe("zero-shares");
    expect(depositRefusalReason(2n, 1_000n, 2_000n)).toBeNull();
  });
  it("above u64 (amount or minted shares)", () => {
    expect(depositRefusalReason(1n << 64n, 1_000n, 1_000n)).toBe("too-large");
    expect(depositRefusalReason(1_000_000_000n, 10n ** 12n, 1n)).toBe("too-large");
  });
  it("unknown pricing is not a refusal", () => {
    expect(depositRefusalReason(5_000n, 1_000n, null)).toBeNull();
  });
  it("every reason has copy, and only the too-small ones say 'larger'", () => {
    for (const r of ["genesis-minimum", "no-value", "zero-shares", "too-large"] as const) {
      expect(EARN_WITHDRAW_COPY.depositRefused[r].length).toBeGreaterThan(10);
    }
    expect(EARN_WITHDRAW_COPY.depositRefused["no-value"]).not.toMatch(/larger/);
    expect(EARN_WITHDRAW_COPY.depositRefused["too-large"]).toMatch(/smaller/);
  });
});
