/**
 * #2742 + #2743 — the creator-fee claim's two indeterminate outcomes.
 *
 * `broadcastSignedTx` is the REAL one from lib/tx.ts (only the Connection under it is faked), so
 * the #2742 cases get the actual pollConfirmation deadline error with the signature it attaches.
 * `simulateForGate` cannot run for real under jsdom (its ComputeBudget encoding trips the
 * cross-realm Uint8Array check before its try), so here it returns exactly the shape of its
 * "RPC threw" branch — that the real function produces this shape is pinned separately in
 * __tests__/lib/simulateForGate-rpc-failed.test.ts (node env).
 *
 *  - #2743: a simulation that could not RUN is not a pass. The unit must never reach the wallet
 *    and must report "try again", not be signed with no pre-check.
 *  - #2742: a claim whose confirmation timed out was SENT. It must keep its signature as a
 *    pending outcome (neither claimed nor failed), never be counted in the claimed total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { Keypair, PublicKey, TransactionInstruction, type Transaction } from "@solana/web3.js";

const PAYER = Keypair.generate().publicKey;
const signAllTransactions = vi.fn(async (txs: Transaction[]) => txs);
const WALLET = { publicKey: PAYER, signAllTransactions, signTransaction: vi.fn(async (t: Transaction) => t) };

/** Slabs whose pre-sign simulation RPC throws (#2743). */
let simThrowsFor = new Set<string>();
/** What getSignatureStatuses reports for every sent claim (#2742). */
let statusMode: "never-confirms" | "confirmed" | "failed" = "confirmed";

const slabOf = (m: { instructions?: { data: Buffer }[] } | undefined) => m?.instructions?.[0]?.data.toString() ?? "";

const connection = {
  getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8) })),
  sendRawTransaction: vi.fn(async (raw: Buffer) => `sig-${raw.toString()}`),
  getSignatureStatuses: vi.fn(async () => ({
    context: { slot: 1 },
    value: [
      statusMode === "never-confirms"
        ? null
        : statusMode === "failed"
          ? { err: { InstructionError: [0, { Custom: 62 }] }, confirmationStatus: "confirmed" }
          : { err: null, confirmationStatus: "confirmed" },
    ],
  })),
};

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => WALLET, useConnectionCompat: () => ({ connection }) }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getConfig: () => ({ programId: "11111111111111111111111111111111", network: "devnet", explorerUrl: "https://explorer.solana.com" }) }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined }));
vi.mock("@/lib/creator-fee-claim-ix", async (orig) => ({
  ...(await orig<object>()),
  buildCreatorFeeClaimIx: vi.fn(async ({ market }: { market: { toBase58(): string } }) => ({
    // Data carries a short slab tag so the fake connection can tell the claims apart.
    instruction: new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from(market.toBase58().slice(0, 6)) }),
    amount: 1_500_000n,
  })),
}));
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<object>()),
  // broadcastSignedTx is deliberately NOT mocked.
  simulateForGate: vi.fn(async (_c: unknown, _p: unknown, ixs: TransactionInstruction[]) =>
    simThrowsFor.has(ixs[0]!.data.toString())
      ? { consumed: null, err: null, logs: [], rpcFailed: true, simulated: ixs } // simulateForGate's catch branch
      : { consumed: 12_345, err: null, logs: [], rpcFailed: false, simulated: ixs }),
  getFreshBlockhash: async () => "11111111111111111111111111111111",
  getPriorityFee: async () => 1000,
  // jsdom's cross-realm Uint8Array breaks web3 signing here; serialize() just tags the claim.
  buildBatchTx: (p: { instructions: TransactionInstruction[] }) => ({
    instructions: p.instructions,
    serialize: () => Buffer.from(slabOf({ instructions: p.instructions as unknown as { data: Buffer }[] })),
  }),
}));

const { useClaimCreatorFees, claimAllResultCopy, CLAIM_UNCHECKED_MESSAGE } = await import("@/hooks/useClaimCreatorFees");
const { CreatorFeesPanel } = await import("@/components/my-markets/CreatorFeesPanel");

const fmt = (a: bigint) => `${Number(a) / 1e6}`;
const newSlabs = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());
const tag = (slab: string) => slab.slice(0, 6);

