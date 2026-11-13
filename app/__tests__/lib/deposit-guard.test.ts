// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  assertDepositWithinBalance,
  checkDepositAmount,
  DepositExceedsBalanceError,
  depositAmountMessage,
  readTokenBalance,
} from "@/lib/deposit-guard";

const ata = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
const tokenData = (n: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(n, 64);
  return b;
};

describe("checkDepositAmount", () => {
  it("classifies empty / unknown / exceeds / ok", () => {
    expect(checkDepositAmount(0n, 5n)).toBe("empty");
    expect(checkDepositAmount(1n, null)).toBe("balance-unknown");
    expect(checkDepositAmount(6n, 5n)).toBe("exceeds");
    expect(checkDepositAmount(5n, 5n)).toBe("ok");
    expect(checkDepositAmount(1n, 0n)).toBe("exceeds");
  });
});

describe("depositAmountMessage", () => {
  it("names the available balance when exceeding", () => {
    expect(depositAmountMessage("exceeds", 1_234_567n, 6, "USDC")).toBe(
      "Exceeds your wallet balance (1.234 USDC available)",
    );
    expect(depositAmountMessage("ok", 5n, 6)).toBeNull();
    expect(depositAmountMessage("balance-unknown", null, 6)).toMatch(/checking/i);
  });
});

describe("assertDepositWithinBalance", () => {
  it("throws only when the balance is known and too small", () => {
    expect(() => assertDepositWithinBalance(10n, 5n)).toThrow(DepositExceedsBalanceError);
    expect(() => assertDepositWithinBalance(5n, 5n)).not.toThrow();
    expect(() => assertDepositWithinBalance(10n, null)).not.toThrow(); // read failed: chain validates
  });
});

describe("readTokenBalance", () => {
  it("reads the u64 amount at offset 64", async () => {
    const conn = { getAccountInfo: vi.fn().mockResolvedValue({ data: tokenData(123_456_789n) }) };
    expect(await readTokenBalance(conn, ata)).toBe(123_456_789n);
  });
  it("0n for an absent account, null when the read fails or data is malformed", async () => {
    expect(await readTokenBalance({ getAccountInfo: vi.fn().mockResolvedValue(null) }, ata)).toBe(0n);
    expect(await readTokenBalance({ getAccountInfo: vi.fn().mockRejectedValue(new Error("429")) }, ata)).toBeNull();
    expect(await readTokenBalance({ getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(10) }) }, ata)).toBeNull();
  });
});
