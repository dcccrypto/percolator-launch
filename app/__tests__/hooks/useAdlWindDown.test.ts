/**
 * useAdlWindDown: permissionless ADL wind-down of the connected wallet's own position.
 * Only the chain/SDK boundary is mocked (connection, tx send, ix builder, portfolio scan).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

const SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const PROGRAM = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const portfolioKey = Keypair.generate().publicKey;
const walletKey = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

let wallet: { publicKey: PublicKey | null } = { publicKey: walletKey };
let slabState: { programId: string | null; config: unknown; wrapperConfigV17?: { oracleMode: number } } = {
  programId: PROGRAM,
  config: { collateralMint: mint },
};
const getAccountInfo = vi.fn();
const connection = { getAccountInfo };
const findV17Portfolio = vi.fn();
const snapshot = vi.fn();
const sendTx = vi.fn();
const buildIx = vi.fn(() => ({ ix: true }));
const readIdentity = vi.fn(() => ({ portfolioId: 7n, positionEpoch: 3n }));
const crank = vi.fn();
const invalidate = vi.fn();

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection }),
  useWalletCompat: () => wallet,
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => slabState }));
vi.mock("@/hooks/useTrade", () => ({ findV17Portfolio: (...a: unknown[]) => findV17Portfolio(...a) }));
vi.mock("@/lib/userAccountScan", () => ({
  getPortfolioRawSnapshot: (...a: unknown[]) => snapshot(...a),
  makePortfolioScanKey: () => "key",
}));
vi.mock("@/lib/v18-wire", () => ({ readPortfolioIdentity: (...a: unknown[]) => readIdentity(...(a as [])) }));
vi.mock("@/lib/tx", () => ({ sendTx: (...a: unknown[]) => sendTx(...a) }));
vi.mock("@/lib/limits/oracle-tail", () => ({ pythCrankAccount: (...a: unknown[]) => crank(...a) }));
vi.mock("@/lib/v21/sdk", () => ({ buildAdlWindDownIx: (...a: unknown[]) => buildIx(...(a as [])) }));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: () => invalidate() }));

import { useAdlWindDown } from "@/hooks/useAdlWindDown";

describe("useAdlWindDown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wallet = { publicKey: walletKey };
    slabState = { programId: PROGRAM, config: { collateralMint: mint }, wrapperConfigV17: { oracleMode: 1 } };
    snapshot.mockReturnValue(null);
    findV17Portfolio.mockResolvedValue(portfolioKey);
    getAccountInfo.mockResolvedValue({ data: new Uint8Array(16) });
    crank.mockReturnValue(null);
    sendTx.mockResolvedValue("SIG");
  });

  it("starts idle", () => {
    const { result } = renderHook(() => useAdlWindDown(SLAB));
    expect(result.current).toMatchObject({ busy: false, error: null, done: false });
  });

  it.each([
    ["no wallet", () => { wallet = { publicKey: null }; }, SLAB],
    ["no slab address", () => {}, null],
    ["no program id", () => { slabState = { programId: null, config: {} }; }, SLAB],
    ["no market config", () => { slabState = { programId: PROGRAM, config: null }; }, SLAB],
  ])("returns null and does nothing with %s", async (_n, setup, slab) => {
    setup();
    const { result } = renderHook(() => useAdlWindDown(slab));
    let out: string | null = "x";
    await act(async () => { out = await result.current.windDown(); });
    expect(out).toBeNull();
    expect(sendTx).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ busy: false, error: null, done: false });
  });

  it("is busy while the transaction is in flight, then done", async () => {
    let release!: (s: string) => void;
    sendTx.mockReturnValue(new Promise<string>((r) => { release = r; }));
    const { result } = renderHook(() => useAdlWindDown(SLAB));
    let p!: Promise<string | null>;
    act(() => { p = result.current.windDown(); });
    await vi.waitFor(() => expect(result.current.busy).toBe(true));
    expect(result.current.done).toBe(false);
    await act(async () => { release("SIG2"); await p; });
    expect(await p).toBe("SIG2");
    expect(result.current).toMatchObject({ busy: false, done: true, error: null });
  });

  it("finds the portfolio on chain, sends the wind-down and invalidates the portfolio", async () => {
    const { result } = renderHook(() => useAdlWindDown(SLAB));
    let sig: string | null = null;
    await act(async () => { sig = await result.current.windDown(); });
    expect(sig).toBe("SIG");
    expect(findV17Portfolio).toHaveBeenCalledTimes(1);
    expect(getAccountInfo).toHaveBeenCalledWith(portfolioKey, "confirmed");
    const [, accts, args, tail] = buildIx.mock.calls[0] as unknown as [unknown, Record<string, unknown>, Record<string, unknown>, unknown[]];
    expect(accts).toMatchObject({ caller: walletKey, portfolio: portfolioKey, collateralMint: mint });
    expect(args).toMatchObject({ portfolioId: 7n, positionEpoch: 3n, assetIndex: 0, nowSlot: 0n });
    expect(tail).toEqual([]);
    expect(sendTx.mock.calls[0][0]).toMatchObject({ computeUnitsFromSim: { cap: 600_000 } });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ busy: false, done: true, error: null });
  });

  it("uses the cached portfolio snapshot without scanning and passes the oracle account", async () => {
    const oracle = Keypair.generate().publicKey;
    snapshot.mockReturnValue({ pubkey: portfolioKey });
    crank.mockReturnValue(oracle);
    const { result } = renderHook(() => useAdlWindDown(SLAB));
    await act(async () => { await result.current.windDown(); });
    expect(findV17Portfolio).not.toHaveBeenCalled();
    expect(crank).toHaveBeenCalledWith(slabState.config, 1);
    expect((buildIx.mock.calls[0] as unknown[])[3]).toEqual([oracle]);
  });

  it("reports a missing portfolio and does not send", async () => {
    findV17Portfolio.mockResolvedValue(null);
    const { result } = renderHook(() => useAdlWindDown(SLAB));
    let out: string | null = "x";
    await act(async () => { out = await result.current.windDown(); });
    expect(out).toBeNull();
    expect(sendTx).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
    expect(result.current.done).toBe(false);
    expect(result.current.busy).toBe(false);
  });

  it("reports an unreadable portfolio account", async () => {
    getAccountInfo.mockResolvedValue(null);
    const { result } = renderHook(() => useAdlWindDown(SLAB));
    await act(async () => { await result.current.windDown(); });
    expect(sendTx).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
  });

  it("surfaces an RPC error as a message, then clears it and finishes on retry", async () => {
    getAccountInfo.mockRejectedValueOnce(new Error("RPC down"));
    const { result } = renderHook(() => useAdlWindDown(SLAB));
    let out: string | null = "x";
    await act(async () => { out = await result.current.windDown(); });
    expect(out).toBeNull();
    expect(result.current.error).toBeTruthy();
    expect(result.current.done).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => { out = await result.current.windDown(); });
    expect(out).toBe("SIG");
    expect(result.current).toMatchObject({ error: null, done: true, busy: false });
  });

  it("surfaces a send failure and leaves done false", async () => {
    sendTx.mockRejectedValue(new Error("send failed"));
    const { result } = renderHook(() => useAdlWindDown(SLAB));
    await act(async () => { await result.current.windDown(); });
    expect(result.current.error).toBeTruthy();
    expect(result.current.done).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
