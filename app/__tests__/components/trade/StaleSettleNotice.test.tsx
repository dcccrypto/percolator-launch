/**
 * The matured-stale market notice: one calm line + one button, the click is the only thing that sends, simulate first, refusals map
 * to copy, and the exit (CloseResolved) follows only when the wallet has funds. Real market bytes: CHILLHOUSE-T (see stale-resolve.test.ts).
 */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  raw: null as Uint8Array | null,
  slot: null as bigint | null,
  sendTx: vi.fn(async (_p: unknown) => "sig"),
  simulateForGate: vi.fn(async (..._a: unknown[]) => ({ consumed: 1, err: null as unknown, logs: [] as string[], rpcFailed: false, simulated: [] as unknown[] })),
  /** The wallet's own portfolios, as the chain reports them (a Map of key -> state is derived from it). */
  own: [] as { key: unknown; view: Record<string, unknown>; portfolioId: bigint; matcherSequence: bigint; positionEpoch: bigint }[],
  loadOwn: vi.fn(async (..._a: unknown[]) => h.own),
  signAll: vi.fn(async (_w: unknown, txs: unknown[]) => txs),
  broadcast: vi.fn(async (_c: unknown, _tx: unknown) => "sig"),
  simErr: null as unknown,
  refresh: vi.fn(),
  getAccountInfo: vi.fn(),
  getSlot: vi.fn(async () => 512_136_545),
  simCalls: 0,
}));

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const MINT = new PublicKey("ERe2nVetnKFH4Am7hh1cVWXd52s7uhWjorwFkU61kwan");
const WALLET = new PublicKey("HybAB3N6YCJea95BqEUU6FtwCUtrYWmmSsmN5vJGW5vf");
const SLAB = "56pWj8zYeZMv6oHHf4nwAfWAunzixxknaVNEFY48oJ2Y";

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({ raw: h.raw, programId: WRAPPER, config: { collateralMint: MINT }, refresh: h.refresh }),
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: { getAccountInfo: h.getAccountInfo, getSlot: h.getSlot } }),
  useWalletCompat: () => ({ publicKey: WALLET, connected: true }),
}));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => h.slot }));
// PDA derivation under jsdom's Uint8Array realm cannot find a nonce; the vault authority is not what this test is about.
vi.mock("@percolatorct/sdk", async (orig) => ({ ...(await orig<typeof import("@percolatorct/sdk")>()), deriveVaultAuthority: () => [MINT, 255] as [PublicKey, number] }));
vi.mock("@solana/spl-token", async (orig) => ({ ...(await orig<typeof import("@solana/spl-token")>()), getAssociatedTokenAddressSync: () => WALLET }));
vi.mock("@/lib/tx", () => ({
  sendTx: h.sendTx,
  simulateForGate: h.simulateForGate,
  signAllCompat: h.signAll,
  broadcastSignedTx: h.broadcast,
  getFreshBlockhash: async () => "bh",
  getPriorityFee: async () => 1000,
  buildBatchTx: (p: { instructions: unknown[]; priorityFeeMicroLamports: number }) => ({ ixs: p.instructions, fee: p.priorityFeeMicroLamports }),
}));
vi.mock("@/lib/limits/own-portfolio-cleanup", () => ({
  loadOwnPortfolios: h.loadOwn,
  ownResolvedPayIxs: (_c: unknown, _p: unknown, tag: number) => [{ ix: "create" }, { ix: `pay${tag}` }],
  ownerClosePortfolioIx: () => ({ ix: "close8" }),
}));
vi.mock("@/lib/self-heal", async (orig) => ({
  ...(await orig<typeof import("@/lib/self-heal")>()),
  computeBudgetPrefix: () => [],
  connectionSelfHealDeps: () => ({ simulate: async () => ((h.simCalls += 1), { err: h.simErr }) }),
}));

