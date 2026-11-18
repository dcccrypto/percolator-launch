/**
 * useDeposit — collateral-ATA creation must not depend on a flaky getAccount().
 *
 * A transient RPC error (429/timeout/5xx) from getAccount() used to be read as
 * "ATA missing", pushing the NON-idempotent createAssociatedTokenAccount ix,
 * which fails the whole tx when the ATA already exists. The create ix must be
 * the idempotent variant (no-op on an existing ATA) on both deposit paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

const mocks = vi.hoisted(() => ({ getAccount: vi.fn() }));

vi.mock("@solana/spl-token", async () => {
  const actual = await vi.importActual<typeof import("@solana/spl-token")>("@solana/spl-token");
  return { ...actual, getAccount: mocks.getAccount };
});
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/tx", () => ({ sendTx: vi.fn() }));
vi.mock("@/lib/programAllowlist", () => ({ isKnownProgram: () => true, assertKnownProgram: () => {} }));
vi.mock("@/lib/v18-wire", () => ({
  fetchPortfolioIdentity: vi.fn().mockResolvedValue({ portfolioId: 1n, matcherSequence: 0n }),
}));
vi.mock("@/lib/deposit-guard", () => ({
  assertDepositWithinBalance: () => {},
  readTokenBalance: vi.fn().mockResolvedValue(null),
}));
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual("@percolatorct/sdk");
  const { PublicKey: PK } = await import("@solana/web3.js");
  return { ...actual, getAta: vi.fn(), parseAllAccounts: () => [], deriveVaultAuthority: () => [new PK("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), 255] };
});

import { useDeposit } from "../../hooks/useDeposit";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { getAta } from "@percolatorct/sdk";

const wallet = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const programId = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const mint = new PublicKey("So11111111111111111111111111111111111111112");
const vault = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const userAta = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
const portfolio = new PublicKey("Vote111111111111111111111111111111111111111");
const slab = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";

function sentIxs(): TransactionInstruction[] {
  return (vi.mocked(sendTx).mock.calls.at(-1)![0] as any).instructions;
}
function ataIxs(ixs: TransactionInstruction[]) {
  return ixs.filter((i) => i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
}

describe("useDeposit ATA creation under transient getAccount errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccount.mockRejectedValue(new Error("429 Too Many Requests"));
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: { getAccountInfo: vi.fn().mockResolvedValue(null) },
    } as any);
    vi.mocked(useWalletCompat).mockReturnValue({
      publicKey: wallet, connected: true, signTransaction: vi.fn(),
    } as any);
    vi.mocked(sendTx).mockResolvedValue({ signature: "sig" } as any);
    vi.mocked(getAta).mockResolvedValue(userAta);
  });

  it("v17 path: RPC error on existing ATA never yields a non-idempotent create ix", async () => {
    vi.mocked(useSlabState).mockReturnValue({
      config: { collateralMint: mint, vaultPubkey: vault },
      programId, wrapperConfigV17: {}, refresh: vi.fn(),
    } as any);
    const { result } = renderHook(() => useDeposit(slab));
    await act(async () => {
      await result.current.deposit({ userIdx: 0, amount: 1_000_000n, portfolioPk: portfolio, accountExists: true } as any);
    });
    const atas = ataIxs(sentIxs());
    // Non-idempotent create has data length 0 (or [0]); idempotent has [1].
    expect(atas).toHaveLength(1);
    expect(Array.from(atas[0].data)).toEqual([1]);
  });

  it("legacy path: RPC error on existing ATA never yields a non-idempotent create ix", async () => {
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: { getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(64), owner: programId }) },
    } as any);
    vi.mocked(useSlabState).mockReturnValue({
      config: { collateralMint: mint, vaultPubkey: vault },
      programId, wrapperConfigV17: null, refresh: vi.fn(),
    } as any);
    const { result } = renderHook(() => useDeposit(slab));
    await act(async () => {
      await result.current.deposit({ userIdx: 0, amount: 1_000_000n } as any);
    });
    const atas = ataIxs(sentIxs());
    expect(atas).toHaveLength(1);
    expect(Array.from(atas[0].data)).toEqual([1]);
  });
});
