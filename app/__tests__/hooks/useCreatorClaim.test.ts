import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  V17_MARKET_GROUP_OFF,
  V17_MARKET_ASSET_SLOT_LEN,
} from "@percolatorct/sdk";
import {
  SLOTS_BASE,
  ASSET_SLOT_WRAPPER_PREFIX,
  INSURANCE_DOMAIN_BUDGET_LONG_REL,
  INSURANCE_DOMAIN_BUDGET_SHORT_REL,
  PROFILE_INSURANCE_OPERATOR_REL,
  slotBase,
} from "@/lib/insuranceDomainBudget";

// The real SDK encoders/accounts are used so we verify TRUE tag-57 bytes; only
// deriveVaultAuthority is stubbed (PublicKey.findProgramAddressSync is unreliable
// under jsdom — same approach as useAdminActions/useInsuranceLP tests).
const VAULT_PDA = new PublicKey("SysvarC1ock11111111111111111111111111111111");
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return { ...actual, deriveVaultAuthority: vi.fn(() => [VAULT_PDA, 255]) };
});

// ─── Mocks ───────────────────────────────────────────────────────────────────
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useParams: vi.fn() }));
vi.mock("@/hooks/useTokenMeta", () => ({
  useTokenMeta: vi.fn(() => ({ symbol: "USDC", name: "USDC", decimals: 6 })),
}));
vi.mock("@/lib/tx", () => ({ sendTx: vi.fn() }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: vi.fn() }));

const DEST_ATA = new PublicKey("2xNweLHL2hjgWykbfnYQ8gRDXysNZaHm2yr4YnQwsxdd");
const VAULT_ATA = new PublicKey("3nJ1t2h4kQ7Pz9m5xVbFqLxKe8sT6rWcY1uD2vB3aE4F");
vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: vi.fn(async (_mint: PublicKey, owner: PublicKey, offCurve?: boolean) =>
    offCurve ? VAULT_ATA : DEST_ATA,
  ),
}));

import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useParams } from "next/navigation";
import { sendTx } from "@/lib/tx";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCreatorClaim } from "@/hooks/useCreatorClaim";

// ─── Fixtures ────────────────────────────────────────────────────────────────
const PROGRAM_ID = "69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9";
const SLAB = "GsBBecjFRwUvsrJ3bCinmCqDhERGtop9BKKEkE8SVa1C";
const COLLATERAL = new PublicKey("EqDqqRzRwA5xnZYu7oJ6LfJbcFuwkTKs7KBSTu2xaG66");
const OPERATOR = new PublicKey("FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7");
const STRANGER = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

const BUDGET_LONG = 2_502_588_437n;
const BUDGET_SHORT = 2_502_588_438n;
const BUDGET_TOTAL = BUDGET_LONG + BUDGET_SHORT; // 5_005_176_875

function writeU128LE(buf: Uint8Array, offset: number, value: bigint) {
  let v = value;
  for (let i = 0; i < 16; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}
function readU128LE(buf: Uint8Array, offset: number): bigint {
  let r = 0n;
  for (let i = 0; i < 16; i++) r |= BigInt(buf[offset + i]) << BigInt(8 * i);
  return r;
}

/** Build a valid single-asset v17 market buffer with the given operator + insurance. */
function makeRaw(operator: PublicKey, insurance = 10_000_000_000n): Uint8Array {
  const buf = new Uint8Array(SLOTS_BASE + 1 * V17_MARKET_ASSET_SLOT_LEN);
  // v17 header: magic, version, kind
  buf.set([0, 54, 49, 86, 67, 82, 69, 80], 0); // V17_MAGIC bytes
  buf[8] = 16; // version LE
  buf[10] = 1; // kind = MARKET
  // group insurance (for the withdraw clamp) at MARKET_GROUP_OFF + 301
  writeU128LE(buf, V17_MARKET_GROUP_OFF + 301, insurance);
  // per-asset budget + operator
  const base = slotBase(0);
  writeU128LE(buf, base + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_LONG_REL, BUDGET_LONG);
  writeU128LE(buf, base + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_SHORT_REL, BUDGET_SHORT);
  buf.set(operator.toBytes(), base + PROFILE_INSURANCE_OPERATOR_REL);
  return buf;
}

function slabState(over: Record<string, unknown> = {}) {
  return {
    slabAddress: SLAB,
    raw: makeRaw(OPERATOR),
    config: { collateralMint: COLLATERAL, vaultPubkey: DEST_ATA },
    programId: PROGRAM_ID,
    wrapperConfigV17: {
      marketauth: OPERATOR,
      insuranceWithdrawCooldownSlots: 0n,
      lastInsuranceWithdrawSlot: 0n,
    },
    refresh: vi.fn(),
    ...over,
  };
}

const connection = { getSlot: vi.fn().mockResolvedValue(1000) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useConnectionCompat).mockReturnValue({ connection } as never);
  vi.mocked(useParams).mockReturnValue({ slab: SLAB } as never);
  vi.mocked(sendTx).mockResolvedValue("claim-signature" as never);
  vi.mocked(useWalletCompat).mockReturnValue({
    publicKey: OPERATOR,
    signTransaction: vi.fn(),
  } as never);
  connection.getSlot.mockResolvedValue(1000);
});