import { StaleSettleNotice, StaleSettleNoticeView } from "@/components/trade/StaleSettleNotice";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STALE_SETTLE_COPY, staleResolveStatusV22 } from "@/lib/v22/stale-resolve";
import { resolveMarketGeometry } from "@/lib/v22/sdk/layout";
import { RESOLVED_CLOSE_WAIT_COPY, __resetResolvedCloseWaitCache } from "@/lib/v22/resolved-close-wait";

const market = (): Uint8Array =>
  new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-growth/chillhouse-t.market.json"), "utf8")) as { data: string }).data, "base64"));
const SNAP = 512_136_545n;
const lastGood = staleResolveStatusV22(market(), SNAP)!.lastGoodOracleSlot;

beforeEach(() => {
  vi.clearAllMocks();
  __setDevnetV22ForTest(true);
  h.raw = market();
  h.slot = SNAP;
  h.getAccountInfo.mockResolvedValue({ data: Buffer.from(market()) });
  h.getSlot.mockResolvedValue(Number(SNAP));
  h.simulateForGate.mockResolvedValue({ consumed: 1, err: null, logs: [], rpcFailed: false, simulated: [] });
  h.simErr = null;
  h.own = [];
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

const click = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("stale-settle-button"));
  });
};

describe("StaleSettleNoticeView", () => {
  it("one line, one button; no button without a wallet; the done line replaces the button", () => {
    const { rerender } = render(<StaleSettleNoticeView minutes={120} hasFunds busy={false} error={null} done={null} canAct onSettle={() => undefined} />);
    expect(screen.getByTestId("stale-settle-line")).toHaveTextContent("This market has had no price for over 120 minutes and can be settled. Settle it to get your funds back.");
    expect(screen.getByTestId("stale-settle-button")).toHaveTextContent("Settle market");
    rerender(<StaleSettleNoticeView minutes={120} hasFunds={false} busy={false} error={null} done={null} canAct={false} onSettle={() => undefined} />);
    expect(screen.queryByTestId("stale-settle-button")).toBeNull();
    expect(screen.getByTestId("stale-settle-line")).toHaveTextContent("and can be settled.");
    expect(screen.getByTestId("stale-settle-line")).not.toHaveTextContent("funds back");
    rerender(<StaleSettleNoticeView minutes={120} hasFunds busy={false} error={null} done={STALE_SETTLE_COPY.settled} canAct onSettle={() => undefined} />);
    expect(screen.queryByTestId("stale-settle-button")).toBeNull();
    expect(screen.getByTestId("stale-settle-done")).toBeInTheDocument();
  });
});

const resolvedBytes = (): Uint8Array => {
  const m = market();
  const g = resolveMarketGeometry(m, { parser: "t", strictLength: false });
  m[g.groupOff + g.layout.group.mode] = 1;
  return m;
};
const LIVE = { owner: new Uint8Array(32), capital: 5_000_000n, pnl: 0n, reservedPnl: 0n, feeCredits: 0n, cancelDepositEscrow: 0n, activeBitmap: 1n, stale: false, bStale: false, rebalanceLock: false, liquidationLock: false, receiptPresent: false, receiptFinalized: false };
const EMPTY = { ...LIVE, capital: 0n, activeBitmap: 0n };
const PF = new PublicKey("7fU9teqRPQauqEykmQ9vszXvqu3GMcPXtCsM72LfEwoh");
/** A chain where each CloseResolved takes one chunk; ClosePortfolio deletes the account. */
function chain(chunks: number) {
  let left = chunks;
  h.own = [{ key: PF, view: LIVE, portfolioId: 1n, matcherSequence: 0n, positionEpoch: 0n }];
  h.broadcast.mockImplementation(async (_c: unknown, tx: unknown) => {
    const ixs = (tx as { ixs: { ix: string }[] }).ixs.map((x) => x.ix);
    if (ixs.includes("pay30")) {
      left -= 1;
      if (left <= 0 && h.own[0]) h.own = [{ ...h.own[0], view: EMPTY }];
    } else if (ixs.includes("close8")) h.own = [];
    return "sig";
  });
}
const sentKinds = () => h.broadcast.mock.calls.map((c) => ((c[1] as { ixs: { ix: string }[] }).ixs.map((x) => x.ix).find((x) => x !== "create") ?? ""));

