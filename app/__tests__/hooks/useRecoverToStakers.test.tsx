/**
 * useRecoverToStakers: stake tag 29 RecoverTerminalInsurance. The REAL instruction builder runs (vendored buildRecoverTerminalInsuranceIx over
 * @percolatorct/sdk 8.0.0 `recoverTerminalInsuranceAccounts` / `encodeStakeRecoverTerminalInsurance`); only the account decoders, the wallet,
 * the connection and the tx sender are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { RECOVER_COPY } from "@/lib/v22/resolved-claims";
import { recoverRefusalCopy, useRecoverToStakers } from "@/hooks/useRecoverToStakers";

const k = () => Keypair.generate().publicKey;
const CALLER = k();
const MARKET = k();
const STAKE = new PublicKey(DEVNET_PROGRAM_IDS.stake);
const WRAPPER = k();
const MINT = k();
const ADMIN = k();
const VAULT = k();

const h = vi.hoisted(() => ({
  wallet: { publicKey: null as unknown, signTransaction: vi.fn() } as { publicKey: unknown; signTransaction: unknown },
  getAccountInfo: vi.fn(),
  conn: null as unknown,
  pool: null as unknown,
  cap: null as unknown,
  sim: vi.fn(),
  send: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => h.wallet,
  useConnectionCompat: () => h.conn,
}));
// jsdom's TextEncoder yields a foreign-realm Uint8Array that breaks web3.js findProgramAddressSync, so the PDAs are stubbed here; the real
// builder with real PDAs is asserted in useRecoverToStakers.builder.test.ts (node environment).
vi.mock("@percolatorct/sdk", async (orig) => {
  const { PublicKey: PK } = await import("@solana/web3.js");
  const fixed = new PK("11111111111111111111111111111112");
  const poolKey = new PK("SysvarC1ock11111111111111111111111111111111");
  return { ...(await orig<typeof import("@percolatorct/sdk")>()), deriveStakePool: (slab: PublicKey, prog?: PublicKey) => [prog && prog.toBase58() === "VmpVUArRnVkrjaPXQ2qaqCQa3ZrZFgsz7rjeALitF5w" ? poolKey : fixed, 255], deriveStakeVaultAuth: () => [fixed, 255], deriveVaultAuthority: () => [fixed, 255] };
});
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: (mint: PublicKey) => mint,
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({}) }));
vi.mock("@/lib/tx", () => ({ simulateForGate: h.sim, sendTx: h.send }));
vi.mock("@/lib/wallet-balance-invalidation", () => ({ invalidateWalletBalance: h.invalidate }));
vi.mock("@/lib/v22/sdk", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/sdk")>()),
  deriveInsuranceUnitsV22: () => [new (require("@solana/web3.js").PublicKey)("11111111111111111111111111111112"), 255],
  decodeStakePoolV5: () => h.pool,
}));
vi.mock("@/lib/v22/sdk/records/stake-wind-down", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/sdk/records/stake-wind-down")>()),
  decodeTerminalInsuranceCapacity: () => h.cap,
}));

h.conn = { connection: { getAccountInfo: h.getAccountInfo } }; // stable identity: a fresh object per render would re-run load() forever
const poolState = (riskMode: number, poolMode = 0) => ({ riskMode, poolMode, admin: ADMIN, collateralMint: MINT, vault: VAULT, percolatorProgram: WRAPPER });
const cap = (o: Partial<{ resolved: boolean; terminalCapacity: bigint; materializedPortfolioCount: bigint }> = {}) => ({
  resolved: true,
  terminalCapacity: 5_000n,
  materializedPortfolioCount: 0n,
  ...o,
});

function setup(o: { risk?: number; poolMode?: number; cap?: ReturnType<typeof cap>; wallet?: boolean } = {}) {
  h.pool = poolState(o.risk ?? 0, o.poolMode ?? 0);
  h.cap = o.cap ?? cap();
  h.wallet.publicKey = o.wallet === false ? null : CALLER;
  h.getAccountInfo.mockImplementation(async (key: PublicKey) => {
    if (key.equals(MARKET)) return { owner: WRAPPER, data: Buffer.alloc(8), lamports: 1 };
    if (key.toBase58() === "SysvarC1ock11111111111111111111111111111111") return { owner: STAKE, data: Buffer.alloc(8), lamports: 1 };
    return { owner: WRAPPER, data: Buffer.alloc(8), lamports: 1 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __setDevnetV22ForTest(true);
  h.sim.mockResolvedValue({ err: null });
  h.send.mockResolvedValue("sig");
});

const mount = async () => {
  const r = renderHook(() => useRecoverToStakers(MARKET.toBase58()));
  await waitFor(() => expect(h.getAccountInfo).toHaveBeenCalled());
  return r;
};

describe("recoverRefusalCopy", () => {
  it("maps 31 (nothing to recover, ok), 21 (positions), and anything else", () => {
    expect(recoverRefusalCopy(31)).toEqual({ line: RECOVER_COPY.nothing, ok: true });
    expect(recoverRefusalCopy(21)).toEqual({ line: RECOVER_COPY.waitingOnPositions, ok: false });
    expect(recoverRefusalCopy(7)).toEqual({ line: RECOVER_COPY.failed, ok: false });
    expect(recoverRefusalCopy(undefined)).toEqual({ line: RECOVER_COPY.failed, ok: false });
  });
});

describe("useRecoverToStakers view", () => {
  it("offers recover on a resolved pool with capacity", async () => {
    setup();
    const { result } = await mount();
    await waitFor(() => expect(result.current.view?.offer).toBe(true));
    expect(result.current.view?.amount).toBe(5_000n);
  });

  it("view is null when the flag is off, the slab is null, the pool is missing / foreign-owned, an LP pool, or a read throws", async () => {
    setup();
    __setDevnetV22ForTest(false);
    let r = renderHook(() => useRecoverToStakers(MARKET.toBase58()));
    await new Promise((x) => setTimeout(x, 20));
    expect(r.result.current.view).toBeNull();
    expect(h.getAccountInfo).not.toHaveBeenCalled();
    __setDevnetV22ForTest(true);
    r = renderHook(() => useRecoverToStakers(null));
    await new Promise((x) => setTimeout(x, 20));
    expect(r.result.current.view).toBeNull();

    h.getAccountInfo.mockResolvedValue(null);
    r = renderHook(() => useRecoverToStakers(MARKET.toBase58()));
    await waitFor(() => expect(h.getAccountInfo).toHaveBeenCalled());
    expect(r.result.current.view).toBeNull();

    h.getAccountInfo.mockResolvedValue({ owner: k(), data: Buffer.alloc(8), lamports: 1 });
    r = renderHook(() => useRecoverToStakers(MARKET.toBase58()));
    await new Promise((x) => setTimeout(x, 20));
    expect(r.result.current.view).toBeNull();

    setup({ poolMode: 1 });
    r = renderHook(() => useRecoverToStakers(MARKET.toBase58()));
    await new Promise((x) => setTimeout(x, 20));
    expect(r.result.current.view).toBeNull();

    h.getAccountInfo.mockRejectedValue(new Error("rpc down"));
    r = renderHook(() => useRecoverToStakers(MARKET.toBase58()));
    await new Promise((x) => setTimeout(x, 20));
    expect(r.result.current.view).toBeNull();
  });
});

describe("recover()", () => {
  it("wallet missing: sets the failed copy and sends nothing", async () => {
    setup({ wallet: false });
    const { result } = await mount();
    await act(async () => {
      await result.current.recover();
    });
    expect(result.current.error).toBe(RECOVER_COPY.failed);
    expect(h.sim).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("success: simulates the exact ixs, sends with 400k CU, invalidates the balance, sets done and clears the view", async () => {
    setup({ risk: 1 });
    const { result } = await mount();
    await waitFor(() => expect(result.current.view?.offer).toBe(true));
    await act(async () => {
      await result.current.recover();
    });
    expect(h.sim).toHaveBeenCalledTimes(1);
    const simIxs = h.sim.mock.calls[0][2] as { programId: PublicKey; data: Buffer }[];
    expect(simIxs).toHaveLength(2);
    expect(Buffer.from(simIxs[1].data).readBigUInt64LE(1)).toBe(5_000n);
    expect(h.send).toHaveBeenCalledTimes(1);
    const arg = h.send.mock.calls[0][0];
    expect(arg.computeUnits).toBe(400_000);
    expect(arg.instructions).toBe(simIxs);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(result.current.done).toBe(RECOVER_COPY.done);
    expect(result.current.error).toBeNull();
    expect(result.current.view).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("simulation error 21 (positions open): waiting copy as an error, nothing sent", async () => {
    setup();
    h.sim.mockResolvedValue({ err: { InstructionError: [0, { Custom: 21 }] } });
    const { result } = await mount();
    await act(async () => {
      await result.current.recover();
    });
    expect(result.current.error).toBe(RECOVER_COPY.waitingOnPositions);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("simulation error 31 (nothing to recover): shown as done, nothing sent", async () => {
    setup();
    h.sim.mockResolvedValue({ err: { InstructionError: [0, { Custom: 31 }] } });
    const { result } = await mount();
    await act(async () => {
      await result.current.recover();
    });
    expect(result.current.done).toBe(RECOVER_COPY.nothing);
    expect(result.current.error).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("simulation error with an unknown code: generic failure", async () => {
    setup();
    h.sim.mockResolvedValue({ err: "BlockhashNotFound" });
    const { result } = await mount();
    await act(async () => {
      await result.current.recover();
    });
    expect(result.current.error).toBe(RECOVER_COPY.failed);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("send error: generic failure, view kept, no balance invalidation, busy cleared", async () => {
    setup();
    h.send.mockRejectedValue(new Error("blockhash expired"));
    const { result } = await mount();
    await waitFor(() => expect(result.current.view?.offer).toBe(true));
    await act(async () => {
      await result.current.recover();
    });
    expect(result.current.error).toBe(RECOVER_COPY.failed);
    expect(result.current.done).toBeNull();
    expect(result.current.view).not.toBeNull();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("wallet rejection: 'Cancelled. Nothing was sent.'", async () => {
    setup();
    h.send.mockRejectedValue(new Error("User rejected the request"));
    const { result } = await mount();
    await act(async () => {
      await result.current.recover();
    });
    expect(result.current.error).toBe("Cancelled. Nothing was sent.");
  });

  it("pool unreadable at click time: generic failure, nothing simulated", async () => {
    setup();
    const { result } = await mount();
    h.getAccountInfo.mockResolvedValue(null);
    await act(async () => {
      await result.current.recover();
    });
    expect(result.current.error).toBe(RECOVER_COPY.failed);
    expect(h.sim).not.toHaveBeenCalled();
  });

  it("nothing to offer (capacity 0): returns without simulating or sending", async () => {
    setup({ cap: cap({ terminalCapacity: 0n }) });
    const { result } = await mount();
    await act(async () => {
      await result.current.recover();
    });
    expect(h.sim).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("open portfolios: waiting copy, nothing simulated", async () => {
    setup({ cap: cap({ materializedPortfolioCount: 2n }) });
    const { result } = await mount();
    await act(async () => {
      await result.current.recover();
    });
    expect(result.current.error).toBe(RECOVER_COPY.waitingOnPositions);
    expect(h.sim).not.toHaveBeenCalled();
  });
});
