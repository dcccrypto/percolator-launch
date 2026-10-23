
/**
 * useInitUser: the folded starter deposit must NOT be silently clamped to the
 * wallet balance (the "typed 5000, only 12 moved, no warning" bug). An
 * over-balance request is refused BEFORE the account-creation tx is sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useInitUser } from "../../hooks/useInitUser";

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/tx", () => ({ sendTx: vi.fn() }));
vi.mock("@/lib/errorMessages", () => ({ humanizeError: vi.fn((m: string) => m) }));
vi.mock("@/lib/programAllowlist", () => ({ isKnownProgram: () => true, assertKnownProgram: () => {} }));
vi.mock("@/lib/v18-wire", () => ({
  fetchPortfolioIdentity: vi.fn().mockResolvedValue({ portfolioId: 1n, matcherSequence: 0n }),
}));
// tweetnacl's Uint8Array instanceof check fails under jsdom, so Keypair.generate()
// throws "b must be a Uint8Array" — stub it with a fixed keypair-shaped object.
vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  const fixed = new actual.PublicKey("3QcVtG9fXk3c1b8mM7JxT6k2yq6mXq5g8gYw9pJq9yhz");
  return {
    ...actual,
    Keypair: { ...actual.Keypair, generate: () => ({ publicKey: fixed, secretKey: new Uint8Array(64) }) },
    // buffer-layout's Uint8Array check also fails under jsdom.
    SystemProgram: { ...actual.SystemProgram, createAccount: () => new actual.TransactionInstruction({ keys: [], programId: actual.SystemProgram.programId }) },
  };
});
// The hook asks lib/v22/layout whether the slab is a wrapper market (flag off it delegates to the SDK isV17Account, flag on it checks magic + VERSION).
vi.mock("@/lib/v22/layout", async (orig) => ({ ...(await orig<object>()), isWrapperAccount: () => true }));
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    isV17Account: vi.fn(() => true),
    getAta: vi.fn(),
    deriveVaultAuthority: vi.fn(() => [new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), 255]),
  };
});

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { getAta } from "@percolatorct/sdk";

const wallet = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const programId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
const mint = new PublicKey("So11111111111111111111111111111111111111112");
const ata = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
const SLAB = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const tokenAcct = (n: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(n, 64);
  return { data: b };
};

describe("useInitUser starter-deposit guard", () => {
  let conn: {
    getProgramAccounts: ReturnType<typeof vi.fn>;
    getMinimumBalanceForRentExemption: ReturnType<typeof vi.fn>;
    getAccountInfo: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    conn = {
      getProgramAccounts: vi.fn().mockResolvedValue([]),
      getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(1_000_000),
      getAccountInfo: vi.fn(),
    };
    vi.mocked(useConnectionCompat).mockReturnValue({ connection: conn } as never);
    vi.mocked(useWalletCompat).mockReturnValue({
      publicKey: wallet,
      connected: true,
      signTransaction: vi.fn(),
    } as never);
    vi.mocked(useSlabState).mockReturnValue({
      config: { collateralMint: mint },
      programId,
      raw: new Uint8Array(64),
      params: {},
      refresh: vi.fn(),
    } as never);
    vi.mocked(sendTx).mockResolvedValue("sig" as never);
    vi.mocked(getAta).mockResolvedValue(ata);
  });

  it("refuses an over-balance starter deposit and sends NO transaction", async () => {
    conn.getAccountInfo.mockResolvedValue(tokenAcct(12_000_000n)); // wallet holds 12
    const { result } = renderHook(() => useInitUser(SLAB));
    await act(async () => {
      await expect(result.current.initUser(5_000_000_000n)).rejects.toThrow(/exceeds your wallet balance/i);
    });
    expect(sendTx).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/exceeds your wallet balance/i);
  });

  it("refuses when the collateral ATA does not exist", async () => {
    conn.getAccountInfo.mockResolvedValue(null);
    const { result } = renderHook(() => useInitUser(SLAB));
    await act(async () => {
      await expect(result.current.initUser(1_000_000n)).rejects.toThrow(/exceeds your wallet balance/i);
    });
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("deposits the exact requested amount when within balance (no clamping)", async () => {
    conn.getAccountInfo.mockResolvedValue(tokenAcct(50_000_000n));
    const { result } = renderHook(() => useInitUser(SLAB));
    let out: { depositedAmount: bigint } | undefined;
    await act(async () => {
      out = await result.current.initUser(12_000_000n);
    });
    expect(out?.depositedAmount).toBe(12_000_000n);
    expect(sendTx).toHaveBeenCalledTimes(2); // init, then deposit
  });
});
