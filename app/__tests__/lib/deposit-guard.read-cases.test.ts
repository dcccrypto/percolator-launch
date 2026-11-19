/**
 * Characterisation of readTokenBalance / null handling (J-20261119). These pin the behaviour that was
 * audited and judged NOT a bug: every caller passes an ATA derived from (owner, mint, token program),
 * so the address itself fixes the mint and program, and the chain rejects frozen / wrong-state transfers.
 */
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  assertDepositWithinBalance,
  checkDepositAmount,
  readTokenBalance,
} from "@/lib/deposit-guard";

const ata = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
const acct = (amount: bigint, state = 1) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  b[108] = state;
  return b;
};

describe("readTokenBalance audit cases", () => {
  it("reads only the amount field and never looks at owner/program (address is the ATA PDA, so mint/program are fixed by derivation)", async () => {
    const getAccountInfo = vi.fn().mockResolvedValue({ data: acct(42n), owner: PublicKey.default });
    expect(await readTokenBalance({ getAccountInfo }, ata)).toBe(42n);
  });
  it("Token-2022 accounts with extensions (data > 165) read the same amount", async () => {
    const b = Buffer.concat([acct(7n), Buffer.alloc(100)]);
    expect(await readTokenBalance({ getAccountInfo: vi.fn().mockResolvedValue({ data: b }) }, ata)).toBe(7n);
  });
  it("a frozen account (state=2) still reports its balance; the chain rejects the transfer", async () => {
    expect(await readTokenBalance({ getAccountInfo: vi.fn().mockResolvedValue({ data: acct(9n, 2) }) }, ata)).toBe(9n);
  });
  it("exactly 72 bytes is readable, 71 is null", async () => {
    const mk = (n: number) => ({ getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(n) }) });
    expect(await readTokenBalance(mk(72), ata)).toBe(0n);
    expect(await readTokenBalance(mk(71), ata)).toBeNull();
  });
});

describe("null balance handling is split by design", () => {
  it("UI check blocks on null; hook assert lets the chain validate", () => {
    expect(checkDepositAmount(1n, null)).toBe("balance-unknown");
    expect(() => assertDepositWithinBalance(1n, null)).not.toThrow();
  });
});
