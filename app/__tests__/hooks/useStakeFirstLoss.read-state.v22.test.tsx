/**
 * #3607: the first-loss pool read had no loading or failed state and was never retried. A single
 * devnet 429 left `pool` null for good, so /stake showed the plain 9-byte deposit form for a pool the
 * API labels first-loss, and the program refused it with 33 ConsentRequired.
 *
 * The hook now reports `status` ("idle" | "loading" | "ready" | "none" | "failed"), retries a failed
 * read on its own (FIRST_LOSS_READ_RETRY_MS) and exposes `retry()` for the page's retry button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5 } from "@/lib/v22/sdk";

const m = vi.hoisted(() => ({
  conn: { getAccountInfo: vi.fn() },
  wallet: { publicKey: null as unknown, signTransaction: vi.fn(), connected: true },
}));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: m.conn }), useWalletCompat: () => m.wallet }));
// PDA derivation misbehaves under jsdom's Uint8Array realm; a fixed key keeps the test about the hook.
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<typeof import("@percolatorct/sdk")>();
  const fixed = (await import("@solana/web3.js")).Keypair.generate().publicKey;
  return { ...real, deriveStakePool: () => [fixed, 255], deriveStakeVaultAuth: () => [fixed, 255], deriveDepositPda: () => [fixed, 255] };
});
vi.mock("@/lib/config", () => ({ getConfig: () => ({}) }));
vi.mock("@/lib/tx", () => ({ sendTx: vi.fn() }));

import * as hookModule from "@/hooks/useStakeFirstLoss";
const { useStakeFirstLoss } = hookModule;
// `?? [...]`: on the pre-fix tree the export is absent; the tests must then fail on behaviour, not on import.
const FIRST_LOSS_READ_RETRY_MS: readonly number[] = (hookModule as { FIRST_LOSS_READ_RETRY_MS?: readonly number[] }).FIRST_LOSS_READ_RETRY_MS ?? [1_000, 2_000];

const stakeId = new PublicKey(DEVNET_PROGRAM_IDS.stake);
const SLAB = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();

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
const info = (data: Uint8Array) => ({ data: Buffer.from(data), owner: stakeId, lamports: 1, executable: false });
const RATE_LIMITED = new Error("429 Too Many Requests: https://devnet.helius-rpc.com/?api-key=secret");
const allRetries = FIRST_LOSS_READ_RETRY_MS.reduce((a, b) => a + b, 0);

/** Let the read promise chain and any due retry timers run. */
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  m.conn.getAccountInfo.mockReset();
  m.wallet.publicKey = Keypair.generate().publicKey;
});
afterEach(() => {
  vi.useRealTimers();
  __setDevnetV22ForTest(null);
});

describe("#3607 useStakeFirstLoss read state", () => {
  it("is 'loading' while the pool read is in flight, then 'ready' with the pool", async () => {
    __setDevnetV22ForTest(true);
    let resolve: (v: unknown) => void = () => {};
    m.conn.getAccountInfo.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { result } = renderHook(() => useStakeFirstLoss(SLAB, MINT));
    await flush();
    expect((result.current as { status?: string }).status).toBe("loading");
    expect(result.current.pool).toBeNull();
    resolve(info(poolData()));
    await flush();
    expect((result.current as { status?: string }).status).toBe("ready");
    expect(result.current.pool).not.toBeNull();
  });

  it("a failed read is retried on its own; a transient 429 recovers without the user doing anything", async () => {
    __setDevnetV22ForTest(true);
    m.conn.getAccountInfo.mockRejectedValueOnce(RATE_LIMITED).mockResolvedValue(info(poolData()));
    const { result } = renderHook(() => useStakeFirstLoss(SLAB, MINT));
    await flush();
    expect((result.current as { status?: string }).status).toBe("loading");
    await flush(FIRST_LOSS_READ_RETRY_MS[0]);
    expect(m.conn.getAccountInfo).toHaveBeenCalledTimes(2);
    expect((result.current as { status?: string }).status).toBe("ready");
    expect(result.current.pool).not.toBeNull();
  });

  it("after the automatic retries it is 'failed' (not a silent null), and retry() reads again", async () => {
    __setDevnetV22ForTest(true);
    m.conn.getAccountInfo.mockRejectedValue(RATE_LIMITED);
    const { result } = renderHook(() => useStakeFirstLoss(SLAB, MINT));
    await flush(allRetries + 10);
    expect((result.current as { status?: string }).status).toBe("failed");
    expect(result.current.pool).toBeNull();
    expect(m.conn.getAccountInfo).toHaveBeenCalledTimes(FIRST_LOSS_READ_RETRY_MS.length + 1);

    m.conn.getAccountInfo.mockResolvedValue(info(poolData()));
    act(() => (result.current as { retry?: () => void }).retry?.());
    await flush();
    expect((result.current as { status?: string }).status).toBe("ready");
    expect(result.current.pool).not.toBeNull();
  });

  it("an account that is not a v5 first-loss pool reads as 'none' (the plain form is right for it)", async () => {
    __setDevnetV22ForTest(true);
    m.conn.getAccountInfo.mockResolvedValue(null);
    const { result } = renderHook(() => useStakeFirstLoss(SLAB, MINT));
    await flush();
    expect((result.current as { status?: string }).status).toBe("none");
    expect(result.current.pool).toBeNull();
  });

  it("NEGATIVE CONTROL flag off: 'idle', no RPC, no retries", async () => {
    __setDevnetV22ForTest(false);
    const { result } = renderHook(() => useStakeFirstLoss(SLAB, MINT));
    await flush(allRetries + 10);
    expect((result.current as { status?: string }).status).toBe("idle");
    expect(result.current.pool).toBeNull();
    expect(m.conn.getAccountInfo).not.toHaveBeenCalled();
  });
});
