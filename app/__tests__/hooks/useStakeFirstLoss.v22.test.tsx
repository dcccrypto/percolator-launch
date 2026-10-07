import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5 } from "@/lib/v22/sdk";
import { ConsentChangedError, consentViewOf, readFirstLossPool } from "@/lib/v22/stake-v5";

const m = vi.hoisted(() => ({
  conn: { getAccountInfo: vi.fn(), getMultipleAccountsInfo: vi.fn(), getSlot: vi.fn().mockResolvedValue(1) },
  wallet: { publicKey: null as unknown, signTransaction: vi.fn(), connected: true },
  sendTx: vi.fn(),
}));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: m.conn }), useWalletCompat: () => m.wallet }));
// PDA derivation (sha256 + curve check) misbehaves under jsdom's Uint8Array realm; fixed keys keep the test about the hook.
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<typeof import("@percolatorct/sdk")>();
  const fixed = (await import("@solana/web3.js")).Keypair.generate().publicKey;
  return { ...real, deriveStakePool: () => [fixed, 255], deriveStakeVaultAuth: () => [fixed, 255], deriveDepositPda: () => [fixed, 255] };
});
vi.mock("@/lib/v22/sdk", async (orig) => {
  const real = await orig<typeof import("@/lib/v22/sdk")>();
  const fixed = (await import("@solana/web3.js")).Keypair.generate().publicKey;
  return { ...real, deriveInsuranceUnitsV22: () => [fixed, 255] };
});
vi.mock("@solana/spl-token", async (orig) => {
  const real = await orig<typeof import("@solana/spl-token")>();
  const fixed = (await import("@solana/web3.js")).Keypair.generate().publicKey;
  return { ...real, getAssociatedTokenAddress: async () => fixed };
});
vi.mock("@/lib/tx", () => ({ sendTx: m.sendTx }));
vi.mock("@/lib/deposit-guard", () => ({ assertDepositWithinBalance: () => undefined, readTokenBalance: async () => 10n ** 12n }));

import { useStakeFirstLoss } from "@/hooks/useStakeFirstLoss";

const stakeId = new PublicKey(DEVNET_PROGRAM_IDS.stake);
const SLAB = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;

function poolData(target: number): Uint8Array {
  const d = new Uint8Array(STAKE_POOL_SIZE_V5);
  const v = new DataView(d.buffer);
  const F = STAKE_POOL_FIELD_OFF_V5;
  d.set([0x53, 0x50, 0x4f, 0x4f, 0x4c, 0x5f, 0x56, 0x31], F.reserved);
  d[F.version] = 5; d[F.riskMode] = 1; d[F.consentVersion] = 2;
  v.setUint16(F.deployTargetBps, target, true); v.setUint16(F.liquidBufferBps, 3000, true); v.setUint16(F.hysteresisBps, 500, true);
  for (const off of [F.slab, 40, 72, 104, F.vault, F.percolatorProgram]) d.set(Keypair.generate().publicKey.toBytes(), off);
  return d;
}
const info = (data: Uint8Array) => ({ data: Buffer.from(data), owner: stakeId, lamports: 1, executable: false });

beforeEach(() => {
  vi.clearAllMocks();
  m.wallet.publicKey = Keypair.generate().publicKey;
  m.sendTx.mockResolvedValue("sig");
});
afterEach(() => __setDevnetV22ForTest(null));

describe("useStakeFirstLoss", () => {
  it("flag off: no RPC at all and no pool (existing deposit UI is used)", async () => {
    __setDevnetV22ForTest(false);
    const { result } = renderHook(() => useStakeFirstLoss(SLAB.toBase58(), MINT.toBase58()));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.pool).toBeNull();
    expect(m.conn.getAccountInfo).not.toHaveBeenCalled();
  });

  it("flag on, v5 first-loss pool: read; a deposit with the accepted numbers is sent as the 16-byte consent form", async () => {
    __setDevnetV22ForTest(true);
    const data = poolData(5000);
    m.conn.getAccountInfo.mockImplementation(async () => info(data));
    const { result } = renderHook(() => useStakeFirstLoss(SLAB.toBase58(), MINT.toBase58()));
    await waitFor(() => expect(result.current.pool).not.toBeNull());
    const accepted = consentViewOf(readFirstLossPool(data)!);
    await act(async () => { await result.current.deposit(1_000_000n, accepted); });
    expect(m.sendTx).toHaveBeenCalledTimes(1);
    const ixs = m.sendTx.mock.calls[0][0].instructions as { data: Buffer; keys: unknown[] }[];
    const dep = ixs[ixs.length - 1];
    expect(dep.data.length).toBe(16);
    expect(dep.data[9]).toBe(2);
    expect(dep.keys.length).toBe(14);
  });

  it("the pool changed after the user consented: nothing is sent, ConsentChangedError carries the new numbers", async () => {
    __setDevnetV22ForTest(true);
    const before = poolData(5000);
    m.conn.getAccountInfo.mockImplementation(async () => info(before));
    const { result } = renderHook(() => useStakeFirstLoss(SLAB.toBase58(), MINT.toBase58()));
    await waitFor(() => expect(result.current.pool).not.toBeNull());
    const accepted = consentViewOf(readFirstLossPool(before)!);
    m.conn.getAccountInfo.mockImplementation(async () => info(poolData(6500)));
    let err: unknown;
    await act(async () => { try { await result.current.deposit(1_000_000n, accepted); } catch (e) { err = e; } });
    expect(err).toBeInstanceOf(ConsentChangedError);
    expect((err as ConsentChangedError).now.targetBps).toBe(6500);
    expect(m.sendTx).not.toHaveBeenCalled();
  });
});
