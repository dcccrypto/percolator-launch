/**
 * useReclaimSlabRent Hook Tests — PERC-515
 *
 * Verifies that confirmTransaction result.value.err is checked and surfaces
 * on-chain rejections as errors instead of false "success" states.
 *
 * Test Cases:
 * - Happy path: confirmed tx with no error → status = "success"
 * - On-chain rejection: confirmTransaction returns value.err → status = "error"
 * - Wallet not connected → early error
 * - Wallet cannot sign → early error
 * - Slab not found on-chain → early error
 * - Slab already initialised (magic = MAGIC) → early error
 * - Slab not owned by program → early error
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";

// ─── Mock @solana/web3.js Transaction (avoids real serialization in unit tests) ─

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  // Must use regular function expressions (not arrow functions) for constructors
  /* eslint-disable prefer-arrow-callback */
  function MockTransaction(this: Record<string, unknown>) {
    this.add = vi.fn().mockReturnThis();
    this.partialSign = vi.fn();
    this.serialize = vi.fn().mockReturnValue(Buffer.from([1, 2, 3]));
    this.feePayer = null;
  }
  function MockTransactionInstruction(this: Record<string, unknown>, args: unknown) {
    Object.assign(this, args);
  }
  /* eslint-enable prefer-arrow-callback */
  return {
    ...actual,
    Transaction: MockTransaction,
    TransactionInstruction: MockTransactionInstruction,
  };
});

// ─── Mock wallet/connection hooks ─────────────────────────────────────────────

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
}));

import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useReclaimSlabRent } from "../../hooks/useReclaimSlabRent";

// ─── Constants ────────────────────────────────────────────────────────────────

// Must match NEXT_PUBLIC_PROGRAM_ID in vitest.config.ts (module-level const captured at load time)
const PROGRAM_ID = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build an uninitialised slab account info (magic = 0). */
function makeUninitialisedSlabData(): Buffer {
  return Buffer.alloc(32, 0);
}

/** Build an initialised slab account info (magic = PERCOLA T). */
function makeInitialisedSlabData(): Buffer {
  const buf = Buffer.alloc(32, 0);
  buf.writeBigUInt64LE(0x504552434f4c4154n, 0);
  return buf;
}

interface ConnectionOverrides {
  /** What getAccountInfo resolves to (undefined = uninitialised slab; null = not found). */
  accountInfoResult?: ReturnType<typeof makeDefaultAccountInfo> | null;
  /** If set, confirmTransaction returns value.err = this object. */
  confirmError?: object | null;
}

function makeDefaultAccountInfo() {
  return {
    data: makeUninitialisedSlabData(),
    lamports: 2_000_000_000,
    owner: PROGRAM_ID,
    executable: false,
  };
}

function makeMockConnection(overrides: ConnectionOverrides = {}) {
  const accountInfoResult =
    "accountInfoResult" in overrides
      ? overrides.accountInfoResult
      : makeDefaultAccountInfo();

  const confirmError = overrides.confirmError ?? null;

  return {
    getAccountInfo: vi.fn().mockResolvedValue(accountInfoResult),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      lastValidBlockHeight: 999999,
    }),
    sendRawTransaction: vi.fn().mockResolvedValue("test-tx-sig"),
    confirmTransaction: vi.fn().mockResolvedValue({
      value: { err: confirmError },
      context: { slot: 1 },
    }),
  };
}