describe("StaleSettleNotice (hook wired)", () => {
  it("shows nothing on an unmatured market, an unknown slot, a flag-off build, or non-market bytes", () => {
    h.slot = lastGood + 150n;
    const a = render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    h.slot = null;
    const b = render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(b.container).toBeEmptyDOMElement();
    b.unmount();
    h.slot = SNAP;
    __setDevnetV22ForTest(false);
    const c = render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(c.container).toBeEmptyDOMElement();
    c.unmount();
    __setDevnetV22ForTest(true);
    h.raw = new Uint8Array(200);
    const d = render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(d.container).toBeEmptyDOMElement();
  });

  it("matured: renders the line and NEVER sends on its own", async () => {
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(screen.getByTestId("stale-settle-line").textContent).toMatch(/^This market has had no price for over \d+ minutes and can be settled\. Settle it to get your funds back\.$/);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(h.simulateForGate).not.toHaveBeenCalled();
    expect(h.signAll).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("click: simulate first, then tag 39 (9 bytes, the market), then the trader exit in ONE signAll approval", async () => {
    chain(3);
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settled));
    expect(h.simulateForGate).toHaveBeenCalledTimes(1);
    expect(h.sendTx).toHaveBeenCalledTimes(1);
    const sent = h.sendTx.mock.calls[0]![0] as { instructions: { data: Buffer; keys: { pubkey: PublicKey }[]; programId: PublicKey }[] };
    expect(sent.instructions).toHaveLength(1);
    expect(sent.instructions[0]!.data[0]).toBe(39);
    expect(sent.instructions[0]!.data.length).toBe(9);
    expect(sent.instructions[0]!.programId.equals(WRAPPER)).toBe(true);
    expect(sent.instructions[0]!.keys[0]!.pubkey.toBase58()).toBe(SLAB);
    expect(h.simulateForGate.mock.invocationCallOrder[0]).toBeLessThan(h.sendTx.mock.invocationCallOrder[0]!);
    expect(h.sendTx.mock.invocationCallOrder[0]).toBeLessThan(h.signAll.mock.invocationCallOrder[0]!);
    expect(h.signAll).toHaveBeenCalledTimes(1); // one approval for the whole exit
    // exactly 3 CloseResolved + the ClosePortfolio were broadcast; the other pre-signed copies were skipped
    expect(sentKinds().filter((k) => k === "pay30")).toHaveLength(3);
    expect(sentKinds().filter((k) => k === "close8")).toHaveLength(1);
    expect(sentKinds().length).toBe(4);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("no position or capital: tag 39 only, no exit", async () => {
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds={false} canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settledNoFunds));
    expect(h.sendTx).toHaveBeenCalledTimes(1);
    expect(h.loadOwn).not.toHaveBeenCalled();
    expect(h.signAll).not.toHaveBeenCalled();
  });

  it.each([
    [27, STALE_SETTLE_COPY.notYet],
    [19, STALE_SETTLE_COPY.behind],
  ])("simulation refusal %i: that line, nothing sent", async (code, copy) => {
    h.simulateForGate.mockResolvedValue({ consumed: null, err: { InstructionError: [0, { Custom: code }] }, logs: [], rpcFailed: false, simulated: [] });
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-error")).toHaveTextContent(copy));
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(h.signAll).not.toHaveBeenCalled();
  });

  it("refusal 21 (someone settled it first): skips tag 39 and goes on to the exit", async () => {
    chain(1);
    h.simulateForGate.mockResolvedValue({ consumed: null, err: { InstructionError: [0, { Custom: 21 }] }, logs: [], rpcFailed: false, simulated: [] });
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toBeInTheDocument());
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(h.signAll).toHaveBeenCalledTimes(1);
  });

  it("the fresh read shows the market is no longer matured (a price landed): 27 copy, no simulation, nothing sent", async () => {
    h.getSlot.mockResolvedValue(Number(lastGood + 100n));
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-error")).toHaveTextContent(STALE_SETTLE_COPY.notYet));
    expect(h.simulateForGate).not.toHaveBeenCalled();
    expect(h.sendTx).not.toHaveBeenCalled();
  });

  it("settled but the portfolio is not empty after the run: calm 'ready shortly' line, no error", async () => {
    chain(30); // more chunks than the pre-signed copies can take
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settledPayoutSoon));
    expect(screen.queryByTestId("stale-settle-error")).toBeNull();
  });

  it("a wallet decline reads 'Cancelled', not a raw error", async () => {
    h.sendTx.mockRejectedValueOnce(new Error("User rejected the request"));
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-error")).toHaveTextContent(STALE_SETTLE_COPY.cancelled));
    expect(h.signAll).not.toHaveBeenCalled();
  });

  it("declining the SECOND approval after tag 39 landed says the market IS settled (not 'nothing was sent')", async () => {
    chain(2);
    h.signAll.mockRejectedValueOnce(new Error("User rejected the request"));
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-error")).toHaveTextContent(STALE_SETTLE_COPY.declinedAfterSettle));
    expect(screen.getByTestId("stale-settle-error")).not.toHaveTextContent("Nothing was sent");
    expect(h.sendTx).toHaveBeenCalledTimes(1); // tag 39 did land
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("two mounted notices for the same market (ticket + position row) share ONE in-flight lock: two clicks run one flow", async () => {
    let release: (v: string) => void = () => undefined;
    h.sendTx.mockImplementationOnce(() => new Promise<string>((r) => { release = r; }));
    render(
      <>
        <StaleSettleNotice slabAddress={SLAB} hasFunds={false} canAct />
        <StaleSettleNotice slabAddress={SLAB} hasFunds={false} canAct compact />
      </>,
    );
    const [first, second] = screen.getAllByTestId("stale-settle-button");
    await act(async () => {
      fireEvent.click(first!);
    });
    await waitFor(() => expect(h.sendTx).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(second!); // the other component's own busy flag is still false: only the module-level lock stops it
    });
    await act(async () => release("sig"));
    await waitFor(() => expect(screen.getAllByTestId("stale-settle-done").length).toBeGreaterThan(0));
    expect(h.sendTx).toHaveBeenCalledTimes(1);
    expect(h.simulateForGate).toHaveBeenCalledTimes(1);
  });

  it("a double click sends once", async () => {
    let release: (v: string) => void = () => undefined;
    h.sendTx.mockImplementationOnce(() => new Promise<string>((r) => { release = r; }));
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds={false} canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-button")).toBeDisabled());
    fireEvent.click(screen.getByTestId("stale-settle-button"));
    await act(async () => release("sig"));
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toBeInTheDocument());
    expect(h.sendTx).toHaveBeenCalledTimes(1);
  });
});

