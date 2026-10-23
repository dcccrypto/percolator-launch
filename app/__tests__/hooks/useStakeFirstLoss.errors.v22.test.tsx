/**
 * #3608: the hook's own `error` line for a refused first-loss deposit was the raw simulation text (errorText). It is
 * now the same plain mapping the other /stake surfaces use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEVNET_PROGRAM_IDS, resolveDevnetProgramIds } from "@/lib/program-ids";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STAKE_ERRORS_V5, STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5 } from "@/lib/v22/sdk";
import { consentViewOf, readFirstLossPool } from "@/lib/v22/stake-v5";

const m = vi.hoisted(() => ({
  conn: { getAccountInfo: vi.fn() },
  wallet: { publicKey: null as unknown, signTransaction: vi.fn(), connected: true },
  sendTx: vi.fn(),
}));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: m.conn }), useWalletCompat: () => m.wallet }));
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
vi.mock("@/lib/config", () => ({ getConfig: () => ({}) }));
vi.mock("@/lib/tx", () => ({ sendTx: m.sendTx }));
vi.mock("@/lib/deposit-guard", () => ({ assertDepositWithinBalance: () => undefined, readTokenBalance: async () => 10n ** 12n }));

import { useStakeFirstLoss } from "@/hooks/useStakeFirstLoss";

const stakeId = new PublicKey(DEVNET_PROGRAM_IDS.stake);
function poolData(): Uint8Array {
  const d = new Uint8Array(STAKE_POOL_SIZE_V5);
  const v = new DataView(d.buffer);
  const F = STAKE_POOL_FIELD_OFF_V5;
  d.set([0x53, 0x50, 0x4f, 0x4f, 0x4c, 0x5f, 0x56, 0x31], F.reserved);
  d[F.version] = 5; d[F.riskMode] = 1; d[F.consentVersion] = 2;
  v.setUint16(F.deployTargetBps, 5000, true); v.setUint16(F.liquidBufferBps, 3000, true); v.setUint16(F.hysteresisBps, 500, true);
  for (const off of [F.slab, 40, 72, 104, F.vault, F.percolatorProgram]) d.set(Keypair.generate().publicKey.toBytes(), off);
  return d;
}

beforeEach(() => {
  vi.clearAllMocks();
  __setDevnetV22ForTest(true);
  m.wallet.publicKey = Keypair.generate().publicKey;
});
afterEach(() => __setDevnetV22ForTest(null));

describe("#3608 useStakeFirstLoss error line", () => {
  it.each([33, 28, 44])("stake error %i from the pre-sign simulation: the plain v2.2 line", async (code) => {
    const data = poolData();
    m.conn.getAccountInfo.mockImplementation(async () => ({ data: Buffer.from(data), owner: stakeId, lamports: 1, executable: false }));
    const stake = resolveDevnetProgramIds().stake;
    const { SimulationRefusal } = await vi.importActual<typeof import("@/lib/tx")>("@/lib/tx");
    m.sendTx.mockRejectedValue(new SimulationRefusal({ InstructionError: [1, { Custom: code }] }, [`Program ${stake} invoke [1]`, `Program ${stake} failed: custom program error: 0x${code.toString(16)}`]));
    const slab = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const { result } = renderHook(() => useStakeFirstLoss(slab, mint));
    await waitFor(() => expect(result.current.pool).not.toBeNull());
    await act(async () => { await result.current.deposit(1_000_000n, consentViewOf(readFirstLossPool(data)!)).catch(() => undefined); });
    expect(result.current.error).toBe(STAKE_ERRORS_V5[code].hint);
    expect(result.current.error).not.toMatch(/simulation|InstructionError|Program|0x|\{/i);
  });
});