beforeEach(() => {
  simThrowsFor = new Set();
  statusMode = "confirmed";
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("#2743: a simulation that could not run is never signed", () => {
  it("RPC failure on the only market: wallet never opened, nothing sent, 'try again' reported", async () => {
    const [a] = newSlabs(1);
    simThrowsFor = new Set([tag(a!)]);
    const { result } = renderHook(() => useClaimCreatorFees());
    let out: Awaited<ReturnType<typeof result.current.claim>> = [];
    await act(async () => {
      out = await result.current.claim([a!]);
    });
        expect(signAllTransactions).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(out).toEqual([{ slab: a, error: CLAIM_UNCHECKED_MESSAGE }]);
    expect(result.current.busy).toBe(false);
  });

  it("mixed: the checked market is signed alone, the unchecked one is held back", async () => {
    const [a, b] = newSlabs(2);
    simThrowsFor = new Set([tag(b!)]);
    const { result } = renderHook(() => useClaimCreatorFees());
    let out: Awaited<ReturnType<typeof result.current.claim>> = [];
    await act(async () => {
      out = await result.current.claim([a!, b!]);
    });
    expect(signAllTransactions).toHaveBeenCalledTimes(1);
    expect(signAllTransactions.mock.calls[0]![0]).toHaveLength(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatchObject({ slab: a, signature: `sig-${tag(a!)}` });
    expect(out[1]).toEqual({ slab: b, error: CLAIM_UNCHECKED_MESSAGE });
  });
});

describe("#2742: a claim whose confirmation timed out is pending, with its signature", () => {
  it("poll deadline: pendingSignature kept, not a success, not an error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const [a] = newSlabs(1);
    statusMode = "never-confirms";
    const onLanded = vi.fn();
    const { result } = renderHook(() => useClaimCreatorFees());
    let out: Awaited<ReturnType<typeof result.current.claim>> = [];
    await act(async () => {
      const p = result.current.claim([a!], { onLanded });
      await vi.advanceTimersByTimeAsync(120_000);
      out = await p;
    });
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(out).toEqual([{ slab: a, pendingSignature: `sig-${tag(a!)}`, amount: 1_500_000n }]);
    expect(out[0]!.signature).toBeUndefined();
    expect(out[0]!.error).toBeUndefined();
    expect(onLanded).not.toHaveBeenCalled();
    expect(claimAllResultCopy(out, fmt)).toBe("1 claim sent but not confirmed yet; check it on the explorer.");
  });

  it("a definite on-chain failure (status.err) still reports failed, never pending", async () => {
    const [a] = newSlabs(1);
    statusMode = "failed";
    const { result } = renderHook(() => useClaimCreatorFees());
    let out: Awaited<ReturnType<typeof result.current.claim>> = [];
    await act(async () => {
      out = await result.current.claim([a!]);
    });
    expect(out[0]!.pendingSignature).toBeUndefined();
    expect(out[0]!.signature).toBeUndefined();
    expect(out[0]!.error).toMatch(/exceeds the creator fees/);
  });

  it("the panel shows the pending claim with an explorer link and keeps it out of the total", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    statusMode = "never-confirms";
    const slabs = newSlabs(1);
    type Props = Parameters<typeof CreatorFeesPanel>[0];
    const markets = slabs.map((s) => ({
      slabAddress: new PublicKey(s),
      label: "PERC",
      configV17: { collateralMint: { toBase58: () => "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC" }, unitScale: 0 },
    })) as unknown as Props["markets"];
    const details = Object.fromEntries(slabs.map((s) => [s, { creator_fee_claimable_atoms: "1500000", creator_fee_authority: PAYER.toBase58() }])) as unknown as Props["details"];
    render(<CreatorFeesPanel markets={markets} details={details} identities={{}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /claim all \(1\)/i }));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.getByTestId("creator-claim-result").textContent).toBe("1 claim sent but not confirmed yet; check it on the explorer.");
    const pending = screen.getByTestId("creator-claim-pending");
    expect(pending.textContent).toMatch(/^PERC sent, not confirmed yet\./);
    expect(pending.querySelector("a")!.getAttribute("href")).toBe(`https://explorer.solana.com/tx/sig-${tag(slabs[0]!)}?cluster=devnet`);
    expect(screen.queryByTestId("creator-claim-unclaimed")).toBeNull();
  });
});

describe("claimAllResultCopy with pending claims (#2742)", () => {
  const ok = { slab: "a", signature: "s", amount: 2_000_000n };
  const pend = { slab: "b", pendingSignature: "p", amount: 5_000_000n };
  const bad = { slab: "c", error: "x" };
  it("pending is excluded from the total and from the failure count", () => {
    expect(claimAllResultCopy([ok, pend], fmt)).toBe("Claimed 2 from 1 market. 1 claim sent but not confirmed yet; check it on the explorer.");
    expect(claimAllResultCopy([ok, pend, bad], fmt)).toBe("Claimed 2 from 1 market. 1 claim sent but not confirmed yet; check it on the explorer. 1 couldn't be claimed right now.");
    expect(claimAllResultCopy([pend, { ...pend, slab: "d" }], fmt)).toBe("2 claims sent but not confirmed yet; check them on the explorer.");
  });
  it("copy without pending claims is unchanged", () => {
    expect(claimAllResultCopy([ok], fmt)).toBe("Claimed 2 from 1 market.");
    expect(claimAllResultCopy([ok, bad], fmt)).toBe("Claimed 2 from 1 market. 1 couldn't be claimed right now; we'll show them here.");
    expect(claimAllResultCopy([bad], fmt)).toBe("1 market couldn't be claimed right now; we'll show it here.");
  });
});