describe("RESOLVED market (AUD-FC-A2): the trader's own exit replaces the failing Close", () => {
  beforeEach(() => {
    h.raw = resolvedBytes();
    h.getAccountInfo.mockResolvedValue({ data: Buffer.from(resolvedBytes()) });
  });

  it("with a position: the settled line and 'Close and withdraw'; without funds there: nothing", () => {
    const a = render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    expect(screen.getByTestId("stale-settle-line")).toHaveTextContent(STALE_SETTLE_COPY.settledLine);
    expect(screen.getByTestId("stale-settle-button")).toHaveTextContent("Close and withdraw");
    a.unmount();
    const b = render(<StaleSettleNotice slabAddress={SLAB} hasFunds={false} canAct />);
    expect(b.container).toBeEmptyDOMElement();
  });

  it("click: NO tag 39 (the market is already resolved), CloseResolved copies pre-signed in one approval, 30 x chunks then 8", async () => {
    chain(5);
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settled));
    expect(h.sendTx).not.toHaveBeenCalled();
    expect(h.simulateForGate).not.toHaveBeenCalled();
    expect(h.signAll).toHaveBeenCalledTimes(1);
    const txs = h.signAll.mock.calls[0]![1] as { fee: number }[];
    expect(new Set(txs.map((t) => t.fee)).size).toBe(txs.length); // distinct fees = distinct signatures
    expect(sentKinds().filter((k) => k === "pay30")).toHaveLength(5);
    expect(sentKinds().filter((k) => k === "close8")).toHaveLength(1);
  });

  it("a first CloseResolved the simulation refuses is dropped BEFORE the wallet opens", async () => {
    chain(3);
    h.simErr = { InstructionError: [2, { Custom: 14 }] };
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settledPayoutSoon));
    expect(h.signAll).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("the wallet has nothing left on the market: 'Settled', nothing signed", async () => {
    h.own = [];
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settled));
    expect(h.signAll).not.toHaveBeenCalled();
  });
});