describe("useCreatorClaim — operator gating", () => {
  it("recognizes the connected wallet as the operator and reads the real budget", () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    expect(result.current.isOperator).toBe(true);
    expect(result.current.claimable).toBe(BUDGET_TOTAL);
    expect(result.current.claimableAssets).toEqual([{ assetIndex: 0, claimable: BUDGET_TOTAL }]);
  });

  it("hides the panel for a non-operator, non-marketauth wallet", () => {
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: STRANGER, signTransaction: vi.fn() } as never);
    vi.mocked(useSlabState).mockReturnValue(
      slabState({ raw: makeRaw(OPERATOR), wrapperConfigV17: { marketauth: OPERATOR, insuranceWithdrawCooldownSlots: 0n, lastInsuranceWithdrawSlot: 0n } }) as never,
    );
    const { result } = renderHook(() => useCreatorClaim());
    expect(result.current.isOperator).toBe(false);
    expect(result.current.claimable).toBe(0n);
  });

  it("authorizes marketauth even when it is not the per-asset operator", () => {
    // operator on-chain = STRANGER, but connected wallet == marketauth
    vi.mocked(useSlabState).mockReturnValue(
      slabState({ raw: makeRaw(STRANGER), wrapperConfigV17: { marketauth: OPERATOR, insuranceWithdrawCooldownSlots: 0n, lastInsuranceWithdrawSlot: 0n } }) as never,
    );
    const { result } = renderHook(() => useCreatorClaim());
    expect(result.current.isOperator).toBe(true);
    expect(result.current.claimable).toBe(BUDGET_TOTAL);
  });
});

describe("useCreatorClaim — claim tx shape", () => {
  it("sends WithdrawInsuranceAsset (tag 57) with asset_index + amount and the 6 correct accounts", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());

    await act(async () => {
      await result.current.claim();
    });

    expect(sendTx).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendTx).mock.calls[0][0] as { instructions: { data: Uint8Array; keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }[] };
    const ix = arg.instructions[0];

    // wire = tag(57) + asset_index(u16 LE) + amount(u128 LE)
    expect(ix.data[0]).toBe(57);
    const assetIndex = ix.data[1] | (ix.data[2] << 8);
    expect(assetIndex).toBe(0);
    const amount = readU128LE(ix.data as Uint8Array, 3);
    expect(amount).toBe(BUDGET_TOTAL); // insurance >= budget → not clamped
    expect((ix.data as Uint8Array).length).toBe(1 + 2 + 16);

    // ACCOUNTS_WITHDRAW_INSURANCE: [operator(s,w), market(w), destToken(w), vaultToken(w), vaultAuthority(ro), tokenProgram(ro)]
    expect(ix.keys).toHaveLength(6);
    expect(ix.keys[0].pubkey.toBase58()).toBe(OPERATOR.toBase58());
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.toBase58()).toBe(SLAB);
    expect(ix.keys[2].pubkey.toBase58()).toBe(DEST_ATA.toBase58());
    expect(ix.keys[3].pubkey.toBase58()).toBe(VAULT_ATA.toBase58());
    expect(ix.keys[5].isSigner).toBe(false);
  });

  it("clamps the sent amount to the group insurance balance", async () => {
    // insurance below the budget → amount must be clamped down to insurance
    vi.mocked(useSlabState).mockReturnValue(
      slabState({ raw: makeRaw(OPERATOR, 1_000_000_000n) }) as never,
    );
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await result.current.claim();
    });
    const arg = vi.mocked(sendTx).mock.calls[0][0] as { instructions: { data: Uint8Array }[] };
    const amount = readU128LE(arg.instructions[0].data as Uint8Array, 3);
    expect(amount).toBe(1_000_000_000n);
  });

  it("re-reads on-chain state after a successful claim (refresh called)", async () => {
    const st = slabState();
    vi.mocked(useSlabState).mockReturnValue(st as never);
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await result.current.claim();
    });
    expect((st.refresh as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

describe("useCreatorClaim — error mapping", () => {
  it("maps a Custom(47) cooldown revert to a specific message", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    vi.mocked(sendTx).mockRejectedValue(new Error('Transaction failed: {"Custom":47}'));
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await expect(result.current.claim()).rejects.toThrow(/cooldown/i);
    });
    await waitFor(() => expect(result.current.error).toMatch(/cooldown/i));
  });

  it("maps a Custom(48) ceiling revert to a specific message", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    vi.mocked(sendTx).mockRejectedValue(new Error('{"Custom":48}'));
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await expect(result.current.claim()).rejects.toThrow(/ceiling/i);
    });
  });
});
