/**
 * Live report 2026-10-01 (My Markets): "Claim all" on 2 markets claimed ONE (Percolator landed on
 * chain, SI never did) and then stayed on "Claiming…" with the figure and "2 markets have fees you
 * can claim" frozen. The panel must: re-read balances as each claim confirms, end with a calm
 * result line for a partial success, and give the button back.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Keypair, PublicKey, TransactionInstruction, type Transaction } from "@solana/web3.js";

const h = vi.hoisted(() => ({ slabs: [] as string[], broadcastN: 0 }));
const PAYER = Keypair.generate().publicKey;
// A wallet that hands back NEW objects from signAll (as Privy / adapters do).
const signAllTransactions = vi.fn(async (txs: Transaction[]) => txs.map((t) => ({ ...t, signed: true }) as unknown as Transaction));
const WALLET = { publicKey: PAYER, signAllTransactions, signTransaction: vi.fn() };
const CONN = { connection: { getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8) })) } };
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => WALLET, useConnectionCompat: () => CONN }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getConfig: () => ({ programId: "11111111111111111111111111111111" }) }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined }));
vi.mock("@/lib/creator-fee-claim-ix", async (orig) => ({
  ...(await orig<object>()),
  buildCreatorFeeClaimIx: vi.fn(async ({ market }: { market: { toBase58(): string } }) => ({
    instruction: new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.from(market.toBase58().slice(0, 4)) }),
    amount: market.toBase58() === h.slabs[0] ? 283_668n : 941_717n,
  })),
}));
const broadcast = vi.fn(async () => {
  h.broadcastN += 1;
  if (h.broadcastN === 2) throw new Error("Transaction failed: blockhash not found");
  return "sig-percolator";
});
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<object>()),
  getFreshBlockhash: async () => "11111111111111111111111111111111",
  getPriorityFee: async () => 1000,
  simulateForGate: async (_c: unknown, _p: unknown, ixs: TransactionInstruction[]) => ({ err: null, consumed: 20_000, logs: [], rpcFailed: false, simulated: ixs }),
  broadcastSignedTx: (...a: unknown[]) => broadcast(...(a as [])),
  buildBatchTx: (p: { instructions: TransactionInstruction[] }) => ({ ixs: p.instructions }),
}));

import { CreatorFeesPanel } from "@/components/my-markets/CreatorFeesPanel";

h.slabs = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
type Props = Parameters<typeof CreatorFeesPanel>[0];
const markets = h.slabs.map((s, i) => ({
  slabAddress: new PublicKey(s),
  label: i === 0 ? "Percolator" : "SI",
  configV17: { collateralMint: { toBase58: () => "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC" }, unitScale: 0 },
})) as unknown as Props["markets"];
const details = Object.fromEntries(
  h.slabs.map((s, i) => [s, { creator_fee_claimable_atoms: i === 0 ? "283668" : "941717", creator_fee_authority: PAYER.toBase58() }]),
) as unknown as Props["details"];

// #69: the Unclaimed Fees total was a bare number.
describe("unclaimed fees total", () => {
  it("shows the collateral's symbol after the total", async () => {
    render(<CreatorFeesPanel markets={markets} details={details} identities={{}} />);
    // 0.283668 + 0.941717, sim-USDC (resolved from the local known-token table, no RPC)
    expect(await screen.findByText("USDC")).toBeTruthy();
    const unit = screen.getByText("USDC");
    expect(unit.parentElement!.textContent).toMatch(/^1[.,]225385\s*USDC$/); // locale-tolerant
    expect(unit.getAttribute("title")).toBe("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");
  });
});

describe("claim all: one lands, one fails", () => {
  it("re-reads after the landed claim, ends with a calm partial line, and gives the button back", async () => {
    const onClaimed = vi.fn();
    render(<CreatorFeesPanel markets={markets} details={details} identities={{}} onClaimed={onClaimed} />);
    expect(screen.getByText("2 markets have fees you can claim")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /claim all \(2\)/i }));
    });

    // One approval for both; balances re-read when Percolator confirmed AND once at the end.
    expect(signAllTransactions).toHaveBeenCalledTimes(1);
    expect(onClaimed.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Never stuck: the button is back and enabled.
    const again = screen.getByRole("button", { name: /claim all/i }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(again.textContent).not.toMatch(/claiming/i);
    // One calm result line for the partial success, plus which market to retry.
    expect(screen.getByTestId("creator-claim-result").textContent).toBe("Claimed 0.283668 from 1 market. 1 couldn't be claimed right now; we'll show them here.");
    expect(screen.getByTestId("creator-claim-unclaimed").textContent).toMatch(/^SI not claimed: /);
  });
});
