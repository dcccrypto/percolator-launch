/**
 * Regression — a creator-fee claim that does not complete must still RELEASE the
 * button, and must report why.
 *
 * This file began as the PoC for #2739 and asserted the opposite of everything
 * below: `busy` stayed `true` forever, `claim()` rejected, `outcomes` stayed
 * empty, and `reset()` could not help. The button takes both its label and its
 * `disabled` state from `busy` (CreatorFeesPanel.tsx:166,170), so a stranded flag
 * meant a dead "claiming…" button until the page was reloaded.
 *
 * Two reachable triggers, both covered here:
 *   - a declined/dismissed wallet prompt — one-approval.ts:42 awaits `signAll`
 *     OUTSIDE its try, and `signAllCompat` returns the wallet promise directly;
 *   - a `getFreshBlockhash` failure at useClaimCreatorFees.ts — it awaits
 *     `getLatestBlockhash()` with no try/catch, so an RPC blip strands the
 *     button BEFORE the wallet is ever opened.
 *
 * Every test uses TWO markets on purpose: with a single slab, a catch that fills
 * only the first slab (rather than iterating `slabs`) would pass.
 */

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Keypair, TransactionInstruction, type Transaction } from "@solana/web3.js";

const PAYER = Keypair.generate().publicKey;
const PROG = Keypair.generate().publicKey.toBase58();

/** What a wallet does when the user hits Reject. */
class UserRejected extends Error {
  constructor() {
    super("User rejected the request.");
    this.name = "WalletSignTransactionError";
  }
}

let rejectSigning = false;
let failBlockhash = false;
/**
 * Throw a specific value from the blockhash fetch (covers non-Error throws).
 * A separate flag, NOT `value ?? default`: one of the cases under test IS
 * `undefined`, and a nullish-coalescing default would silently swap it for an
 * ordinary Error and test nothing.
 */
let blockhashThrowSet = false;
let blockhashThrowValue: unknown = undefined;
/** Resolve-later hook for the in-flight reset test. */
let deferSigning: { promise: Promise<Transaction[]>; resolve: (t: Transaction[]) => void } | null = null;
/** Forces the error MAPPER to throw, to prove a landed signature survives it. */
let poisonMapper = false;
/** Slabs whose broadcast should fail. */
let failBroadcastFor = new Set<string>();

const signAllTransactions = vi.fn(async (txs: Transaction[]) => {
  if (deferSigning) return deferSigning.promise;
  if (rejectSigning) throw new UserRejected();
  return txs;
});
const WALLET = { publicKey: PAYER, signAllTransactions, signTransaction: vi.fn(async (t: Transaction) => t) };

