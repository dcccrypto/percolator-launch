/**
 * Stake > Withdraw: the 25/50/75/100% chips filled (lpBalance * pct / 100).toFixed(4), rounded to
 * nearest, so 100% of 10.123456 read 10.1235 (above the balance) and handleWithdraw refused it
 * without a word: a dead "Withdraw" button. The chips now floor in BigInt like the deposit chips,
 * and an amount above the staked balance disables the button with a reason.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { exceedsStakedBalance, stakeWithdrawChipAmount, withdrawAmountError } from "@/lib/stake-position";
import { parseHumanAmount } from "@/lib/parseAmount";

const RAW = 10_123_456n; // 10.123456 LP at 6 decimals

describe("stake withdraw chips", () => {
  it("100% is exactly the balance, not rounded above it", () => {
    expect(Number((10.123456).toFixed(4))).toBeGreaterThan(10.123456); // the old chip
    expect(stakeWithdrawChipAmount(RAW, 100, 6)).toBe("10.123456");
    expect(parseHumanAmount(stakeWithdrawChipAmount(RAW, 100, 6), 6)).toBe(RAW);
  });

  it("every chip floors and never exceeds the balance", () => {
    for (const raw of [RAW, 1n, 999_999_999n, 7_000_001n]) {
      for (const pct of [25, 50, 75, 100]) {
        const back = parseHumanAmount(stakeWithdrawChipAmount(raw, pct, 6), 6);
        expect(back).toBe((raw * BigInt(pct)) / 100n);
        expect(exceedsStakedBalance(stakeWithdrawChipAmount(raw, pct, 6), raw, 6)).toBe(false);
      }
    }
  });

  it("flags a typed amount above the staked balance, and only that", () => {
    expect(exceedsStakedBalance("10.1235", RAW, 6)).toBe(true);
    expect(exceedsStakedBalance("10.123457", RAW, 6)).toBe(true);
    expect(exceedsStakedBalance("10.123456", RAW, 6)).toBe(false);
    expect(exceedsStakedBalance("", RAW, 6)).toBe(false);
  });

  it("never throws on input parseHumanAmount rejects (it runs every render)", () => {
    // parseHumanAmount throws on more decimals than the mint has; an uncaught throw here crashed /stake.
    for (const typed of ["0.0000001", "10.1234567", "1.00000000000000000001"]) {
      expect(() => exceedsStakedBalance(typed, RAW, 6)).not.toThrow();
      expect(exceedsStakedBalance(typed, RAW, 6)).toBe(true); // can't be withdrawn as typed: button off
      expect(withdrawAmountError(typed, RAW, 6)).toBe("Use up to 6 decimal places.");
    }
    // Garbage / negative / huge parse without throwing; the zero-amount guard owns garbage and negatives.
    for (const typed of ["abc", "1e3", "-5", "1.2.3", ".", "  "]) {
      expect(() => exceedsStakedBalance(typed, RAW, 6)).not.toThrow();
      expect(exceedsStakedBalance(typed, RAW, 6)).toBe(false);
    }
    expect(exceedsStakedBalance("9".repeat(400), RAW, 6)).toBe(true);
    expect(withdrawAmountError("10.1235", RAW, 6)).toBe("Exceeds your staked balance.");
    expect(withdrawAmountError("10.123456", RAW, 6)).toBeNull();
  });

  it("the page uses them, disables Withdraw and says why", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../app/stake/page.tsx"), "utf8");
    expect(src).toContain("setWithdrawAmount(stakeWithdrawChipAmount(withdrawMaxLpRaw(withdrawPosition), pct, withdrawPosition.lpDecimals))");
    expect(src).not.toMatch(/setWithdrawAmount\(val\.toFixed\(4\)\)/);
    expect(src).toMatch(/disabled=\{[^}]*withdrawExceeds[^}]*\}/);
    expect(src).toContain('data-testid="stake-withdraw-amount-error"');
    expect(src).toContain("withdrawAmountError(withdrawAmount, withdrawPosition.lpBalanceRaw, withdrawPosition.lpDecimals, withdrawCap?.maxLpRaw, V22_COPY.stake.withdrawOverCap)");
  });
});
