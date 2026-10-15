// @vitest-environment node
/** v2.2 QA U-1 / R-1 / Q-7b: the refresh-crank planner (lib/v22/trade-refresh.ts), on the Q-7 devnet fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { buildRefreshCrankIxV22 } from "@/lib/v22/sdk";
import { isRefreshRace, refreshCandidatesFromAccounts, REFRESH_RACE_RETRIES, sendWithRefreshRetry } from "@/lib/v22/trade-refresh-wire";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { executeV22MultiAssetOrder, HealthCheckStaleError, MAX_PEER_CRANKS, MAX_TWO_TX_REPEATS, marketAssetSlots, needsMultiAssetShape, planV22TradeRefresh, type MultiAssetOrderDeps, type MultiAssetOrderInput, type MultiAssetSendKind, type RefreshSim, type TradeRefreshDeps, type TradeRefreshInput } from "@/lib/v22/trade-refresh";

interface Ser { programId: string; keys: string[]; data: string }
const FX = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-q7-devnet-2026-10-12.json"), "utf8")) as {
  market: string; portfolio: string; lp: string; owner: string;
  accounts: { market: string; taker: string; lp: string; flatPortfolio: string };
  cases: { label: string; scriptIxs: Ser[] }[];
};
const FEE = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-fee-channel-2026-10-11.json"), "utf8")) as { markets: Record<string, Record<string, string>> };
const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
const W = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const MKT = new PublicKey(FX.market), P = new PublicKey(FX.portfolio), LP = new PublicKey(FX.lp), OWNER = new PublicKey(FX.owner);
const unser = (s: Ser): TransactionInstruction => new TransactionInstruction({ programId: new PublicKey(s.programId), keys: s.keys.map((k) => { const [pk, f] = k.split(":"); return { pubkey: new PublicKey(pk), isSigner: f[0] === "s", isWritable: f[1] === "w" }; }), data: Buffer.from(s.data, "hex") });
const trade = unser(FX.cases[3].scriptIxs[FX.cases[3].scriptIxs.length - 1]);
const deposit = new TransactionInstruction({ programId: W, keys: [], data: Buffer.from([3]) });
const k = () => Keypair.generate().publicKey;
const PREFIX = 2;
const ok: RefreshSim = { err: null, logs: [] };
const at = (idx: number, code: number): RefreshSim => ({ err: { InstructionError: [PREFIX + idx, { Custom: code }] }, logs: [] });
const tagOf = (ix: TransactionInstruction) => ix.data[0];
const crankTarget = (ix: TransactionInstruction) => ix.keys[2].pubkey.toBase58();

function deps(sims: RefreshSim[], peers: PublicKey[] = []): TradeRefreshDeps & { simulate: ReturnType<typeof vi.fn>; readStalePeers: ReturnType<typeof vi.fn> } {
  const q = [...sims];
  return {
    simulate: vi.fn(async () => (q.length > 1 ? q.shift()! : q[0])),
    simPrefix: PREFIX,
    readStalePeers: vi.fn(async () => peers),
    refusal: (sim) => Object.assign(new Error("refused " + JSON.stringify(sim.err)), { name: "SimulationRefusal" }),
    sleep: async () => {},
  };
}
const multi = (over: Partial<TradeRefreshInput> = {}): TradeRefreshInput => ({
  programId: W, market: MKT, marketData: b64(FX.accounts.market), cranker: OWNER, takerPortfolio: P, takerData: b64(FX.accounts.taker), lpPortfolio: LP, lpData: b64(FX.accounts.lp), body: [trade], ...over,
});
const single = (over: Partial<TradeRefreshInput> = {}): TradeRefreshInput => multi({ marketData: b64(FEE.markets.JUP.marketB64), ...over });

describe("which shape", () => {
  it("5-asset market with 3 legs needs the multi-asset shape; a single-asset market or flat sides do not", () => {
    expect(marketAssetSlots(b64(FX.accounts.market))).toBe(5);
    expect(marketAssetSlots(b64(FEE.markets.JUP.marketB64))).toBe(1);
    expect(needsMultiAssetShape(multi())).toBe(true);
    expect(needsMultiAssetShape(multi({ takerData: b64(FX.accounts.flatPortfolio) }))).toBe(true); // the LP alone at 3 legs
    expect(needsMultiAssetShape(multi({ takerData: b64(FX.accounts.flatPortfolio), lpData: b64(FX.accounts.flatPortfolio) }))).toBe(false);
    expect(needsMultiAssetShape(single())).toBe(false);
  });
});

describe("U-1 / R-1: a 121 on a single-asset market gets the stale peers' refresh cranks in the same tx", () => {
  it("[crank peer x n, ...body] once the simulation is green; taker and LP are never cranked as peers; at most 6", async () => {
    const peers = Array.from({ length: 9 }, k);
    const d = deps([ok], [P, LP, ...peers]);
    const plan = await planV22TradeRefresh(single({ body: [deposit, trade] }), d, { withPeers: true });
    expect(plan.path).toBe("simple");
    expect(plan.cranks).toHaveLength(MAX_PEER_CRANKS);
    expect(plan.cranks.map((c) => c.portfolio.toBase58())).toEqual(peers.slice(0, 6).map((p) => p.toBase58()));
    expect(plan.instructions.slice(0, 6).map(crankTarget)).toEqual(peers.slice(0, 6).map((p) => p.toBase58()));
    expect(plan.instructions.slice(6)).toEqual([deposit, trade]);
    // The first crank OBSERVES asset 0 (it accrues the market; a refresh-only crank before any accrual is refused 22
    // and the 121 stays: measured on swordcat). The rest are refresh-only.
    expect(Buffer.from(plan.instructions[0].data).equals(Buffer.from(buildRefreshCrankIxV22(W, MKT, OWNER, peers[0], [0]).data))).toBe(true);
    expect(Buffer.from(plan.instructions[1].data).equals(Buffer.from(buildRefreshCrankIxV22(W, MKT, OWNER, peers[1], []).data))).toBe(true);
  });
  it("a peer that is already current (22) is dropped; with none left the order goes alone", async () => {
    const [a, b] = [k(), k()];
    const d = deps([at(0, 22), ok], [a, b]);
    const plan = await planV22TradeRefresh(single(), d, { withPeers: true });
    expect(plan.cranks.map((c) => c.portfolio.toBase58())).toEqual([b.toBase58()]);
    const d2 = deps([at(0, 22)], [a]);
    const p2 = await planV22TradeRefresh(single(), d2, { withPeers: true });
    expect(p2.cranks).toEqual([]);
    expect(p2.instructions).toEqual([trade]);
  });
  it("no stale peer: the body is returned unchanged and nothing is simulated", async () => {
    const d = deps([ok], []);
    const plan = await planV22TradeRefresh(single(), d, { withPeers: true });
    expect(plan.instructions).toEqual([trade]);
    expect(d.simulate).not.toHaveBeenCalled();
  });
  it("still 121 with the peers refreshed, or any other refusal: thrown as the caller's refusal", async () => {
    await expect(planV22TradeRefresh(single(), deps([at(1, 121)], [k()]), { withPeers: true })).rejects.toThrow(/refused .*121/);
    await expect(planV22TradeRefresh(single(), deps([at(1, 49)], [k()]), { withPeers: true })).rejects.toThrow(/refused .*49/);
  });
  it("without a 121 (withPeers off) a single-asset trade is never touched", async () => {
    const d = deps([ok], [k()]);
    const plan = await planV22TradeRefresh(single(), d);
    expect(plan.cranks).toEqual([]);
    expect(d.readStalePeers).not.toHaveBeenCalled();
  });
});

describe("single-asset behaviour is pinned; a multi-asset peer crank observes EVERY slot (no hard-coded [0])", () => {
  it("single-asset: the first peer crank observes [0], the rest are hint-less (unchanged)", async () => {
    const [a, b] = [k(), k()];
    const plan = await planV22TradeRefresh(single(), deps([ok], [a, b]), { withPeers: true });
    expect(plan.instructions.slice(0, 2).map((ix) => Buffer.from(ix.data).toString("hex"))).toEqual([
      Buffer.from(buildRefreshCrankIxV22(W, MKT, OWNER, a, [0]).data).toString("hex"),
      Buffer.from(buildRefreshCrankIxV22(W, MKT, OWNER, b, []).data).toString("hex"),
    ]);
  });
  it("multi-asset market: the first crank observes every asset slot [0..4]", async () => {
    const a = k();
    const plan = await planV22TradeRefresh(multi(), deps([ok], [a]), { withPeers: true });
    expect(Buffer.from(plan.instructions[0].data).equals(Buffer.from(buildRefreshCrankIxV22(W, MKT, OWNER, a, [0, 1, 2, 3, 4]).data))).toBe(true);
  });
});

describe("multi-asset order flow (fresh-taker fix): the body alone, cranks only after a 121 / 19", () => {
  const SLOTS = [0, 1, 2, 3, 4];
  const obsData = (p: PublicKey, o: number[]) => Buffer.from(buildRefreshCrankIxV22(W, MKT, OWNER, p, o).data).toString("hex");
  const isCrank = (ix: TransactionInstruction) => ix.data[0] === 5;
  const cranksOf = (ixs: readonly TransactionInstruction[]) => ixs.filter(isCrank);
  const tradeRefused = (ixs: readonly TransactionInstruction[], code = 121): RefreshSim => at(ixs.length - 1, code);
  const input = (over: Partial<MultiAssetOrderInput> = {}): MultiAssetOrderInput => ({
    programId: W, market: MKT, marketData: b64(FX.accounts.market), cranker: OWNER, takerPortfolio: P, takerData: b64(FX.accounts.taker), lpPortfolio: LP, body: [deposit, trade], ...over,
  });
  type Send = (ixs: TransactionInstruction[], kind: MultiAssetSendKind) => Promise<string>;
  function mk(simulate: (ixs: TransactionInstruction[]) => RefreshSim, peers: PublicKey[] = []) {
    const sent: { ixs: TransactionInstruction[]; kind: MultiAssetSendKind }[] = [];
    const sleeps: number[] = [];
    const d: MultiAssetOrderDeps = {
      simulate: vi.fn(async (ixs: TransactionInstruction[]) => simulate(ixs)),
      simPrefix: PREFIX,
      readStalePeers: vi.fn(async () => peers),
      refusal: (sim) => Object.assign(new Error("refused " + JSON.stringify(sim.err)), { name: "SimulationRefusal" }),
      sleep: async (ms) => { sleeps.push(ms); },
      send: vi.fn<Send>(async (ixs, kind) => { sent.push({ ixs, kind }); return `sig${sent.length}`; }),
      onTwoTx: vi.fn(),
    };
    return { d, sent, sleeps };
  }
  const bodyOnly = (ixs: readonly TransactionInstruction[]) => cranksOf(ixs).length === 0;

  it("fast path: the body simulates OK and goes ALONE; no peers read, no crank", async () => {
    const { d, sent } = mk(() => ok);
    const r = await executeV22MultiAssetOrder(input(), d);
    expect(r).toMatchObject({ signature: "sig1", path: "bodyAlone", cycles: 0 });
    expect(sent).toEqual([{ ixs: [deposit, trade], kind: "order" }]);
    expect(d.readStalePeers).not.toHaveBeenCalled();
    expect(d.onTwoTx).not.toHaveBeenCalled();
  });

  it("121 -> ONE tx [peers (first observes every slot), taker, LP last, body] when it simulates under 1.2M CU; no observing crank in the body", async () => {
    const [a, b] = [k(), k()];
    const { d, sent } = mk((ixs) => (bodyOnly(ixs) ? tradeRefused(ixs) : { ...ok, consumed: 900_000 }), [a, b, P, LP]);
    const r = await executeV22MultiAssetOrder(input(), d);
    expect(r.path).toBe("oneTx");
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("orderWithRefresh");
    const cr = cranksOf(sent[0].ixs);
    expect(cr.map((ix) => Buffer.from(ix.data).toString("hex"))).toEqual([obsData(a, SLOTS), obsData(b, []), obsData(P, []), obsData(LP, [])]);
    expect(cr.map(crankTarget)).toEqual([a, b, P, LP].map((x) => x.toBase58())); // taker and LP never as peers; LP LAST
    expect(sent[0].ixs.slice(4)).toEqual([deposit, trade]); // the body is exactly the order, nothing observing in it
  });

  it("19 is handled like 121; a taker below 3 legs is not cranked; with no other portfolio the LP crank itself observes every slot", async () => {
    const { d, sent } = mk((ixs) => (bodyOnly(ixs) ? tradeRefused(ixs, 19) : { ...ok, consumed: 500_000 }), []);
    await executeV22MultiAssetOrder(input({ takerPortfolio: k(), takerData: b64(FX.accounts.flatPortfolio) }), d);
    expect(cranksOf(sent[0].ixs).map((ix) => Buffer.from(ix.data).toString("hex"))).toEqual([obsData(LP, SLOTS)]);
  });

  it("a first trade (no taker portfolio yet) refreshes peers + LP only", async () => {
    const a = k();
    const { d, sent } = mk((ixs) => (bodyOnly(ixs) ? tradeRefused(ixs) : { ...ok, consumed: 800_000 }), [a]);
    await executeV22MultiAssetOrder(input({ takerPortfolio: null, takerData: null }), d);
    expect(cranksOf(sent[0].ixs).map(crankTarget)).toEqual([a, LP].map((x) => x.toBase58()));
  });

  it("over 1.2M CU (or out of compute) -> 2 txs: the cranks alone, THEN the body alone with no crank; onTwoTx says 2", async () => {
    const a = k();
    for (const heavy of [{ ...ok, consumed: 1_340_000 }, { err: { InstructionError: [PREFIX + 2, "ProgramFailedToComplete"] }, logs: [] } as RefreshSim]) {
      let refreshed = false;
      const { d, sent } = mk((ixs) => {
        if (bodyOnly(ixs)) return refreshed ? ok : tradeRefused(ixs);
        if (ixs.some((ix) => !isCrank(ix))) return heavy; // cranks + body together
        return { ...ok, consumed: 936_000 }; // cranks alone
      }, [a]);
      (d.send as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (ixs: TransactionInstruction[], kind: MultiAssetSendKind) => { sent.push({ ixs, kind }); if (kind === "refresh") refreshed = true; return `sig${sent.length}`; });
      const r = await executeV22MultiAssetOrder(input(), d);
      expect(r.path).toBe("twoTx");
      expect(sent.map((s) => s.kind)).toEqual(["refresh", "order"]);
      expect(cranksOf(sent[0].ixs).map((ix) => Buffer.from(ix.data).toString("hex"))).toEqual([obsData(a, SLOTS), obsData(P, []), obsData(LP, [])]);
      expect(sent[0].ixs).toHaveLength(3);
      expect(sent[1].ixs).toEqual([deposit, trade]); // tx 2: the order alone
      expect(d.onTwoTx).toHaveBeenCalledWith(2);
      expect(r.refreshSignatures).toEqual(["sig1"]);
    }
  });

  it("cranks that alone exceed the limit are split: the first of EACH tx observes every slot, the LP is last in the LAST", async () => {
    const peers = Array.from({ length: 6 }, k);
    let refreshed = false;
    const { d, sent } = mk((ixs) => {
      if (bodyOnly(ixs)) return refreshed ? ok : tradeRefused(ixs);
      if (ixs.some((ix) => !isCrank(ix))) return { ...ok, consumed: 1_650_000 };
      return cranksOf(ixs).length > 5 ? { err: { InstructionError: [PREFIX + 1, "ProgramFailedToComplete"] }, logs: [] } : { ...ok, consumed: 900_000 };
    }, peers);
    (d.send as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (ixs: TransactionInstruction[], kind: MultiAssetSendKind) => { sent.push({ ixs, kind }); if (sent.filter((x) => x.kind === "refresh").length === 2) refreshed = true; return `sig${sent.length}`; });
    await executeV22MultiAssetOrder(input(), d);
    expect(sent.map((s) => s.kind)).toEqual(["refresh", "refresh", "order"]);
    expect(d.onTwoTx).toHaveBeenCalledWith(3);
    const [t1, t2] = [sent[0], sent[1]].map((s) => cranksOf(s.ixs));
    expect(t1[0].data.equals(buildRefreshCrankIxV22(W, MKT, OWNER, peers[0], SLOTS).data)).toBe(true);
    expect(t2[0].data.length).toBe(t1[0].data.length); // observing, too
    expect(t1.map(crankTarget)).not.toContain(LP.toBase58());
    expect(crankTarget(t2[t2.length - 1])).toBe(LP.toBase58());
    expect(Buffer.from(t2[t2.length - 1].data).toString("hex")).toBe(obsData(LP, []));
    expect(t1.length + t2.length).toBe(8); // 6 peers + taker + LP, each once
  });

  it("a crank refused 22 is dropped; the FIRST (observing) crank refused 22 waits a slot and retries", async () => {
    const [a, b] = [k(), k()];
    let n = 0;
    const { d, sent, sleeps } = mk((ixs) => {
      if (bodyOnly(ixs)) return tradeRefused(ixs);
      n++;
      if (n === 1) return at(1, 22); // peer b already current
      if (n === 2) return at(0, 22); // the observing crank lost the slot
      return { ...ok, consumed: 700_000 };
    }, [a, b]);
    await executeV22MultiAssetOrder(input(), d);
    expect(sleeps).toContain(700);
    expect(cranksOf(sent[0].ixs).map(crankTarget)).toEqual([a, P, LP].map((x) => x.toBase58()));
    expect(Buffer.from(cranksOf(sent[0].ixs)[0].data).toString("hex")).toBe(obsData(a, SLOTS));
  });

  it("a refusal that is not 121 / 19 on the body is thrown as is; the same on the combined tx", async () => {
    await expect(executeV22MultiAssetOrder(input(), mk((ixs) => tradeRefused(ixs, 49)).d)).rejects.toThrow(/refused .*49/);
    const c = mk((ixs) => (bodyOnly(ixs) ? tradeRefused(ixs) : tradeRefused(ixs, 49)), [k()]);
    await expect(executeV22MultiAssetOrder(input(), c.d)).rejects.toThrow(/refused .*49/);
    expect(c.sent).toEqual([]);
  });

  it("retry bound: a body still 121 after the refresh repeats at most 2 more times, then HealthCheckStaleError (never an order sent)", async () => {
    const { d, sent } = mk((ixs) => (bodyOnly(ixs) ? tradeRefused(ixs) : { ...ok, consumed: 1_300_000 }), [k()]);
    await expect(executeV22MultiAssetOrder(input(), d)).rejects.toBeInstanceOf(HealthCheckStaleError);
    expect(sent.map((s) => s.kind)).toEqual(["refresh", "refresh", "refresh"]); // 1 + MAX_TWO_TX_REPEATS
    expect(MAX_TWO_TX_REPEATS).toBe(2);
  });

  it("a same-slot race (22) when the combined tx is sent goes back to the body alone from fresh state", async () => {
    let raced = false;
    const { d, sent } = mk((ixs) => (bodyOnly(ixs) ? (raced ? ok : tradeRefused(ixs)) : { ...ok, consumed: 800_000 }), []);
    (d.send as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (ixs: TransactionInstruction[], kind: MultiAssetSendKind) => {
      if (kind === "orderWithRefresh") { raced = true; throw new Error("custom program error: 0x16"); }
      sent.push({ ixs, kind });
      return "SIG";
    });
    const r = await executeV22MultiAssetOrder(input(), d);
    expect(r.signature).toBe("SIG");
    expect(sent).toEqual([{ ixs: [deposit, trade], kind: "order" }]);
  });
});

describe("refresh candidates and copy", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  afterEach(() => __setDevnetV22ForTest(null));
  it("every POSITIONED portfolio of the market is a candidate (stale flags are not the 121 rule); flat ones and other markets are not", () => {
    const [a, b, c] = [k(), k(), k()];
    const rows = [
      { pubkey: a, data: b64(FX.accounts.flatPortfolio) },
      { pubkey: b, data: b64(FX.accounts.taker) },
      { pubkey: c, data: b64(FX.accounts.lp) },
    ];
    const got = refreshCandidatesFromAccounts(rows, MKT).map((p) => p.toBase58());
    expect(got.sort()).toEqual([b.toBase58(), c.toBase58()].sort());
    expect(refreshCandidatesFromAccounts(rows, k())).toEqual([]);
    expect(refreshCandidatesFromAccounts([{ pubkey: a, data: new Uint8Array(40) }], MKT)).toEqual([]);
  });
  it("HealthCheckStaleError resolves to a clear 'Not sent' line, never 'goes through automatically'", () => {
    const m = resolveUserMessage(new HealthCheckStaleError(new Error("19")), { surface: "trade" });
    expect(m.kind).toBe("health-check-stale");
    expect(m.body).toBe("These positions needed more refreshing than fits in one go, so nothing was sent. Try again in a moment.");
    expect(m.body).not.toMatch(/automatically/);
    expect(m.autoRetry).toBeFalsy();
  });
});

describe("two-transaction copy", () => {
  it("says one approval may cover two transactions; promises nothing automatic", async () => {
    const { FIRST_TRADE_COPY } = await import("@/lib/first-trade");
    expect(FIRST_TRADE_COPY.twoTx).toMatch(/one approval may cover two transactions/);
    expect(FIRST_TRADE_COPY.twoTx).not.toMatch(/automatically/);
  });
});

describe("same-slot race at send time", () => {
  it("a 22 from the sent tx re-plans and sends again, at most twice more; anything else is thrown at once", async () => {
    const race = new Error("Transaction simulation failed: Error processing Instruction 3: custom program error: 0x16");
    expect(isRefreshRace(race)).toBe(true);
    expect(isRefreshRace(new Error('{"InstructionError":[3,{"Custom":22}]}'))).toBe(true);
    expect(isRefreshRace(new Error("custom program error: 0x31"))).toBe(false);
    const plan = vi.fn(async () => [trade]);
    const send = vi.fn().mockRejectedValueOnce(race).mockResolvedValueOnce("SIG");
    expect(await sendWithRefreshRetry(plan, send, async () => {})).toBe("SIG");
    expect(plan).toHaveBeenCalledTimes(2);
    const always = vi.fn().mockRejectedValue(race);
    await expect(sendWithRefreshRetry(plan, always, async () => {})).rejects.toBe(race);
    expect(always).toHaveBeenCalledTimes(1 + REFRESH_RACE_RETRIES);
    const other = vi.fn().mockRejectedValue(new Error("custom program error: 0x31"));
    await expect(sendWithRefreshRetry(plan, other, async () => {})).rejects.toThrow(/0x31/);
    expect(other).toHaveBeenCalledTimes(1);
  });
});
