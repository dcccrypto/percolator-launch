/**
 * useCreatorClaim — WithdrawCreatorFee (tag 90) tests.
 *
 * This hook used to read the market's `insurance_domain_budget` (the LOSS
 * BACKSTOP the engine draws down to cover negative trader PnL) and drain it via
 * `WithdrawInsuranceAsset` (tag 57). Every test below is written so that the
 * OLD implementation would FAIL it:
 *
 *  - the synthetic market carries a large, distinct `insurance_domain_budget`
 *    AND a different `creator_fee_claimable_atoms` at byte 584, so reading the
 *    wrong field returns a recognisably wrong number rather than a plausible one;
 *  - `marketauth` is a different key from asset 0's `insurance_operator`, and the
 *    marketauth wallet must NOT be granted the panel (the old gate accepted it,
 *    tag 90 rejects it);
 *  - the emitted instruction is asserted byte-for-byte: 17 bytes, tag 90, u128
 *    LE amount — and explicitly NOT tag 57;
 *  - a static source guard asserts the module cannot even reference the tag-57
 *    encoder / accounts / budget reader.
 *
 * The real SDK encoders + account specs are used so the wire bytes are TRUE tag
 * 90; only `deriveVaultAuthority` is stubbed (PublicKey.findProgramAddressSync is
 * unreliable under jsdom — same approach as useAdminActions/useInsuranceLP tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  v17MarketAccountLen,
  V17_CREATOR_FEE_CLAIMABLE_OFF,
  V17_HEADER_LEN,
  V17_KIND_MARKET,
  V17_KIND_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_GROUP_OFF,
} from "@percolatorct/sdk";

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
const PROGRAM_ID = "DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj";
const SLAB = "GsBBecjFRwUvsrJ3bCinmCqDhERGtop9BKKEkE8SVa1C";
const COLLATERAL = new PublicKey("EqDqqRzRwA5xnZYu7oJ6LfJbcFuwkTKs7KBSTu2xaG66");
const OPERATOR = new PublicKey("FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7");
/** Deliberately NOT the operator: tag 90 rejects marketauth (stake-pool PDA case). */
const MARKETAUTH = new PublicKey("HLyBte5HgLjZRAfhXRXgzRFc4BXTqPVwadBHEUxY6ftD");
const STRANGER = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

/** The honest claimable: `creator_fee_claimable_atoms` (u64 @ absolute 584). */
const CLAIMABLE = 1_234_567_890n;
/**
 * The BACKSTOP the old implementation misreported as claimable. Distinct from
 * CLAIMABLE by orders of magnitude so a misread is unmistakable.
 */
const BUDGET_LONG = 2_502_588_437n;
const BUDGET_SHORT = 2_502_588_438n;
const BUDGET_TOTAL = BUDGET_LONG + BUDGET_SHORT; // 5_005_176_875

// Engine-internal offsets the claim path must NEVER touch. Owned by this test
// as "forbidden coordinates", not by any app module.
const SLOTS_BASE = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN; // 1350
const ASSET_SLOT_WRAPPER_PREFIX = 512;
const INSURANCE_DOMAIN_BUDGET_LONG_REL = 499;
const INSURANCE_DOMAIN_BUDGET_SHORT_REL = 515;
const PROFILE_INSURANCE_OPERATOR_REL = 56;
const BUDGET_LONG_ABS = SLOTS_BASE + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_LONG_REL;
const BUDGET_SHORT_ABS = SLOTS_BASE + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_SHORT_REL;
/** Absolute offset of the counter this hook is allowed to read. */
const CLAIMABLE_ABS = V17_HEADER_LEN + V17_CREATOR_FEE_CLAIMABLE_OFF; // 584

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

/**
 * A valid single-asset v17 market: the creator counter at 584, a fat insurance
 * domain budget at the engine offsets, marketauth != insurance_operator.
 */
function makeRaw(
  operator: PublicKey,
  claimable: bigint = CLAIMABLE,
  budgetLong: bigint = BUDGET_LONG,
): Uint8Array {
  const buf = Buffer.alloc(v17MarketAccountLen(1));
  // v17 header: magic "\0" "6" "1" "V" "C" "R" "E" "P", version 17, kind MARKET
  buf.set([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50], 0);
  buf.writeUInt16LE(17, 8);
  buf[V17_KIND_OFF] = V17_KIND_MARKET;

  // WrapperConfig: marketauth @16, collateral mint @48
  buf.set(MARKETAUTH.toBytes(), V17_HEADER_LEN);
  buf.set(COLLATERAL.toBytes(), V17_HEADER_LEN + 32);
  // The ONLY honest claimable figure.
  buf.writeBigUInt64LE(claimable, CLAIMABLE_ABS);

  // The loss backstop — present and fat, so reading it instead is detectable.
  const b = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  writeU128LE(b, BUDGET_LONG_ABS, budgetLong);
  writeU128LE(b, BUDGET_SHORT_ABS, BUDGET_SHORT);
  // group insurance total (what the old clamp read) @ MARKET_GROUP_OFF + 301
  writeU128LE(b, V17_MARKET_GROUP_OFF + 301, 10_000_000_000n);

  // asset 0 profile: insurance_operator = the claim authority
  buf.set(operator.toBytes(), SLOTS_BASE + PROFILE_INSURANCE_OPERATOR_REL);
  return new Uint8Array(buf);
}