function makeMockWallet(overrides: {
  publicKey?: PublicKey | null;
  signTransaction?: ((tx: object) => Promise<object>) | null;
} = {}) {
  const walletPubkey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  return {
    publicKey: "publicKey" in overrides ? overrides.publicKey : walletPubkey,
    signTransaction:
      "signTransaction" in overrides
        ? overrides.signTransaction
        : vi.fn().mockImplementation(async (tx: object) => tx),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("useReclaimSlabRent", () => {
  let mockConnection: ReturnType<typeof makeMockConnection>;
  let mockWallet: ReturnType<typeof makeMockWallet>;
  let slabKeypair: Keypair;

  beforeEach(() => {
    vi.clearAllMocks();
    slabKeypair = Keypair.generate();
    mockConnection = makeMockConnection();
    mockWallet = makeMockWallet();

    vi.mocked(useWalletCompat).mockReturnValue(mockWallet as ReturnType<typeof useWalletCompat>);
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: mockConnection,
    } as ReturnType<typeof useConnectionCompat>);
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it("sets status to success when confirmTransaction returns no error", async () => {
    const { result } = renderHook(() => useReclaimSlabRent());
    expect(result.current.status).toBe("idle");

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("success");
    expect(result.current.txSig).toBe("test-tx-sig");
    expect(result.current.error).toBeNull();
    expect(mockConnection.confirmTransaction).toHaveBeenCalledOnce();
  });

  // ── PERC-515: on-chain rejection check ───────────────────────────────────

  it("sets status to error when confirmTransaction returns value.err (on-chain rejection)", async () => {
    const onChainError = { InstructionError: [0, { Custom: 42 }] };
    mockConnection = makeMockConnection({ confirmError: onChainError });
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: mockConnection,
    } as ReturnType<typeof useConnectionCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/Transaction landed on-chain but was rejected/i);
    expect(result.current.error).toContain("InstructionError");
    // txSig must NOT be set — caller should not treat this as success
    expect(result.current.txSig).toBeNull();
  });

  // ── Preflight guards ─────────────────────────────────────────────────────

  it("errors early when wallet is not connected", async () => {
    mockWallet = makeMockWallet({ publicKey: null });
    vi.mocked(useWalletCompat).mockReturnValue(mockWallet as ReturnType<typeof useWalletCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toMatch(/Wallet not connected/i);
    expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("errors early when wallet cannot sign", async () => {
    mockWallet = makeMockWallet({ signTransaction: null });
    vi.mocked(useWalletCompat).mockReturnValue(mockWallet as ReturnType<typeof useWalletCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toMatch(/does not support signing/i);
    expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("errors when slab account not found on-chain", async () => {
    mockConnection = makeMockConnection({ accountInfoResult: null });
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: mockConnection,
    } as ReturnType<typeof useConnectionCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/not found on-chain/i);
    expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("errors when slab is already initialised (magic = MAGIC)", async () => {
    mockConnection = makeMockConnection({
      accountInfoResult: {
        data: makeInitialisedSlabData(),
        lamports: 2_000_000_000,
        owner: PROGRAM_ID,
        executable: false,
      },
    });
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: mockConnection,
    } as ReturnType<typeof useConnectionCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/already initialised/i);
    expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("errors when slab is not owned by the Percolator program", async () => {
    const foreignOwner = Keypair.generate().publicKey;
    mockConnection = makeMockConnection({
      accountInfoResult: {
        data: makeUninitialisedSlabData(),
        lamports: 2_000_000_000,
        owner: foreignOwner,
        executable: false,
      },
    });
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: mockConnection,
    } as ReturnType<typeof useConnectionCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/not owned by a? Percolator program/i);
    expect(mockConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  // ── Friendly error message translation ───────────────────────────────────

  it("shows friendly message when user rejects the signing request", async () => {
    mockWallet = makeMockWallet({
      signTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")),
    });
    vi.mocked(useWalletCompat).mockReturnValue(mockWallet as ReturnType<typeof useWalletCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/cancelled|rejected/i);
    // Must NOT contain raw stack trace or internal noise
    expect(result.current.error).not.toMatch(/Error:/);
  });

  it("shows friendly message for network errors during broadcast", async () => {
    mockConnection = makeMockConnection();
    mockConnection.sendRawTransaction = vi.fn().mockRejectedValue(new Error("Failed to fetch: network error ECONNRESET"));
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: mockConnection,
    } as ReturnType<typeof useConnectionCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/network error/i);
  });

  it("shows friendly message for blockhash expiry", async () => {
    mockConnection = makeMockConnection();
    mockConnection.sendRawTransaction = vi.fn().mockRejectedValue(new Error("Blockhash not found"));
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: mockConnection,
    } as ReturnType<typeof useConnectionCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/expired/i);
  });

  it("shows friendly message for 0x4 program error in message", async () => {
    mockConnection = makeMockConnection();
    mockConnection.sendRawTransaction = vi.fn().mockRejectedValue(
      new Error("Transaction simulation failed: Error processing Instruction 0: custom program error: 0x4")
    );
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: mockConnection,
    } as ReturnType<typeof useConnectionCompat>);

    const { result } = renderHook(() => useReclaimSlabRent());

    await act(async () => {
      await result.current.reclaim(slabKeypair);
    });

    expect(result.current.status).toBe("error");
    // 0x4 = account already cleaned up / reclaimed
    expect(result.current.error).toMatch(/already been reclaimed|no longer on-chain/i);
  });
});