/** A market whose account has no data fails to BUILD, with its own specific reason. */
let noDataFor = new Set<string>();
const CONN = {
  connection: {
    getAccountInfo: vi.fn(async (pk: { toBase58(): string }) =>
      noDataFor.has(pk.toBase58()) ? null : { data: Buffer.alloc(8) },
    ),
  },
};

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => WALLET, useConnectionCompat: () => CONN }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getConfig: () => ({ programId: PROG }) }));
let rejectProgram = false;
vi.mock("@/lib/programAllowlist", () => ({
  assertKnownProgram: () => {
    if (rejectProgram) throw new Error("Refusing to build an instruction for an unrecognised program.");
  },
}));
vi.mock("@/lib/creatorClaimError", async (orig) => {
  const real = await orig<{ mapCreatorClaimError: (s: string) => string }>();
  return {
    ...real,
    mapCreatorClaimError: (s: string) => {
      if (poisonMapper) throw new TypeError("mapper blew up");
      return real.mapCreatorClaimError(s);
    },
  };
});
vi.mock("@/lib/creator-fee-claim-ix", async (orig) => ({
  ...(await orig<object>()),
  buildCreatorFeeClaimIx: vi.fn(async ({ market }: { market: { toBase58(): string } }) => ({
    instruction: new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [],
      // Carries the slab so the broadcast mock can tell the txs apart.
      data: Buffer.from(market.toBase58()),
    }),
    amount: 1_500_000n,
  })),
}));
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<object>()),
  getFreshBlockhash: async () => {
    // getFreshBlockhash(connection, true) awaits connection.getLatestBlockhash()
    // with NO try/catch, so an RPC failure rejects straight into claim().
    if (blockhashThrowSet) throw blockhashThrowValue;
    if (failBlockhash) throw new Error("failed to get latest blockhash: 503 Service Unavailable");
    return "11111111111111111111111111111111";
  },
  getPriorityFee: async () => 1000,
  simulateForGate: async (_c: unknown, _p: unknown, ixs: TransactionInstruction[]) => ({
    err: null,
    consumed: 20_000,
    logs: [],
    // `rpcFailed: false` = the simulation ran and would land. A simulation that
    // could not RUN (`rpcFailed: true`) is held back unsigned since #2743 —
    // covered in useClaimCreatorFees-pending-unchecked.test.tsx.
    rpcFailed: false,
    simulated: ixs,
  }),
  broadcastSignedTx: async (_c: unknown, tx: { ixs?: TransactionInstruction[] }) => {
    const slab = tx.ixs?.[0]?.data.toString();
    if (slab && failBroadcastFor.has(slab)) throw new Error("Transaction failed: {\"InstructionError\":[0,{\"Custom\":62}]}");
    return "sig";
  },
  buildBatchTx: (p: { instructions: TransactionInstruction[]; priorityFeeMicroLamports: number }) => ({
    ixs: p.instructions,
    fee: p.priorityFeeMicroLamports,
  }),
}));

const { useClaimCreatorFees } = await import("@/hooks/useClaimCreatorFees");

/** The reported case: two markets with claimable fees. */
const twoMarkets = [0, 1].map(() => Keypair.generate().publicKey.toBase58());

function resetFlags() {
  rejectSigning = false;
  failBlockhash = false;
  blockhashThrowSet = false;
  blockhashThrowValue = undefined;
  deferSigning = null;
  poisonMapper = false;
  rejectProgram = false;
  failBroadcastFor = new Set();
  noDataFor = new Set();
}

