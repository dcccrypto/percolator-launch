// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from "@solana/spl-token";

vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<object>()),
  parseLpVaultRegistry: () => ({ totalLpSharesOutstanding: 2_000_000_000n, feeDistributionTotalAtoms: 0n }),
  parseLpRedemption: () => ({ shares: 100n }),
}));
const pots = vi.hoisted(() => ({ readable: true }));
vi.mock("@/lib/limits/earn-split-pot", () => ({
  readSplitPotState: async () => (pots.readable ? { own: {}, sib: {}, totalShares: 2_000_000_000n, feeShareBps: 1000 } : null),
  vaultValue: () => ({ nav: 2_002_000_000n, available: 2_002_000_000n }),
}));
import { readEarnPositions, valueShares } from "@/lib/limits/earn-positions";
import * as C from "@/lib/limits/constants";

const PROG = Keypair.generate().publicKey;
const WALLET = Keypair.generate().publicKey;
const tokenAcct = (amount: bigint) => {
  const d = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint: PublicKey.default, owner: WALLET, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, d);
  return { data: d, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
};

// v2.1 account fixtures: decoded by the v2.1 parsers (v2.2 flag off), the convention from 02e50adc.
beforeEach(() => __setDevnetV22ForTest(false));
afterEach(() => __setDevnetV22ForTest(null));

describe("readEarnPositions", () => {
  it("values the wallet's LP ATA (a creator's seed) + escrow at the program NAV", async () => {
    const slab = Keypair.generate().publicKey.toBase58();
    const conn = {
      getMultipleAccountsInfo: vi.fn(async () => [tokenAcct(1_999_999_000n), { data: Buffer.alloc(8), owner: PROG }, { data: Buffer.alloc(8), owner: PROG }]),
    };
    const m = await readEarnPositions(conn as never, PROG, WALLET, [slab]);
    expect(m.get(slab)).toEqual({ shares: 1_999_999_100n, valueAtoms: valueShares(1_999_999_100n, 2_002_000_000n, 2_000_000_000n) });
  });
  // S10: a two-pot vault (every live registry) whose pots can't be read was valued at registry
  // shares + fees: here 1,999,999,100 shares -> ~$2,000 against a ~$2,002 NAV, on devnet ~3,450x.
  it("a two-pot vault whose pots can't be read is unknown, not shares + fees", async () => {
    pots.readable = false;
    const slab = Keypair.generate().publicKey.toBase58();
    const reg = Buffer.alloc(C.LP_VAULT_REGISTRY_ACCOUNT_LEN);
    reg[C.HEADER_KIND_OFF] = C.KIND_LP_VAULT_REGISTRY;
    reg[C.REG_VAULT_LP_BOUND_FLAG] = 0;
    const conn = { getMultipleAccountsInfo: vi.fn(async () => [tokenAcct(1_999_999_000n), { data: Buffer.alloc(8), owner: PROG }, { data: reg, owner: PROG }]) };
    const m = await readEarnPositions(conn as never, PROG, WALLET, [slab]);
    pots.readable = true;
    expect(m.get(slab)).toEqual({ shares: 1_999_999_100n, valueAtoms: null });
  });
  it("CONTROL: a legacy registry (not two-pot) with no pot state keeps shares + fees", async () => {
    pots.readable = false;
    const slab = Keypair.generate().publicKey.toBase58();
    const conn = { getMultipleAccountsInfo: vi.fn(async () => [tokenAcct(1_999_999_000n), { data: Buffer.alloc(8), owner: PROG }, { data: Buffer.alloc(8), owner: PROG }]) };
    const m = await readEarnPositions(conn as never, PROG, WALLET, [slab]);
    pots.readable = true;
    expect(m.get(slab)).toEqual({ shares: 1_999_999_100n, valueAtoms: valueShares(1_999_999_100n, 2_000_000_000n, 2_000_000_000n) });
  });
  it("a vault with no registry is unknown, not zero", async () => {
    const slab = Keypair.generate().publicKey.toBase58();
    const conn = { getMultipleAccountsInfo: vi.fn(async () => [null, null, null]) };
    expect((await readEarnPositions(conn as never, PROG, WALLET, [slab])).has(slab)).toBe(false);
  });
});
