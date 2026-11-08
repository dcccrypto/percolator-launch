// @vitest-environment node
/**
 * Council 2026-11-07 r1 M5: one open showed TWO wallet prompts (a 5-ix tx that never landed, then a 6-ix tx).
 * Question: is that a duplicate PROMPT (UX) or can the order EXECUTE twice?
 *
 * Model of the network: a fake RPC node that simulates each submitted tx against a "market is loss-stale" flag
 * (preflight). It FORWARDS only txs whose preflight passes (or skipPreflight); forwarded txs are "on the wire" and
 * would land later if still valid. tx2 carries the peer-refresh crank, which clears the stale flag once it lands.
 * The danger case for a double open is: tx1 (trade only) is forwarded, then tx2's crank refreshes the market, and
 * tx1 lands too. So the property under test is: tx1 is never FORWARDED when a re-sign happens.
 *
 * Real code: lib/tx.ts sendTx (devnet path: wallet signs, the app submits with preflight on), lib/v21/loss-stale-retry
 * isLossStaleError, lib/v22/trade-refresh-wire sendWithRefreshRetry. The catch → re-plan → re-send composition mirrors
 * hooks/useTrade.ts sendOrderOnce (the `isLossStaleError(e, programId)` branch); the hook itself is not mounted here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SendTransactionError, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

const netState = vi.hoisted(() => ({ network: "devnet" as "mainnet" | "devnet" }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => netState.network,
}));

import { sendTx, CONFIRMATION_POLL } from "@/lib/tx";
import { isLossStaleError } from "@/lib/v21/loss-stale-retry";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { sendWithRefreshRetry } from "@/lib/v22/trade-refresh-wire";

const WRAPPER = new PublicKey(new Uint8Array(32).fill(5));
const CRANK_TAG = 0xc7; // marks the peer-refresh crank in the fake ix data
const tradeIx = new TransactionInstruction({ programId: WRAPPER, keys: [], data: Buffer.from([0x01]) });
const crankIx = new TransactionInstruction({ programId: WRAPPER, keys: [], data: Buffer.from([CRANK_TAG]) });

type Mode = "preflight-121" | "ambiguous-drop" | "landed-failed-121";

function world(mode: Mode) {
  const st = { stale: true, forwarded: [] as { sig: string; hasCrank: boolean }[], landedOk: [] as string[] };
  const decode = (wire: Uint8Array) => Transaction.from(Buffer.from(wire));
  const sendRawTransaction = vi.fn(async (wire: Uint8Array, opts?: { skipPreflight?: boolean }) => {
    const tx = decode(wire);
    const sig = bs58.encode(tx.signature!);
    const hasCrank = tx.instructions.some((ix) => ix.data[0] === CRANK_TAG);
    const wouldFail = st.stale && !hasCrank;
    if (mode === "ambiguous-drop" && !hasCrank) {
      st.forwarded.push({ sig, hasCrank }); // forwarded, then the response was lost
      throw new TypeError("Failed to fetch");
    }
    if (mode === "preflight-121" && wouldFail && !opts?.skipPreflight) {
      // The node's own preflight refusal: NOT forwarded.
      throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x79", logs: [`Program ${WRAPPER.toBase58()} failed: custom program error: 0x79`] });
    }
    st.forwarded.push({ sig, hasCrank });
    if (!wouldFail) { st.landedOk.push(sig); if (hasCrank) st.stale = false; }
    return sig;
  });
  const statusOf = (sig: string) => {
    if (st.landedOk.includes(sig)) return { confirmationStatus: "confirmed", err: null, slot: 1 };
    if (st.forwarded.some((f) => f.sig === sig)) {
      if (mode === "landed-failed-121") return { confirmationStatus: "confirmed", err: { InstructionError: [1, { Custom: 121 }] }, slot: 1 };
      return null; // ambiguous: not seen yet
    }
    return null;
  };
  const conn = {
    rpcEndpoint: "https://percolator-v22-preview.vercel.app/api/rpc",
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(1_000_000_000),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10_000_000 }),
    getBlockHeight: vi.fn().mockResolvedValue(1),
    getSlot: vi.fn().mockResolvedValue(1),
    // The pre-sign gate simulation is GREEN for both (the case seen live: gate and send preflight disagreed).
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [], unitsConsumed: 1000 } }),
    sendRawTransaction,
    getSignatureStatuses: vi.fn(async (sigs: string[]) => ({ value: sigs.map(statusOf) })),
    getSignatureStatus: vi.fn(async (sig: string) => ({ value: statusOf(sig) })),
    getTransaction: vi.fn().mockResolvedValue(null),
    getParsedTransaction: vi.fn().mockResolvedValue(null),
  } as never;
  const kp = Keypair.generate();
  const wallet = { publicKey: kp.publicKey, signTransaction: vi.fn(async (tx: Transaction) => { tx.partialSign(kp); return tx; }) };
  return { st, conn, wallet, sendRawTransaction };
}

/** hooks/useTrade.ts sendOrderOnce, reduced: send the order; on the wrapper's 121, re-plan WITH the peer crank and send again. */
async function openOnce(w: ReturnType<typeof world>): Promise<string> {
  const sendTrade = (ixs: TransactionInstruction[]) => sendTx({ connection: w.conn, wallet: w.wallet as never, instructions: ixs, maxRetries: 0 });
  try {
    return await sendTrade([tradeIx]);
  } catch (e) {
    if (isLossStaleError(e, WRAPPER.toBase58())) return sendWithRefreshRetry(async () => [crankIx, tradeIx], sendTrade, async () => undefined);
    throw e;
  }
}

