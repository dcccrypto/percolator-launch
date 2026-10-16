/**
 * M-9 (code review 2026-10-01): on a BOUND (P3) vault the Earn previews, max-now and the deposit
 * gate must be fed the program's `bound_vault_nav`, not `shares + feeDistributionTotal`.
 * `state.backingNavAtoms` is what those call sites read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { useInsuranceLP } from "../../hooks/useInsuranceLP";

const vp = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("@/lib/limits/earn-split-pot", async (orig) => {
  const actual = await orig<typeof import("@/lib/limits/earn-split-pot")>();
  return { ...actual, readVaultPotState: vi.fn(async () => vp.state) };
});

// Mock dependencies
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: vi.fn(),
}));

vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn(),
}));

// Allow the test program ID through the program allowlist gate.
// The real gate is tested in programAllowlist.test.ts.
vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
}));

vi.mock("@percolatorct/sdk", async () => {
  const { PublicKey: PK } = await import("@solana/web3.js");
  // NOTE: vi.mock factories are hoisted — we must use dynamic import for external deps.
  const lpMint = new PK("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  const vaultAuth = new PK("11111111111111111111111111111111"); // all-zeros via string (valid)
  const registryPda = new PK("7pXnR8Eg2g7YDtPkUeEmcYNpPN5yzGLbNHREeHJMzNhq"); // stable 32-byte pubkey
  const redemptionPda = new PK("6UwgpB4FBfQpKW8ACFv7EW5vXg1NiHRQijYzGBaXJSHJ"); // stable 32-byte pubkey
  const ledgerPda = new PK("5YNmS1R9nNSCDzb5a7mMJ1dwK9uH27bN3i2JK1eGfwCM"); // stable 32-byte pubkey
  const escrowPda = new PK("4mB4qULhrn1PcDCTVfE3XPfKvGiCTiXhbmzuUwrQZzJj"); // stable 32-byte pubkey
  const progId = new PK("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  return {
    deriveInsuranceLpMint: vi.fn().mockReturnValue([lpMint, 255]),
    deriveVaultAuthority: vi.fn().mockReturnValue([vaultAuth, 254]),
    deriveLpVaultRegistry: vi.fn().mockReturnValue([registryPda, 253]),
    deriveLpRedemption: vi.fn().mockReturnValue([redemptionPda, 252]),
    deriveLpBackingLedger: vi.fn().mockReturnValue([ledgerPda, 251]),
    // BUG FIX (devnet flow-test 2026-07-01): added when useInsuranceLP.ts's withdraw() was
    // fixed to include the escrow account (see hook's inline fix comment) — the mock didn't
    // know about this new SDK import, so both withdraw() tests failed with
    // "No 'deriveLpEscrow' export is defined on the mock".
    deriveLpEscrow: vi.fn().mockReturnValue([escrowPda, 250]),
    encodeCreateLpVaultV17: vi.fn().mockReturnValue(Buffer.alloc(32)),
    encodeDepositToLpVault: vi.fn().mockReturnValue(Buffer.alloc(16)),
    encodeRequestRedeemLpShares: vi.fn().mockReturnValue(Buffer.alloc(16)),
    encodeExecuteRedemption: vi.fn().mockReturnValue(Buffer.alloc(8)),
    // Without this the hook's registry read throws into its catch and
    // lpVaultDomain silently stays 0, so no test could ever see a wrong domain.
    parseLpVaultRegistry: vi.fn().mockReturnValue({
      totalLpSharesOutstanding: 1_000_000n,
      feeDistributionTotalAtoms: 0n,
      redemptionCooldownSlots: 0n,
      domain: 0,
    }),
    // The payout reads the pending ticket's shares (split-pot planning, 2026-10-01b).
    parseLpRedemption: vi.fn().mockReturnValue({ shares: 1_000n, requestSlot: 0n }),
    encodeRebalanceLpVaultBacking: vi.fn().mockReturnValue(Buffer.alloc(35)),
    ACCOUNTS_REBALANCE_LP_VAULT_BACKING: [],
    buildAccountMetas: vi.fn().mockReturnValue([]),
    buildIx: vi.fn().mockReturnValue({
      programId: progId,
      keys: [],
      data: Buffer.alloc(8),
    }),
    ACCOUNTS_CREATE_LP_VAULT: [],
    ACCOUNTS_LP_VAULT_DEPOSIT: [],
    WELL_KNOWN: {
      systemProgram: new PK("11111111111111111111111111111111"),
      tokenProgram: new PK("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      clock: new PK("SysvarC1ock11111111111111111111111111111111"),
    },
  };
});

vi.mock("@solana/spl-token", () => ({
  TOKEN_PROGRAM_ID: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  getAssociatedTokenAddress: vi.fn(),
  createAssociatedTokenAccountInstruction: vi.fn(),
  unpackMint: vi.fn(),
  unpackAccount: vi.fn(),
}));

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useParams } from "next/navigation";
import { getAssociatedTokenAddress, unpackMint, unpackAccount } from "@solana/spl-token";
import * as C from "@/lib/limits/constants";
import type { DomainState } from "@/lib/limits/earn-split-pot";

const BS = C.BOUND_SCALE;
const src = { positiveClaimBound: 0n, freshReserved: 0n, validLienedBacking: 0n, insuranceCreditReserved: 0n, validLienedInsurance: 0n, impairedLienedInsurance: 0n };
const pot = (principal: bigint, held: bigint, earnings = 0n): DomainState => ({
  bucket: { freshUnliened: held * BS, validLiened: 0n, consumed: 0n, impaired: 0n, utilFeeEarnings: 0n, status: 1 },
  source: src,
  ledger: { totalPrincipal: principal, totalEarnings: earnings, totalEarningsWithdrawn: 0n, lastObsBucketEarnings: 0n, cumulativeLoss: 0n, cumulativeRecovery: 0n, lastObsUnavailable: 0n },
});

// v2.1 account fixtures: decoded by the v2.1 parsers (v2.2 flag off), the convention from 02e50adc.
beforeEach(() => __setDevnetV22ForTest(false));
afterEach(() => __setDevnetV22ForTest(null));

describe("useInsuranceLP backing NAV (M-9)", () => {
  const programId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const wallet = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  let connection: { getAccountInfo: ReturnType<typeof vi.fn>; getSlot: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    connection = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(82), executable: false, lamports: 1, owner: programId }),
      getSlot: vi.fn().mockResolvedValue(0),
    };
    vi.mocked(useConnectionCompat).mockReturnValue({ connection } as never);
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: wallet, connected: true } as never);
    vi.mocked(useSlabState).mockReturnValue({
      programId,
      engine: { insuranceFund: { balance: 0n } },
      config: { collateralMint: new PublicKey("So11111111111111111111111111111111111111112"), vaultPubkey: programId },
    } as never);
    vi.mocked(useParams).mockReturnValue({ slab: "11111111111111111111111111111111" });
    vi.mocked(getAssociatedTokenAddress).mockResolvedValue(wallet);
    vi.mocked(unpackMint).mockReturnValue({ supply: 1_000_000n, decimals: 6, isInitialized: true } as never);
    vi.mocked(unpackAccount).mockReturnValue({ amount: 0n } as never);
  });

  it("a bound vault prices on bound_vault_nav, not shares + distributed fees", async () => {
    // Registry (mocked SDK): 1,000,000 shares, 0 fees -> proxy 1,000,000. The pots say the senior
    // backing is impaired: own pot holds 600,000 of its 800,000 principal, sibling 200,000 of
    // 200,000, plus 50,000 earnings at 10% -> 805,000.
    vp.state = { bound: true, own: pot(800_000n, 600_000n, 50_000n), sib: pot(200_000n, 200_000n), feeShareBps: 1_000, ownDomain: 0, totalShares: 1_000_000n, ownLedger: programId, sibLedger: programId };
    const { result } = renderHook(() => useInsuranceLP());
    await waitFor(() => expect(result.current.state.registryExists).toBe(true));
    await waitFor(() => expect(result.current.state.backingNavAtoms).toBe(805_000n));
    expect(result.current.state.splitPot).toBeNull();
  });

  // S10: every live registry is unbound (two-pot). A failed pot read (RPC 429 -> readVaultPotState
  // null) used to publish the registry's shares + fees as the vault's value with readError false.
  describe("two-pot vault whose pots can't be read", () => {
    /** A real-shaped registry: kind 5, length 176, bound flag 0 (unbound, two-pot). */
    const twoPotRegistry = () => {
      const d = Buffer.alloc(C.LP_VAULT_REGISTRY_ACCOUNT_LEN);
      d[C.HEADER_KIND_OFF] = C.KIND_LP_VAULT_REGISTRY;
      d[C.REG_VAULT_LP_BOUND_FLAG] = 0;
      return { data: d, executable: false, lamports: 1, owner: programId };
    };
    const healthy = () => ({ bound: false, own: pot(500_000n, 500_000n), sib: pot(200_000n, 200_000n), feeShareBps: 1_000, ownDomain: 0, totalShares: 1_000_000n, ownLedger: programId, sibLedger: programId });

    it("a failed pot read after a good load keeps the last good figures and flags readError", async () => {
      connection.getAccountInfo.mockResolvedValue(twoPotRegistry());
      vp.state = healthy();
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.state.splitPot).not.toBeNull());
      const good = result.current.state.vaultTotalAtoms;
      expect(good).toBeLessThan(1_000_000n); // the pots hold far less than the 1,000,000 shares
      vp.state = null;
      await result.current.refreshState();
      await waitFor(() => expect(result.current.readError).toBe(true));
      expect(result.current.state.vaultTotalAtoms).toBe(good);
      expect(result.current.state.splitPot).not.toBeNull(); // the withdraw form still prices from the last NAV
    });

    it("a failed pot read on the first load publishes nothing (not shares + fees)", async () => {
      connection.getAccountInfo.mockResolvedValue(twoPotRegistry());
      vp.state = null;
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.readError).toBe(true));
      expect(result.current.state.registryExists).toBe(false);
      expect(result.current.state.vaultTotalAtoms).not.toBe(1_000_000n);
    });

    it("CONTROL: a legacy registry (not two-pot) keeps its shares + fees fallback", async () => {
      vp.state = null; // the default 82-byte registry doesn't decode as two-pot
      const { result } = renderHook(() => useInsuranceLP());
      await waitFor(() => expect(result.current.state.registryExists).toBe(true));
      expect(result.current.state.vaultTotalAtoms).toBe(1_000_000n);
      expect(result.current.readError).toBe(false);
    });
  });

  it("a two-pot vault keeps its combined NAV as the backing NAV", async () => {
    vp.state = { bound: false, own: pot(700_000n, 700_000n), sib: pot(300_000n, 300_000n), feeShareBps: 1_000, ownDomain: 0, totalShares: 1_000_000n, ownLedger: programId, sibLedger: programId };
    const { result } = renderHook(() => useInsuranceLP());
    await waitFor(() => expect(result.current.state.splitPot?.navAtoms).toBe(1_000_000n));
    expect(result.current.state.backingNavAtoms).toBe(result.current.state.vaultTotalAtoms);
  });
});