function slabState(over: Record<string, unknown> = {}) {
  return {
    slabAddress: SLAB,
    raw: makeRaw(OPERATOR),
    config: { collateralMint: COLLATERAL, vaultPubkey: DEST_ATA },
    programId: PROGRAM_ID,
    wrapperConfigV17: { marketauth: MARKETAUTH },
    refresh: vi.fn(),
    ...over,
  };
}

type SentIx = {
  data: Uint8Array;
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
};
function sentInstructions(): SentIx[] {
  const arg = vi.mocked(sendTx).mock.calls[0][0] as unknown as { instructions: SentIx[] };
  return arg.instructions;
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

describe("useCreatorClaim — authority gate is asset 0's insurance_operator", () => {
  it("recognizes the insurance_operator and reports the counter at byte 584", () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    expect(result.current.isOperator).toBe(true);
    expect(result.current.claimable).toBe(CLAIMABLE);
    expect(result.current.claimAuthority?.toBase58()).toBe(OPERATOR.toBase58());
  });

  it("does NOT grant the panel to marketauth (tag 90 rejects it on a staked market)", () => {
    // The old tag-57 gate accepted marketauth; the deployed tag-90 handler does
    // not, and StakeInitPool rotates marketauth to the stake-pool PDA.
    vi.mocked(useWalletCompat).mockReturnValue({
      publicKey: MARKETAUTH,
      signTransaction: vi.fn(),
    } as never);
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    expect(result.current.isOperator).toBe(false);
    expect(result.current.claimable).toBe(0n);
  });

  it("hides the panel for an unrelated wallet", () => {
    vi.mocked(useWalletCompat).mockReturnValue({
      publicKey: STRANGER,
      signTransaction: vi.fn(),
    } as never);
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    expect(result.current.isOperator).toBe(false);
    expect(result.current.claimable).toBe(0n);
  });

  it("reports 0n and no authority on a non-v17 account", () => {
    vi.mocked(useSlabState).mockReturnValue(slabState({ raw: new Uint8Array(4096) }) as never);
    const { result } = renderHook(() => useCreatorClaim());
    expect(result.current.isOperator).toBe(false);
    expect(result.current.claimAuthority).toBeNull();
  });
});

describe("useCreatorClaim — the claimable comes from byte 584, NOT the insurance budget", () => {
  it("ignores the insurance_domain_budget entirely", () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    // The old implementation reported BUDGET_TOTAL here.
    expect(result.current.claimable).toBe(CLAIMABLE);
    expect(result.current.claimable).not.toBe(BUDGET_TOTAL);
    expect(result.current.claimable).not.toBe(BUDGET_LONG);
    expect(result.current.claimable).not.toBe(BUDGET_SHORT);
  });

  it("moving the insurance budget does not move the claimable", () => {
    const raw = makeRaw(OPERATOR, CLAIMABLE, 999_999_999_999n);
    vi.mocked(useSlabState).mockReturnValue(slabState({ raw }) as never);
    const { result } = renderHook(() => useCreatorClaim());
    expect(result.current.claimable).toBe(CLAIMABLE);
  });

  it("moving byte 584 DOES move the claimable (proves the read offset)", () => {
    const raw = makeRaw(OPERATOR, 42n);
    vi.mocked(useSlabState).mockReturnValue(slabState({ raw }) as never);
    const { result } = renderHook(() => useCreatorClaim());
    expect(result.current.claimable).toBe(42n);
  });

  it("keeps full precision above 2^53 (bigint, never Number)", () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    vi.mocked(useSlabState).mockReturnValue(slabState({ raw: makeRaw(OPERATOR, big) }) as never);
    const { result } = renderHook(() => useCreatorClaim());
    expect(typeof result.current.claimable).toBe("bigint");
    expect(result.current.claimable).toBe(big);
  });
});