// ── SEC-RC I-S1 (S1-6 a/c, engine e59aa6a6): a winner's CloseResolved refused with 21 while the losing side has not
// settled is a WAIT. Gated on the deployed wrapper's ELF (lib/v22/resolved-close-wait.ts); fixtures = the first 4096 ELF
// bytes of the canonical builds (RC-S16AC.md §2: rc-s16ac ddd5a2fa; RC.md: rc 357fc23f = the negative control).
const s16acElf = (n: string): Buffer =>
  Buffer.from(readFileSync(path.join(__dirname, "../../fixtures/v22-s16ac", `wrapper-elf4096-${n}.b64`), "utf8").trim(), "base64");
const PROGRAMDATA = new PublicKey("C6yjMetoTgaiUQLPYYJcYwyy7atrBFd7eNkpWbf89obG");
/** The fresh market read returns the Resolved market; the wrapper -> ProgramData -> `elf`. */
function deployed(elf: Buffer) {
  h.getAccountInfo.mockImplementation(async (k: PublicKey) => {
    if (k.equals(WRAPPER)) {
      const d = Buffer.alloc(36);
      PROGRAMDATA.toBuffer().copy(d, 4);
      return { data: d };
    }
    if (k.equals(PROGRAMDATA)) return { data: elf };
    return { data: Buffer.from(resolvedBytes()) };
  });
}

