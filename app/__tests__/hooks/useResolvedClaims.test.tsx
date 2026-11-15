// @vitest-environment jsdom
/**
 * useResolvedClaims: what the connected wallet can still claim on a RESOLVED market (the trade page's ResolvedClaimPanel reads it).
 * Every chain read is mocked at its seam; the planning (lib/v22/resolved-claims) is real, so the rows are what the panel would show.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

const m = vi.hoisted(() => ({
  wallet: { publicKey: null as unknown },
  slab: { raw: null as unknown, programId: null as string | null },
  nowSlot: null as bigint | null,
  flag: true,
  market: null as unknown,
  loadOwnPortfolios: vi.fn(),
  readEarnPositions: vi.fn(),
  decodeCap: vi.fn(),
  config: {} as Record<string, unknown>,
  poll: { tick: null as null | (() => void), stop: vi.fn() },
  getAccountInfo: vi.fn(),
  unpack: vi.fn(),
  lpMint: null as unknown,
  conn: null as unknown,
  derived: [] as string[][],
  pool: null as unknown,
  ata: null as unknown,
  ataArgs: [] as unknown[],
}));
m.conn = { connection: { getAccountInfo: (...a: unknown[]) => m.getAccountInfo(...a) } };

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => m.wallet,
  useConnectionCompat: () => m.conn,
}));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => m.nowSlot }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => m.slab }));
vi.mock("@/lib/limits/decode", () => ({ decodeResolvedMarket: () => m.market }));
vi.mock("@/lib/limits/own-portfolio-cleanup", () => ({ loadOwnPortfolios: (...a: unknown[]) => m.loadOwnPortfolios(...a) }));
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: (...a: unknown[]) => m.readEarnPositions(...a) }));
vi.mock("@/lib/v22/records", () => ({ decodeTerminalInsuranceCapacity: (...a: unknown[]) => m.decodeCap(...a) }));
// deriveStakePool seeds with TextEncoder, which fails under jsdom's realm-separated Uint8Array (see __tests__/setup.ts); the derivation is the SDK's.
vi.mock("@percolatorct/sdk", () => ({ deriveStakePool: (slab: PublicKey, program: PublicKey) => { m.derived.push([slab.toBase58(), program.toBase58()]); return [m.pool, 255]; } }));
vi.mock("@/hooks/useStakePool", () => ({ STAKE_POOL_SIZE_V1: 352, decodeStakePoolV1: () => ({ lpMint: m.lpMint }) }));
vi.mock("@/lib/config", () => ({ getConfig: () => m.config }));
vi.mock("@/lib/v22/flag", () => ({ isDevnetV22Enabled: () => m.flag }));
vi.mock("@/lib/pollWhenVisible", () => ({
  pollWhenVisible: (tick: () => void) => {
    m.poll.tick = tick;
    return m.poll.stop;
  },
}));
vi.mock("@solana/spl-token", async (orig) => ({ ...(await orig<typeof import("@solana/spl-token")>()), getAssociatedTokenAddressSync: (...a: unknown[]) => {
    m.ataArgs = a;
    return m.ata;
  }, unpackAccount: (...a: unknown[]) => m.unpack(...a) }));

import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { useResolvedClaims } from "@/hooks/useResolvedClaims";

const SLAB = Keypair.generate().publicKey.toBase58();
const WRAPPER = Keypair.generate().publicKey.toBase58();
const OWNER = Keypair.generate().publicKey;
const STAKE_PROGRAM = Keypair.generate().publicKey;
const resolvedMarket = { mode: 1, resolvedSlot: 1_000n, forceCloseDelaySlots: 216_000n, cTot: 0n, materializedPortfolioCount: 0n };
const cap = { resolved: true, terminalCapacity: 5n, materializedPortfolioCount: 0n };
const poolInfo = { owner: STAKE_PROGRAM, data: new Uint8Array(352) };

beforeEach(() => {
  vi.clearAllMocks();
  m.wallet = { publicKey: OWNER };
  m.slab = { raw: new Uint8Array(8), programId: WRAPPER };
  m.nowSlot = null;
  m.flag = true;
  m.market = resolvedMarket;
  m.config = { vaultProgramId: STAKE_PROGRAM.toBase58() };
  m.poll.tick = null;
  m.lpMint = Keypair.generate().publicKey;
  m.pool = Keypair.generate().publicKey;
  m.ata = Keypair.generate().publicKey;
  m.derived = [];
  m.loadOwnPortfolios.mockResolvedValue([{}, {}]);
  m.readEarnPositions.mockResolvedValue(new Map([[SLAB, { shares: 9n }]]));
  m.decodeCap.mockReturnValue(cap);
  // Address-aware: the pool account and the wallet's LP token account answer; any other address reads nothing.
  m.getAccountInfo.mockImplementation(async (k: PublicKey) => (k === m.pool ? poolInfo : k === m.ata ? { data: new Uint8Array(165) } : null));
  m.unpack.mockReturnValue({ amount: 7n });
});

const kinds = (rows: { kind: string; status: string; actions: string[] }[]) => rows.map((r) => `${r.kind}:${r.status}:${r.actions.join("+")}`);

describe("useResolvedClaims", () => {
  it("a market that is not Resolved shows nothing and reads nothing", async () => {
    m.market = { ...resolvedMarket, mode: 0 };
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ resolved: false, rows: [], window: null, hasClaims: false, readFailed: false });
    expect(m.loadOwnPortfolios).not.toHaveBeenCalled();
    expect(m.readEarnPositions).not.toHaveBeenCalled();
  });

  it("no slab data yet: not resolved", async () => {
    m.slab = { raw: null, programId: null };
    m.market = null;
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.resolved).toBe(false);
  });

  it("the v2.2 flag off: never resolved, even for a Resolved market", async () => {
    m.flag = false;
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.resolved).toBe(false);
    expect(m.loadOwnPortfolios).not.toHaveBeenCalled();
  });

  it("no wallet: stops loading, reads nothing, claims nothing", async () => {
    m.wallet = { publicKey: null };
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.resolved).toBe(true);
    expect(result.current.hasClaims).toBe(false);
    expect(kinds(result.current.rows)).toEqual(["positions:none:", "earn:none:", "stake:none:"]);
    expect(m.loadOwnPortfolios).not.toHaveBeenCalled();
  });

  it("a connected wallet: positions, Earn and stake rows from chain, in payback order", async () => {
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(m.loadOwnPortfolios.mock.calls[0][3]).toBe(OWNER);
    expect((m.loadOwnPortfolios.mock.calls[0][1] as PublicKey).toBase58()).toBe(WRAPPER);
    expect((m.loadOwnPortfolios.mock.calls[0][2] as PublicKey).toBase58()).toBe(SLAB);
    expect((m.readEarnPositions.mock.calls[0][1] as PublicKey).toBase58()).toBe(WRAPPER);
    expect(m.readEarnPositions.mock.calls[0][2]).toBe(OWNER);
    expect(m.readEarnPositions.mock.calls[0][3]).toEqual([SLAB]);
    // stake: the pool is derived from (market, stake program); the LP ATA from (lpMint, owner); the ATA account is what gets unpacked.
    expect(m.derived[0]).toEqual([SLAB, STAKE_PROGRAM.toBase58()]);
    expect(m.ataArgs).toEqual([m.lpMint, OWNER]);
    expect(m.getAccountInfo.mock.calls.map((c) => c[0])).toEqual([m.pool, m.ata]);
    expect(m.unpack.mock.calls[0][0]).toBe(m.ata);
    expect(m.decodeCap.mock.calls[0]).toEqual([m.slab.raw, 0]);
    expect(result.current.readFailed).toBe(false);
    expect(result.current.hasClaims).toBe(true);
    // 2 portfolios open, the market is terminal-flat so Earn is ready; stake has 7 LP and the market's insurance is still to recover.
    expect(kinds(result.current.rows)).toEqual(["positions:ready:close-and-withdraw", "earn:ready:open-earn", "stake:ready:recover-to-stakers+withdraw-stake"]);
  });

  it("Earn row is 'waiting' while the market still has user capital", async () => {
    m.market = { ...resolvedMarket, cTot: 3n, materializedPortfolioCount: 1n };
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows.find((r) => r.kind === "earn")).toMatchObject({ status: "waiting", waitingOn: "positions" });
  });

  it("an Earn read with no entry for this slab is 0 shares", async () => {
    m.readEarnPositions.mockResolvedValue(new Map());
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows.find((r) => r.kind === "earn")?.status).toBe("none");
  });

  it("stake: no pool account, a pool owned by another program, or a short pool means 0 LP (one read, no ATA read)", async () => {
    for (const info of [null, { owner: Keypair.generate().publicKey, data: new Uint8Array(352) }, { owner: STAKE_PROGRAM, data: new Uint8Array(10) }]) {
      m.getAccountInfo.mockReset();
      m.getAccountInfo.mockResolvedValue(info);
      const { result, unmount } = renderHook(() => useResolvedClaims(SLAB));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.rows.find((r) => r.kind === "stake")?.status).toBe("none");
      expect(m.getAccountInfo).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("stake: a pool but no LP token account is 0 LP", async () => {
    m.getAccountInfo.mockResolvedValueOnce(poolInfo).mockResolvedValueOnce(null);
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(m.unpack).not.toHaveBeenCalled();
    expect(result.current.rows.find((r) => r.kind === "stake")?.status).toBe("none");
  });

  it("stake: falls back to the devnet stake program when the config names none", async () => {
    m.config = {};
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The pool is owned by STAKE_PROGRAM, not the default stake program: the owner check fails closed to 0 LP.
    expect(result.current.rows.find((r) => r.kind === "stake")?.status).toBe("none");
    expect(m.derived[0]).toEqual([SLAB, DEVNET_PROGRAM_IDS.stake]);
  });

  it("a terminal-capacity decode that throws does not offer recovery, and the withdraw action stays", async () => {
    m.decodeCap.mockImplementation(() => {
      throw new Error("bad layout");
    });
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows.find((r) => r.kind === "stake")?.actions).toEqual(["withdraw-stake"]);
    expect(result.current.readFailed).toBe(false);
  });

  it("a failed read says so, keeps the parts that did read, and Try again re-reads and clears it", async () => {
    m.loadOwnPortfolios.mockRejectedValueOnce(new Error("rpc 429"));
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readFailed).toBe(true);
    // positions unread (null) never invents "nothing left"; Earn and stake still came through.
    expect(kinds(result.current.rows)).toEqual(["positions:none:", "earn:ready:open-earn", "stake:ready:recover-to-stakers+withdraw-stake"]);

    act(() => result.current.retry());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readFailed).toBe(false);
    expect(m.loadOwnPortfolios).toHaveBeenCalledTimes(2);
    expect(result.current.rows[0].status).toBe("ready");
  });

  it("a rejected Earn read and a rejected stake read each flag readFailed and leave their part unread", async () => {
    m.readEarnPositions.mockRejectedValueOnce(new Error("boom"));
    m.getAccountInfo.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.readFailed).toBe(true);
    expect(kinds(result.current.rows)).toEqual(["positions:ready:close-and-withdraw", "earn:none:", "stake:none:"]);
  });

  it("polls: the visibility poll re-reads, and unmount stops it", async () => {
    const { result, unmount } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(m.poll.tick).toBeTypeOf("function");
    await act(async () => {
      m.poll.tick?.();
    });
    await waitFor(() => expect(m.loadOwnPortfolios).toHaveBeenCalledTimes(2));
    unmount();
    expect(m.poll.stop).toHaveBeenCalled();
  });

  it("the owner-only window: ends at resolved_slot + delay, estimated from the cluster slot", async () => {
    m.nowSlot = 1_000n + 100_000n;
    const { result } = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.window).toMatchObject({ configured: true, ownerOnly: true, endsAtSlot: 217_000n });
    expect(result.current.window?.endsAtMs).toBeGreaterThan(Date.now());
  });

  it("the owner-only window is over once the cluster slot passes it, and unconfigured when the delay is 0", async () => {
    m.nowSlot = 500_000n;
    const over = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(over.result.current.loading).toBe(false));
    expect(over.result.current.window).toMatchObject({ configured: true, ownerOnly: false, endsAtMs: null });
    over.unmount();

    m.market = { ...resolvedMarket, forceCloseDelaySlots: 0n };
    const none = renderHook(() => useResolvedClaims(SLAB));
    await waitFor(() => expect(none.result.current.loading).toBe(false));
    expect(none.result.current.window).toMatchObject({ configured: false, ownerOnly: false, endsAtSlot: null });
  });
});
