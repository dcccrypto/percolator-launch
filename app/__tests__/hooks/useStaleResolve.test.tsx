// @vitest-environment jsdom
/**
 * useStaleResolve: the permissionless stale-market resolve button (tag 39) and the exit that follows.
 * Network, wallet and tx helpers are all mocked; this pins the decision logic only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  flag: true,
  raw: new Uint8Array([1, 2, 3]) as Uint8Array | null,
  slabState: {} as Record<string, unknown>,
  refresh: vi.fn(),
  connection: {
    getAccountInfo: vi.fn(),
    getSlot: vi.fn(),
  },
  wallet: { publicKey: null as PublicKey | null },
  clusterSlot: 1000n as bigint | null,
  status: vi.fn(),
  resolved: vi.fn(),
  simulateForGate: vi.fn(),
  sendTx: vi.fn(),
  getFreshBlockhash: vi.fn(),
  getPriorityFee: vi.fn(),
  buildBatchTx: vi.fn(),
  signAllCompat: vi.fn(),
  broadcastSignedTx: vi.fn(),
  loadOwnPortfolios: vi.fn(),
  traderExitItems: vi.fn(),
  runTraderExit: vi.fn(),
  selfHealSimulate: vi.fn(),
  waitLive: vi.fn(),
  isWait: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: h.connection }),
  useWalletCompat: () => h.wallet,
}));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => h.clusterSlot }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => h.slabState }));
vi.mock("@percolatorct/sdk", async (orig) => {
  // PDA derivation misbehaves under jsdom's Uint8Array realm; the derived address is not what is under test.
  const actual = await orig<typeof import("@percolatorct/sdk")>();
  const { Keypair: K } = await import("@solana/web3.js");
  const va = K.generate().publicKey;
  return { ...actual, deriveVaultAuthority: () => [va, 255] };
});
vi.mock("@solana/spl-token", async (orig) => {
  const actual = await orig<typeof import("@solana/spl-token")>();
  const { Keypair: K } = await import("@solana/web3.js");
  const ata = K.generate().publicKey;
  return { ...actual, getAssociatedTokenAddressSync: () => ata };
});
vi.mock("@/lib/v22/flag", () => ({ isDevnetV22Enabled: () => h.flag }));
vi.mock("@/lib/v22/market-lifecycle", () => ({
  formatStoppedAt: () => "12:00",
  stoppedAtMs: () => 0,
}));
vi.mock("@/lib/v22/stale-resolve", async (orig) => {
  const actual = await orig<typeof import("@/lib/v22/stale-resolve")>();
  return {
    ...actual,
    staleResolveStatusV22: (...a: unknown[]) => h.status(...a),
    marketResolvedV22: (...a: unknown[]) => h.resolved(...a),
    buildResolveStalePermissionlessIxV22: () => ({ tag: "ix39" }),
  };
});
vi.mock("@/lib/tx", () => ({
  simulateForGate: (...a: unknown[]) => h.simulateForGate(...a),
  sendTx: (...a: unknown[]) => h.sendTx(...a),
  getFreshBlockhash: (...a: unknown[]) => h.getFreshBlockhash(...a),
  getPriorityFee: (...a: unknown[]) => h.getPriorityFee(...a),
  buildBatchTx: (...a: unknown[]) => h.buildBatchTx(...a),
  signAllCompat: (...a: unknown[]) => h.signAllCompat(...a),
  broadcastSignedTx: (...a: unknown[]) => h.broadcastSignedTx(...a),
}));
vi.mock("@/lib/self-heal", async (orig) => {
  const actual = await orig<typeof import("@/lib/self-heal")>();
  return { ...actual, computeBudgetPrefix: () => [{ tag: "cu" }], connectionSelfHealDeps: () => ({ simulate: h.selfHealSimulate }) };
});
vi.mock("@/lib/limits/own-portfolio-cleanup", () => ({
  loadOwnPortfolios: (...a: unknown[]) => h.loadOwnPortfolios(...a),
  ownResolvedPayIxs: () => [{ tag: "create-ata" }, { tag: "pay" }],
  ownerClosePortfolioIx: () => ({ tag: "close8" }),
}));
vi.mock("@/lib/limits/trader-resolved-exit", () => ({
  TRADER_ITEM_CU: { "close-resolved": 380_000, "claim-topup": 380_000, "close-empty": 180_000 },
  traderExitItems: (...a: unknown[]) => h.traderExitItems(...a),
  runTraderExit: (...a: unknown[]) => h.runTraderExit(...a),
}));
vi.mock("@/lib/v22/resolved-close-wait", async (orig) => {
  const actual = await orig<typeof import("@/lib/v22/resolved-close-wait")>();
  return {
    ...actual,
    resolvedCloseWaitLive: (...a: unknown[]) => h.waitLive(...a),
    isResolvedCloseWait: (...a: unknown[]) => h.isWait(...a),
  };
});

import { useStaleResolve } from "@/hooks/useStaleResolve";
import { STALE_SETTLE_COPY } from "@/lib/v22/stale-resolve";
import { RESOLVED_CLOSE_WAIT_COPY } from "@/lib/v22/resolved-close-wait";

const SLAB = Keypair.generate().publicKey.toBase58();
const PROGRAM = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const PAYER = Keypair.generate().publicKey;

const status = (over: Record<string, unknown> = {}) => ({
  mode: 0,
  staleSlots: 100n,
  lastGoodOracleSlot: 800n,
  maturesAtSlot: 900n,
  slotsRemaining: 0n,
  evaluatedAtSlot: 1000n,
  ageSlots: 200n,
  canResolve: true,
  refusalCode: null,
  ...over,
});
const custom = (code: number, index = 0) => ({ InstructionError: [index, { Custom: code }] });
const own = (n = 1) =>
  Array.from({ length: n }, () => ({ key: Keypair.generate().publicKey, view: {}, portfolioId: 0n, matcherSequence: 0n, positionEpoch: 0n }));

function setup(hasFunds = false, slab: string | null = SLAB) {
  return renderHook(() => useStaleResolve(slab, hasFunds));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.flag = true;
  h.raw = new Uint8Array([1, 2, 3]);
  h.clusterSlot = 1000n;
  h.wallet.publicKey = PAYER;
  h.slabState = { raw: h.raw, programId: PROGRAM, config: { collateralMint: MINT }, refresh: h.refresh };
  h.connection.getAccountInfo.mockResolvedValue({ data: Buffer.from([9, 9, 9]) });
  h.connection.getSlot.mockResolvedValue(1000);
  h.status.mockReturnValue(status());
  h.resolved.mockReturnValue(false);
  h.simulateForGate.mockResolvedValue({ err: null });
  h.sendTx.mockResolvedValue("sig");
  h.getFreshBlockhash.mockResolvedValue("bh");
  h.getPriorityFee.mockResolvedValue(10);
  h.buildBatchTx.mockImplementation(() => ({ tx: true }));
  h.signAllCompat.mockImplementation(async (_w: unknown, txs: unknown[]) => txs);
  h.selfHealSimulate.mockResolvedValue({ err: null });
  h.waitLive.mockResolvedValue(false);
  h.isWait.mockReturnValue(false);
  h.runTraderExit.mockResolvedValue({ remaining: [] });
});

describe("view / resolved derivation", () => {
  it("stale matured Live market gives a stale view with minutes", () => {
    const { result } = setup();
    expect(result.current.view).toMatchObject({ kind: "stale", stoppedAtLabel: "12:00" });
    expect(result.current.view!.minutes).toBe(1); // 200 slots ~ 80s
    expect(result.current.resolved).toBe(false);
  });

  it("not stale yet (refusal 27): no view", () => {
    h.status.mockReturnValue(status({ canResolve: false, refusalCode: 27 }));
    expect(setup().result.current.view).toBeNull();
  });

  it("resolved market with funds: settled view; without funds: no view, but resolved stays true", () => {
    h.status.mockReturnValue(status({ canResolve: false, refusalCode: 21, mode: 1 }));
    h.resolved.mockReturnValue(true);
    const withFunds = setup(true).result.current;
    expect(withFunds.view).toMatchObject({ kind: "settled", minutes: 0, stoppedAtLabel: null });
    expect(withFunds.resolved).toBe(true);
    const noFunds = setup(false).result.current;
    expect(noFunds.view).toBeNull();
    expect(noFunds.resolved).toBe(true);
  });

  it("unparseable market (null status) gives no view even if resolved", () => {
    h.status.mockReturnValue(null);
    h.resolved.mockReturnValue(true);
    expect(setup(true).result.current.view).toBeNull();
  });

  it("v22 flag off: nothing is computed", () => {
    h.flag = false;
    h.resolved.mockReturnValue(true);
    const r = setup(true).result.current;
    expect(r.view).toBeNull();
    expect(r.resolved).toBe(false);
    expect(h.status).not.toHaveBeenCalled();
  });
});

describe("settle: guards", () => {
  it.each([
    ["no slab", () => setup(false, null)],
    ["no wallet", () => { h.wallet.publicKey = null; return setup(); }],
    ["no program", () => { h.slabState.programId = null; return setup(); }],
    ["no config", () => { h.slabState.config = null; return setup(); }],
  ])("%s: generic error, nothing read or sent", async (_n, mk) => {
    const { result } = mk();
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBe(STALE_SETTLE_COPY.generic);
    expect(h.connection.getSlot).not.toHaveBeenCalled();
    expect(h.sendTx).not.toHaveBeenCalled();
  });

  it("market account gone / unparseable: generic, nothing sent", async () => {
    h.connection.getAccountInfo.mockResolvedValue(null);
    h.status.mockReturnValue(null);
    const { result } = setup();
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBe(STALE_SETTLE_COPY.generic);
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a second click while one is in flight is ignored", async () => {
    let release!: () => void;
    h.sendTx.mockImplementation(() => new Promise<string>((r) => { release = () => r("sig"); }));
    const a = setup();
    const b = setup();
    let first!: Promise<void>;
    await act(async () => { first = a.result.current.settle(); });
    await vi.waitFor(() => expect(h.sendTx).toHaveBeenCalledTimes(1));
    expect(a.result.current.busy).toBe(true);
    await act(async () => { await b.result.current.settle(); });
    expect(h.sendTx).toHaveBeenCalledTimes(1);
    expect(b.result.current.busy).toBe(false);
    await act(async () => { release(); await first; });
    expect(a.result.current.busy).toBe(false);
  });
});

describe("settle: tag 39 decision", () => {
  it.each([
    [27, STALE_SETTLE_COPY.notYet],
    [19, STALE_SETTLE_COPY.behind],
    [21, null],
    [99, null],
  ])("fresh read refuses with %i: no simulate, no send", async (code, copy) => {
    h.status.mockReturnValue(status({ canResolve: false, refusalCode: code }));
    const { result } = setup(false);
    await act(async () => { await result.current.settle(); });
    expect(h.simulateForGate).not.toHaveBeenCalled();
    expect(h.sendTx).not.toHaveBeenCalled();
    if (code === 21) {
      // already resolved: carries on, no funds -> settledNoFunds
      expect(result.current.done).toBe(STALE_SETTLE_COPY.settledNoFunds);
      expect(result.current.error).toBeNull();
    } else {
      expect(result.current.error).toBe(copy ?? STALE_SETTLE_COPY.generic);
      expect(result.current.done).toBeNull();
    }
  });

  it("success, no funds: simulated then sent once, 'Settled.'", async () => {
    const { result } = setup(false);
    await act(async () => { await result.current.settle(); });
    expect(h.simulateForGate).toHaveBeenCalledTimes(1);
    expect(h.sendTx).toHaveBeenCalledTimes(1);
    expect(h.sendTx.mock.calls[0]![0]).toMatchObject({ computeUnits: 200_000, instructions: [{ tag: "ix39" }] });
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settledNoFunds);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(h.loadOwnPortfolios).not.toHaveBeenCalled();
  });

  it.each([
    [27, STALE_SETTLE_COPY.notYet],
    [19, STALE_SETTLE_COPY.behind],
    [77, STALE_SETTLE_COPY.generic],
  ])("simulation fails with custom %i: calm line, nothing sent", async (code, copy) => {
    h.simulateForGate.mockResolvedValue({ err: custom(code) });
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(result.current.error).toBe(copy);
  });

  it("simulation fails with a non-custom error: generic", async () => {
    h.simulateForGate.mockResolvedValue({ err: "BlockhashNotFound" });
    const { result } = setup();
    await act(async () => { await result.current.settle(); });
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(result.current.error).toBe(STALE_SETTLE_COPY.generic);
  });

  it("simulation says 21 (settled by someone else): skips send, goes on to the exit", async () => {
    h.simulateForGate.mockResolvedValue({ err: custom(21) });
    h.loadOwnPortfolios.mockResolvedValue([]);
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settled);
  });

  it("send error: generic, busy cleared, refresh called", async () => {
    h.sendTx.mockRejectedValue(new Error("rpc exploded"));
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBe(STALE_SETTLE_COPY.generic);
    expect(result.current.busy).toBe(false);
    expect(h.refresh).toHaveBeenCalled();
    expect(h.loadOwnPortfolios).not.toHaveBeenCalled();
  });

  it("wallet rejects tag 39: 'Cancelled. Nothing was sent.'", async () => {
    h.sendTx.mockRejectedValue(new Error("User rejected the request"));
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBe(STALE_SETTLE_COPY.cancelled);
  });

  it("clears an earlier error on the next click", async () => {
    h.sendTx.mockRejectedValueOnce(new Error("boom"));
    const { result } = setup(false);
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBe(STALE_SETTLE_COPY.generic);
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBeNull();
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settledNoFunds);
  });
});

describe("settle: exit after the market is settled", () => {
  const items = (p: PublicKey, kinds = ["close-resolved", "close-empty"]) =>
    kinds.map((kind, copy) => ({ kind, portfolio: p.toBase58(), copy }));

  it("wallet has no portfolios left: settled line", async () => {
    h.loadOwnPortfolios.mockResolvedValue([]);
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settled);
  });

  it("portfolios but nothing to send: payout-soon line", async () => {
    h.loadOwnPortfolios.mockResolvedValue(own());
    h.traderExitItems.mockReturnValue([]);
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settledPayoutSoon);
  });

  it("full success: simulates close-resolved, signs once, runs exit, settled line", async () => {
    const [p] = own();
    h.loadOwnPortfolios.mockResolvedValue([p]);
    h.traderExitItems.mockReturnValue(items(p!.key, ["close-resolved", "claim-topup", "close-empty"]));
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    // only close-resolved is simulated up front
    expect(h.selfHealSimulate).toHaveBeenCalledTimes(1);
    expect(h.signAllCompat).toHaveBeenCalledTimes(1);
    expect(h.buildBatchTx).toHaveBeenCalledTimes(3);
    expect(h.runTraderExit).toHaveBeenCalledTimes(1);
    expect(h.runTraderExit.mock.calls[0]![0]).toHaveLength(3);
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settled);
    expect(result.current.waiting).toBeNull();
  });

  it("runTraderExit deps: read maps portfolio views, broadcast forwards the signed tx", async () => {
    const [p] = own();
    h.loadOwnPortfolios.mockResolvedValue([p]);
    h.traderExitItems.mockReturnValue(items(p!.key));
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    const deps = h.runTraderExit.mock.calls[0]![1] as { read: () => Promise<Map<string, unknown>>; broadcast: (tx: unknown) => unknown };
    const m = await deps.read();
    expect(m.get(p!.key.toBase58())).toBe(p!.view);
    h.broadcastSignedTx.mockResolvedValue("sig2");
    await deps.broadcast({ tx: "x" });
    expect(h.broadcastSignedTx).toHaveBeenCalledWith(h.connection, { tx: "x" });
  });

  it("items remaining after the run: payout-soon line (not settled)", async () => {
    const [p] = own();
    h.loadOwnPortfolios.mockResolvedValue([p]);
    h.traderExitItems.mockReturnValue(items(p!.key));
    h.runTraderExit.mockResolvedValue({ remaining: [{ kind: "close-empty" }] });
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settledPayoutSoon);
  });

  it("every portfolio refused in simulation: nothing signed; payout-soon on a non-S1-6 build", async () => {
    const [p] = own();
    h.loadOwnPortfolios.mockResolvedValue([p]);
    h.traderExitItems.mockReturnValue(items(p!.key));
    h.selfHealSimulate.mockResolvedValue({ err: custom(21, 2) });
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(h.signAllCompat).not.toHaveBeenCalled();
    expect(h.waitLive).not.toHaveBeenCalled(); // isResolvedCloseWait false -> build never read
    expect(h.isWait).toHaveBeenCalledWith({ index: 2, code: 21 }, 2, true);
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settledPayoutSoon);
    expect(result.current.waiting).toBeNull();
  });

  it("refused with the S1-6 wait on a live build: `waiting` line, not done/error, nothing signed", async () => {
    const [p] = own();
    h.loadOwnPortfolios.mockResolvedValue([p]);
    h.traderExitItems.mockReturnValue(items(p!.key));
    h.selfHealSimulate.mockResolvedValue({ err: custom(21, 2) });
    h.isWait.mockReturnValue(true);
    h.waitLive.mockResolvedValue(true);
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(h.signAllCompat).not.toHaveBeenCalled();
    expect(result.current.waiting).toBe(RESOLVED_CLOSE_WAIT_COPY);
    expect(result.current.done).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("wait refusal but the build is not S1-6: payout-soon, not waiting", async () => {
    const [p] = own();
    h.loadOwnPortfolios.mockResolvedValue([p]);
    h.traderExitItems.mockReturnValue(items(p!.key));
    h.selfHealSimulate.mockResolvedValue({ err: custom(21, 2) });
    h.isWait.mockReturnValue(true);
    h.waitLive.mockResolvedValue(false);
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(result.current.waiting).toBeNull();
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settledPayoutSoon);
  });

  it("one portfolio refused, another still goes: only the good chain is signed", async () => {
    const [a, b] = own(2);
    h.loadOwnPortfolios.mockResolvedValue([a, b]);
    h.traderExitItems.mockReturnValue([...items(a!.key), ...items(b!.key)]);
    h.selfHealSimulate.mockResolvedValueOnce({ err: custom(21, 2) }).mockResolvedValueOnce({ err: null });
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(h.buildBatchTx).toHaveBeenCalledTimes(2);
    expect(h.runTraderExit.mock.calls[0]![0].every((x: { item: { portfolio: string } }) => x.item.portfolio === b!.key.toBase58())).toBe(true);
  });

  it("duplicate close-resolved items for one portfolio are simulated once", async () => {
    const [p] = own();
    h.loadOwnPortfolios.mockResolvedValue([p]);
    const k = p!.key.toBase58();
    h.traderExitItems.mockReturnValue([
      { kind: "close-resolved", portfolio: k, copy: 0 },
      { kind: "close-resolved", portfolio: k, copy: 1 },
    ]);
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(h.selfHealSimulate).toHaveBeenCalledTimes(1);
    expect(h.buildBatchTx).toHaveBeenCalledTimes(2);
  });

  it("an item for an unknown portfolio is an error: generic", async () => {
    const [p] = own();
    h.loadOwnPortfolios.mockResolvedValue([p]);
    h.traderExitItems.mockReturnValue([{ kind: "close-empty", portfolio: Keypair.generate().publicKey.toBase58(), copy: 0 }]);
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBe(STALE_SETTLE_COPY.generic);
  });

  it("wallet declines the exit after the market settled: declinedAfterSettle", async () => {
    const [p] = own();
    h.loadOwnPortfolios.mockResolvedValue([p]);
    h.traderExitItems.mockReturnValue(items(p!.key));
    h.signAllCompat.mockRejectedValue(new Error("User declined"));
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBe(STALE_SETTLE_COPY.declinedAfterSettle);
    expect(h.runTraderExit).not.toHaveBeenCalled();
  });

  it("already-resolved market (fresh refusal 21) with funds goes straight to the exit, no tag 39", async () => {
    h.status.mockReturnValue(status({ canResolve: false, refusalCode: 21, mode: 1 }));
    h.loadOwnPortfolios.mockResolvedValue([]);
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(h.simulateForGate).not.toHaveBeenCalled();
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(result.current.done).toBe(STALE_SETTLE_COPY.settled);
  });

  it("failure loading portfolios after settling and a decline-like text: declinedAfterSettle; other text: generic", async () => {
    h.loadOwnPortfolios.mockRejectedValueOnce(new Error("cancelled by user"));
    const { result } = setup(true);
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBe(STALE_SETTLE_COPY.declinedAfterSettle);
    h.loadOwnPortfolios.mockRejectedValueOnce(new Error("429"));
    await act(async () => { await result.current.settle(); });
    expect(result.current.error).toBe(STALE_SETTLE_COPY.generic);
  });
});

describe("unmount", () => {
  it("still refreshes after unmount", async () => {
    let release!: () => void;
    h.sendTx.mockImplementation(() => new Promise<string>((r) => { release = () => r("sig"); }));
    const { result, unmount } = setup();
    let p!: Promise<void>;
    await act(async () => { p = result.current.settle(); });
    await vi.waitFor(() => expect(h.sendTx).toHaveBeenCalled());
    unmount();
    release();
    await p;
    expect(h.refresh).toHaveBeenCalled();
  });
});