describe("useClaimCreatorFees releases `busy` on every exit path", () => {
  it("CONTROL: a normal claim finishes, releases the button, and reports both markets", async () => {
    // Also the mutation guard for "delete the finally and release at the end of
    // the catch instead": the trailing setBusy(false) is gone, so that mutant
    // would never release on the happy path.
    resetFlags();
    const { result } = renderHook(() => useClaimCreatorFees());
    let returned: unknown[] = [];
    await act(async () => {
      returned = await result.current.claim(twoMarkets);
    });
    expect(result.current.busy).toBe(false);
    expect(signAllTransactions).toHaveBeenCalled();
    expect(returned).toHaveLength(2);
    // The RESOLVED value and the hook STATE must agree -- asserting only one of
    // them survives a mutant that corrupts the other.
    expect(result.current.outcomes).toEqual(returned);
    expect(returned.every((o) => (o as { signature?: string }).signature)).toBe(true);
  });

  it("a declined wallet prompt releases the button and says it was cancelled", async () => {
    resetFlags();
    rejectSigning = true;
    const { result } = renderHook(() => useClaimCreatorFees());
    let returned: { slab: string; error?: string }[] = [];
    await act(async () => {
      // RESOLVES -- it no longer rejects out of the hook.
      returned = await result.current.claim(twoMarkets);
    });

    expect(result.current.busy).toBe(false);
    expect(returned).toHaveLength(2);
    expect(result.current.outcomes).toEqual(returned);
    // Pinned text: this is the one assertion tying the catch to the ACTUAL
    // thrown value rather than to any constant.
    for (const o of returned) expect(o.error).toBe("Transaction cancelled.");
  });

  it("a blockhash RPC failure also releases it, with a DIFFERENT reason", async () => {
    // The window opens before the wallet is ever asked, which is why the release
    // has to cover the whole body rather than just the signing call. Asserting
    // the text differs from the cancellation text is what kills a catch body
    // that hardcodes "Transaction cancelled." for every failure.
    resetFlags();
    failBlockhash = true;
    const { result } = renderHook(() => useClaimCreatorFees());
    let returned: { slab: string; error?: string }[] = [];
    await act(async () => {
      returned = await result.current.claim(twoMarkets);
    });

    expect(signAllTransactions).not.toHaveBeenCalled(); // never got that far
    expect(result.current.busy).toBe(false);
    expect(returned).toHaveLength(2);
    for (const o of returned) {
      expect(o.error).toBeTruthy();
      expect(o.error).not.toBe("Transaction cancelled.");
    }
  });

  it("records an outcome for EVERY market, never an undefined hole", async () => {
    // `ordered` is built with a non-null assertion, so an empty catch body would
    // yield [undefined, undefined] and both callers would throw on
    // `results.some((r) => r.signature)`.
    resetFlags();
    rejectSigning = true;
    const { result } = renderHook(() => useClaimCreatorFees());
    let returned: unknown[] = [];
    await act(async () => {
      returned = await result.current.claim(twoMarkets);
    });
    expect(returned).toHaveLength(2);
    expect(returned.some((o) => o === undefined)).toBe(false);
    expect(returned.map((o) => (o as { slab: string }).slab)).toEqual([...twoMarkets]);
  });

  it("leaves progress in a terminal state, not mid-flight", async () => {
    resetFlags();
    rejectSigning = true;
    const { result } = renderHook(() => useClaimCreatorFees());
    await act(async () => {
      await result.current.claim(twoMarkets);
    });
    expect(result.current.progress).toEqual({ current: null, done: 2, total: 2 });
  });

  it("a market that failed to BUILD keeps its own reason, not the blanket one", async () => {
    // The `if (!results.has(slab))` guard. Market 0's account has no data, so it
    // is recorded with its specific reason before the decline happens; market 1
    // gets the cancellation. An unconditional set would overwrite market 0.
    resetFlags();
    noDataFor = new Set([twoMarkets[0]]);
    rejectSigning = true;
    const { result } = renderHook(() => useClaimCreatorFees());
    let returned: { slab: string; error?: string }[] = [];
    await act(async () => {
      returned = await result.current.claim(twoMarkets);
    });

    expect(result.current.busy).toBe(false);
    expect(returned[0]!.error).toBe("Market account not found.");
    expect(returned[1]!.error).toBe("Transaction cancelled.");
    expect(returned[0]!.error).not.toBe(returned[1]!.error);
  });

  // BOTH ORDERS on purpose. Once a transaction is on the wire, the outcome loop is
  // the only thing that can still throw, and a throw there would leave the
  // REMAINING units unwritten for the catch to relabel as failures -- telling a
  // creator a claim failed when it actually landed, with the signature discarded.
  // Only the failure-FIRST case exercises that: with the failure last, the success
  // has already been banked and an unguarded single-expression write passes too.
  it.each([
    ["first", 0, 1],
    ["last", 1, 0],
  ])("a LANDED signature survives a throwing error mapper when the failure is %s", async (_label, badIdx, goodIdx) => {
    resetFlags();
    failBroadcastFor = new Set([twoMarkets[badIdx]!]);
    poisonMapper = true;
    const { result } = renderHook(() => useClaimCreatorFees());
    let returned: { slab: string; signature?: string; error?: string }[] = [];
    await act(async () => {
      returned = await result.current.claim(twoMarkets);
    });

    expect(result.current.busy).toBe(false);
    expect(returned).toHaveLength(2);
    // The market that landed keeps its signature and carries NO error.
    expect(returned[goodIdx]!.signature).toBe("sig");
    expect(returned[goodIdx]!.error).toBeUndefined();
    // The one that genuinely failed still reports, despite the mapper throwing.
    expect(returned[badIdx]!.signature).toBeUndefined();
    expect(returned[badIdx]!.error).toBe("Claim failed.");
  });

  it.each([
    ["undefined", undefined],
    ["a function", () => {}],
    ["a symbol", Symbol("nope")],
    ["a BigInt field", { amount: 1n }],
    ["a circular object", (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })()],
  ])("releases and reports when the thrown value is %s", async (_label, thrown) => {
    // claimErrorText is the error path for the whole claim, so it must be total.
    // JSON.stringify THROWS on a BigInt or a circular reference, and RETURNS
    // undefined for undefined/functions/symbols -- which would reach
    // humanizeError(rawMsg: string) as a non-string and throw there. Either way
    // claim() would reject from inside its own catch and strand the button again.
    resetFlags();
    blockhashThrowSet = true;
    blockhashThrowValue = thrown;
    const { result } = renderHook(() => useClaimCreatorFees());
    let returned: { error?: string }[] = [];
    await act(async () => {
      returned = await result.current.claim(twoMarkets);
    });

    expect(result.current.busy).toBe(false);
    expect(returned).toHaveLength(2);
    for (const o of returned) {
      // The HUMANIZED text, not the generic last-resort fallback. Asserting only
      // "some non-empty string" would pass even if claimErrorText handed the
      // mapper a non-string and the outer guard swallowed the resulting throw --
      // which is exactly what dropping `?? String(err)` does.
      expect(o.error).toBe("Something went wrong and nothing was sent.");
      expect(o.error).not.toBe("Claim failed.");
    }
  });

  it("still resolves when the error mapper throws on the way to reporting a decline", async () => {
    // The outer catch is the last code between a throw and the caller. If the
    // shared error mapper throws in there, claim() would reject from inside its
    // own catch -- the stuck-button bug through a narrower door -- so "claim()
    // resolves" has to be a property of this hook, not an inherited promise
    // about humanizeError.
    resetFlags();
    rejectSigning = true;
    poisonMapper = true;
    const { result } = renderHook(() => useClaimCreatorFees());
    let returned: { error?: string }[] = [];
    await act(async () => {
      returned = await result.current.claim(twoMarkets);
    });

    expect(result.current.busy).toBe(false);
    expect(returned).toHaveLength(2);
    for (const o of returned) expect(o.error).toBe("Claim failed.");
  });

  it("a rejected program-id guard is reported, not thrown past the caller", async () => {
    // getConfig / new PublicKey / assertKnownProgram used to run BEFORE
    // setBusy(true) and outside any try, so a mis-set program id rejected out of
    // the hook: an unhandled rejection in both callers, no outcome, nothing shown.
    // They now run inside the try, so the failure is reported like any other.
    resetFlags();
    rejectProgram = true;
    const { result } = renderHook(() => useClaimCreatorFees());
    let returned: { error?: string }[] = [];
    await act(async () => {
      returned = await result.current.claim(twoMarkets);
    });

    expect(result.current.busy).toBe(false);
    expect(returned).toHaveLength(2);
    for (const o of returned) expect(o.error).toBeTruthy();
    expect(signAllTransactions).not.toHaveBeenCalled();
  });

  it("reset() clears `busy` even while a claim is still in flight", async () => {
    // Without a pending claim this assertion is vacuous -- `busy` is already
    // false by the time a completed claim returns, so deleting the setBusy(false)
    // from reset() would still pass. Hold the wallet prompt open instead.
    resetFlags();
    let release!: (t: Transaction[]) => void;
    const promise = new Promise<Transaction[]>((res) => { release = res; });
    deferSigning = { promise, resolve: release };

    const { result } = renderHook(() => useClaimCreatorFees());
    let settled: Promise<unknown>;
    await act(async () => {
      settled = result.current.claim(twoMarkets);
      // let the hook run up to the pending signAll
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(true); // mid-flight

    act(() => result.current.reset());
    expect(result.current.busy).toBe(false);

    // Settle the pending prompt so the claim does not run past the test.
    await act(async () => {
      release([]);
      await settled!.catch(() => {});
    });
  });
});