describe("RESOLVED market, S1-6 a/c wait (SEC-RC I-S1)", () => {
  beforeEach(() => {
    __resetResolvedCloseWaitCache();
    h.raw = resolvedBytes();
    h.simCalls = 0;
    chain(3);
  });

  it("S1-6 a/c deployed: a CloseResolved refused with 21 shows the calm WAITING line, not an error; nothing is signed; the button stays", async () => {
    deployed(s16acElf("rc-s16ac-ddd5a2fa"));
    h.simErr = { InstructionError: [1, { Custom: 21 }] }; // raised by the CloseResolved ([create ATA, 30])
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-waiting")).toHaveTextContent(RESOLVED_CLOSE_WAIT_COPY));
    expect(screen.queryByTestId("stale-settle-error")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("stale-settle-done")).toBeNull();
    expect(h.signAll).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(screen.getByTestId("stale-settle-button")).toHaveTextContent("Close and withdraw");
  });

  it("no auto-retry: after the waiting line nothing simulates on its own; a later click tries once and goes through when the other side has settled", async () => {
    deployed(s16acElf("rc-s16ac-ddd5a2fa"));
    h.simErr = { InstructionError: [1, { Custom: 21 }] };
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-waiting")).toBeInTheDocument());
    const afterFirst = h.simCalls;
    expect(afterFirst).toBe(1);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(h.simCalls).toBe(afterFirst);
    // The loss side settled: the same click now closes and withdraws; the waiting line is gone.
    h.simErr = null;
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settled));
    expect(screen.queryByTestId("stale-settle-waiting")).toBeNull();
    expect(h.signAll).toHaveBeenCalledTimes(1);
  });

  it("the same-engine rollback (bae71e12) also shows the waiting line", async () => {
    deployed(s16acElf("rollback-s16ac-bae71e12"));
    h.simErr = { InstructionError: [1, { Custom: 21 }] };
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-waiting")).toHaveTextContent(RESOLVED_CLOSE_WAIT_COPY));
  });

  it("RC2 S1-6 a/c (4fe8fd53, the shipping variant) shows the waiting line", async () => {
    deployed(s16acElf("rc2-s16ac-4fe8fd53"));
    h.simErr = { InstructionError: [1, { Custom: 21 }] };
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-waiting")).toHaveTextContent(RESOLVED_CLOSE_WAIT_COPY));
  });

  it("NEGATIVE CONTROL: on plain RC2 (cc720a0e, no S1-6 a/c) the same 21 keeps today's line", async () => {
    deployed(s16acElf("rc2-cc720a0e"));
    h.simErr = { InstructionError: [1, { Custom: 21 }] };
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settledPayoutSoon));
    expect(screen.queryByTestId("stale-settle-waiting")).toBeNull();
  });

  it("NEGATIVE CONTROL: on the RC (357fc23f, no S1-6 a/c) the same 21 keeps today's 'payout ready shortly' line", async () => {
    deployed(s16acElf("rc-357fc23f"));
    h.simErr = { InstructionError: [1, { Custom: 21 }] };
    render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
    await click();
    await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settledPayoutSoon));
    expect(screen.queryByTestId("stale-settle-waiting")).toBeNull();
  });

  it("NEGATIVE CONTROL: a 21 from the ATA create (index 0) or another code (14) is not the wait, and the program is not even read", async () => {
    deployed(s16acElf("rc-s16ac-ddd5a2fa"));
    for (const err of [{ InstructionError: [0, { Custom: 21 }] }, { InstructionError: [1, { Custom: 14 }] }]) {
      cleanup();
      h.getAccountInfo.mockClear();
      h.simErr = err;
      render(<StaleSettleNotice slabAddress={SLAB} hasFunds canAct />);
      await click();
      await waitFor(() => expect(screen.getByTestId("stale-settle-done")).toHaveTextContent(STALE_SETTLE_COPY.settledPayoutSoon));
      expect(screen.queryByTestId("stale-settle-waiting")).toBeNull();
      expect(h.getAccountInfo.mock.calls.some(([k]) => (k as PublicKey).equals(WRAPPER))).toBe(false);
    }
  });

  it("view: the waiting line is neutral (no role=alert), the button stays; a done line wins over it", () => {
    const { rerender } = render(
      <StaleSettleNoticeView minutes={0} kind="settled" hasFunds busy={false} error={null} done={null} waiting={RESOLVED_CLOSE_WAIT_COPY} canAct onSettle={() => undefined} />,
    );
    expect(screen.getByTestId("stale-settle-waiting")).toHaveTextContent(RESOLVED_CLOSE_WAIT_COPY);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("stale-settle-button")).toBeInTheDocument();
    rerender(<StaleSettleNoticeView minutes={0} kind="settled" hasFunds busy={false} error={null} done={STALE_SETTLE_COPY.settled} waiting={RESOLVED_CLOSE_WAIT_COPY} canAct onSettle={() => undefined} />);
    expect(screen.queryByTestId("stale-settle-waiting")).toBeNull();
  });
});