describe("useCreatorClaim — claim tx shape (tag 90)", () => {
  it("emits tag 90 + amount(u128 LE) = exactly 17 bytes, with the 6 tag-90 accounts", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());

    await act(async () => {
      await result.current.claim();
    });

    expect(sendTx).toHaveBeenCalledTimes(1);
    const ixs = sentInstructions();
    expect(ixs).toHaveLength(1);
    const ix = ixs[0];

    // wire = tag(90) + amount(u128 LE)
    expect(ix.data.length).toBe(1 + 16);
    expect(ix.data[0]).toBe(90);
    expect(readU128LE(ix.data, 1)).toBe(CLAIMABLE);

    // ACCOUNTS_WITHDRAW_CREATOR_FEE:
    // [authority(s,w), market(w), destToken(w), vaultToken(w), vaultAuthority(ro), tokenProgram(ro)]
    expect(ix.keys).toHaveLength(6);
    expect(ix.keys[0].pubkey.toBase58()).toBe(OPERATOR.toBase58());
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.toBase58()).toBe(SLAB);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].pubkey.toBase58()).toBe(DEST_ATA.toBase58());
    expect(ix.keys[3].pubkey.toBase58()).toBe(VAULT_ATA.toBase58());
    expect(ix.keys[4].pubkey.toBase58()).toBe(VAULT_PDA.toBase58());
    expect(ix.keys[4].isWritable).toBe(false);
    expect(ix.keys[5].isSigner).toBe(false);
    expect(ix.keys[5].isWritable).toBe(false);
  });

  it("sends the FULL counter — no clamp against the insurance balance", async () => {
    // The old flow clamped the amount to the group insurance total. Tag 90 is an
    // exact debit of the counter; clamping would silently under-claim.
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await result.current.claim();
    });
    expect(readU128LE(sentInstructions()[0].data, 1)).toBe(CLAIMABLE);
  });

  it("honours an explicit partial amount", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await result.current.claim(1_000n);
    });
    expect(readU128LE(sentInstructions()[0].data, 1)).toBe(1_000n);
  });

  it("refuses amount 0 without sending (tag 90 has no 'withdraw all' sentinel)", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await expect(result.current.claim(0n)).rejects.toThrow(/nothing to claim/i);
    });
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("refuses an over-claim without sending", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await expect(result.current.claim(CLAIMABLE + 1n)).rejects.toThrow(/exceeds/i);
    });
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("refuses to send when the wallet is not the insurance_operator", async () => {
    vi.mocked(useWalletCompat).mockReturnValue({
      publicKey: MARKETAUTH,
      signTransaction: vi.fn(),
    } as never);
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await expect(result.current.claim()).rejects.toThrow(/insurance operator|creator wallet/i);
    });
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("re-reads on-chain state after a successful claim (refresh called)", async () => {
    const st = slabState();
    vi.mocked(useSlabState).mockReturnValue(st as never);
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await result.current.claim();
    });
    expect(st.refresh as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });
});

describe("useCreatorClaim — error mapping", () => {
  it("maps Custom(62) CreatorFeeOverClaim to an exact-amount message", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    vi.mocked(sendTx).mockRejectedValue(new Error('Transaction failed: {"Custom":62}'));
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await expect(result.current.claim()).rejects.toThrow(/exceeds the creator fees/i);
    });
    await waitFor(() => expect(result.current.error).toMatch(/exact-amount/i));
  });

  it("maps Custom(9) to a zero-amount message, not the matcher-config boilerplate", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    vi.mocked(sendTx).mockRejectedValue(new Error("Program failed: Custom(9)"));
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await expect(result.current.claim()).rejects.toThrow(/nothing to claim/i);
    });
    await waitFor(() => expect(result.current.error).not.toMatch(/matcher/i));
  });
});

// ─── The safety property this whole change exists for ────────────────────────
describe("REGRESSION: the claim path can never emit tag 57 or read the insurance budget", () => {
  const hookSource = readFileSync(
    join(__dirname, "..", "..", "hooks", "useCreatorClaim.ts"),
    "utf-8",
  );

  it("never puts tag 57 on the wire", async () => {
    vi.mocked(useSlabState).mockReturnValue(slabState() as never);
    const { result } = renderHook(() => useCreatorClaim());
    await act(async () => {
      await result.current.claim();
    });
    for (const ix of sentInstructions()) {
      expect(ix.data[0]).not.toBe(57); // WithdrawInsuranceAsset
      expect(ix.data[0]).toBe(90); // WithdrawCreatorFee
      // A tag-57 payload is tag + asset_index(u16) + amount(u128) = 19 bytes.
      expect(ix.data.length).not.toBe(19);
    }
  });

  it("does not import the tag-57 encoder, its account list, or the budget reader", () => {
    expect(hookSource).not.toMatch(/encodeWithdrawInsuranceAsset/);
    expect(hookSource).not.toMatch(/ACCOUNTS_WITHDRAW_INSURANCE\b/);
    expect(hookSource).not.toMatch(/insuranceDomainBudget/);
    expect(hookSource).not.toMatch(/readInsuranceDomainBudget/);
    expect(hookSource).not.toMatch(/readAssetInsuranceOperator/);
  });

  it("hardcodes none of the engine-internal budget offsets", () => {
    // 499 / 515 are insurance_domain_budget long/short inside
    // EngineAssetSlotV16Account; 512 is the wrapper asset prefix that precedes
    // it. Any of them appearing here means someone re-derived the backstop read.
    for (const forbidden of [499, 515]) {
      expect(hookSource).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("the module lib/insuranceDomainBudget.ts is gone (no second owner of those offsets)", () => {
    // Retired with the tag-57 path: the claim hook was its only consumer, and a
    // dormant "read the backstop" helper is exactly the thing a future claim UI
    // would reach for again. (A dynamic import() cannot express this — Vite
    // resolves the specifier at transform time and fails the whole suite.)
    expect(existsSync(join(__dirname, "..", "..", "lib", "insuranceDomainBudget.ts"))).toBe(false);
  });
});