beforeEach(() => { __setDevnetV22ForTest(true); netState.network = "devnet"; CONFIRMATION_POLL.maxMs = 300; vi.spyOn(console, "warn").mockImplementation(() => undefined); vi.spyOn(console, "info").mockImplementation(() => undefined); });
afterEach(() => { __setDevnetV22ForTest(null); CONFIRMATION_POLL.maxMs = 90_000; vi.restoreAllMocks(); });

describe("open double prompt (Council r1 M5): two prompts, at most one execution", () => {
  it("preflight 121 after a green gate: TWO prompts, but tx1 is never forwarded; only tx2 (with the crank) lands", async () => {
    const w = world("preflight-121");
    const sig = await openOnce(w);
    expect(w.wallet.signTransaction).toHaveBeenCalledTimes(2); // the duplicate PROMPT the recording showed
    expect(w.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(w.st.forwarded).toHaveLength(1); // tx1 refused by the node's preflight: never on the wire
    expect(w.st.forwarded[0]!.hasCrank).toBe(true);
    expect(w.st.landedOk).toEqual([sig]); // exactly one execution
  });

  it("CONTROL (the double-execution shape): if the first send MAY have been forwarded, the order is NOT rebuilt or re-signed", async () => {
    const w = world("ambiguous-drop");
    const err = (await openOnce(w).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(isLossStaleError(err, WRAPPER.toBase58())).toBe(false); // so the 121 branch cannot fire
    expect(err.message).toMatch(/may still land/i);
    expect(w.wallet.signTransaction).toHaveBeenCalledTimes(1); // one prompt, no second tx signed
    expect(w.st.forwarded.filter((f) => f.hasCrank)).toHaveLength(0); // no crank tx that could make tx1 valid
  });

  it("tx1 landed and FAILED 121 on chain (no state change): the re-sign is a retry of a failed tx, one success total", async () => {
    const w = world("landed-failed-121");
    // Gate green, preflight passes in this mode, chain fails tx1 121: the confirm reports the on-chain error.
    w.sendRawTransaction.mockImplementationOnce(async (wire: Uint8Array) => {
      const tx = Transaction.from(Buffer.from(wire));
      const s = bs58.encode(tx.signature!);
      w.st.forwarded.push({ sig: s, hasCrank: false });
      return s;
    });
    const r = await openOnce(w).then((s) => ({ ok: true as const, s }), (e: unknown) => ({ ok: false as const, e }));
    // tx1 is on chain as a FAILED tx (no effect); the 121 it reports triggers the crank re-send, which lands once.
    expect(r.ok).toBe(true);
    expect(w.wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(w.st.landedOk).toHaveLength(1);
    expect(w.st.forwarded.find((f) => f.sig === w.st.landedOk[0])!.hasCrank).toBe(true);
  });
});
