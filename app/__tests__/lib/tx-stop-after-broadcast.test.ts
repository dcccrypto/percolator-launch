// @vitest-environment node
/**
 * Stop pressed after the wallet signed. The OrderTicket's Stop (abortSignal) is meant
 * to end the PRE-SEND wait ("nothing was sent"). On the attempt that simulates green, Stop is
 * still on screen (onWaiting(false) only fires after sendTx returns) while the wallet signs and
 * the tx is broadcast. Aborting then must not turn an already-broadcast trade into an error the
 * ticket renders as "nothing was sent": the trade can still fill.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import { sendTxWaiting } from "@/lib/tx";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { humanizeError } from "@/lib/errorMessages";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

const WRAPPER = resolveDevnetProgramIds().wrapper;
const SIG = bs58.encode(new Uint8Array(64).fill(7));
const stale = { InstructionError: [0, { Custom: WRAPPER_ERR.EngineStale }] };

/** First status poll: still pending, and the user presses Stop. Later polls: confirmed. */
function conn(events: string[], ac: AbortController, staleRounds: number) {
  let sims = 0;
  let polls = 0;
  const c = {
    rpcEndpoint: "https://percolator-playground.vercel.app/api/rpc",
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(1_000_000_000),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10_000_000 }),
    getBlockHeight: vi.fn().mockResolvedValue(1),
    simulateTransaction: vi.fn(async () => {
      const err = sims++ < staleRounds ? stale : null;
      events.push(err ? "simulate:stale" : "simulate:green");
      return { value: { err, logs: err ? [`Program ${WRAPPER} failed: custom program error: 0x13`] : [], unitsConsumed: 50_000 } };
    }),
    sendRawTransaction: vi.fn(async () => { events.push("broadcast"); return SIG; }),
    getSignatureStatuses: vi.fn(async () => {
      events.push("poll");
      if (polls++ === 0) {
        events.push("STOP");
        ac.abort();
        return { value: [null] };
      }
      return { value: [{ confirmationStatus: "confirmed", err: null }] };
    }),
  };
  return c as never;
}
const ix = () => new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });

/** What the ticket renders for `err` (OrderTicket handleTrade catch: resolver, then humanizeError for unmapped). */
function ticketText(err: unknown) {
  const um = resolveUserMessage(err, { surface: "trade" });
  const msg = err instanceof Error ? err.message : String(err);
  return { kind: um.kind, quiet: um.quiet ?? false, resolverBody: um.body, humanized: humanizeError(msg, "trade") };
}

describe("Stop after the wallet signed", () => {
  it("sendTxWaiting: Stop is still showing when the wallet signs; aborting mid-poll must not drop a broadcast trade", async () => {
    const events: string[] = [];
    const ac = new AbortController();
    const kp = Keypair.generate();
    const wallet = { publicKey: kp.publicKey, signTransaction: vi.fn(async (tx: Transaction) => { events.push("wallet-sign"); tx.partialSign(kp); return tx; }) };

    const out = await sendTxWaiting({
      connection: conn(events, ac, 3), wallet, instructions: [ix()], computeUnitsFromSim: { cap: 400_000 },
      waitDelaysMs: [1, 1], keepWaiting: true, longWaitMs: 2,
      onWaiting: (w) => events.push(`onWaiting(${w})`),
      onWaitingLong: () => events.push("onWaitingLong"),
      abortSignal: ac.signal,
    }).then((sig) => ({ sig, err: undefined }), (err: unknown) => ({ sig: undefined, err }));

    if (out.err) console.log("thrown:", (out.err as Error).message, "\nticket shows:", ticketText(out.err));

    // Stop-visibility evidence: tradePhase is "waiting" (and waitingLong set) from onWaiting(true) /
    // onWaitingLong until onWaiting(false); the wallet signs, the tx is broadcast and polled in between.
    const at = (e: string) => events.indexOf(e);
    expect(at("onWaitingLong")).toBeGreaterThan(-1);
    expect(at("onWaitingLong")).toBeLessThan(at("wallet-sign"));
    expect(at("wallet-sign")).toBeLessThan(at("broadcast"));
    expect(at("broadcast")).toBeLessThan(at("STOP"));
    const lastWaitingFalse = events.lastIndexOf("onWaiting(false)");
    expect(lastWaitingFalse === -1 || lastWaitingFalse > at("STOP")).toBe(true);
    expect(events.filter((e) => e === "broadcast")).toHaveLength(1);

    // The broadcast trade is followed to its confirmation, not reported as "nothing was sent".
    expect(out.err).toBeUndefined();
    expect(out.sig).toBe(SIG);
  });
});
