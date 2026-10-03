/**
 * Creator fees panel: "Claimed all time", rebuilt from the market's claim history (the chain
 * keeps only the claimable balance). The hook and panel are real; only the chain read is mocked.
 */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ fetch: vi.fn(), claim: {} as Record<string, unknown>, slab: "5iGg1DPyoyWEzFCvbd26CVgPG2X9FgKaJrHaaGUWJyLr" }));
vi.mock("@/lib/creator-fee-history", () => ({ fetchCreatorFeesClaimed: h.fetch }));
vi.mock("@/hooks/useCreatorClaim", () => ({ useCreatorClaim: () => h.claim }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
const CONN = {}; // stable, like the app's shared Connection
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: CONN }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    slabAddress: h.slab,
    programId: new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB"),
    config: { collateralMint: new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC") },
  }),
}));

import { CreatorClaimPanel } from "@/components/market/CreatorClaimPanel";
import { CLAIMED_RETRY_MS } from "@/hooks/useCreatorFeesClaimed";

const CREATOR = new PublicKey("BYuz6iPTRADNjrMQMehb8xbpQTULXq7Kc2uSoYJzug77");
const claimHook = (over: Record<string, unknown> = {}) => ({
  isClaimAuthority: true,
  claimAuthority: CREATOR,
  claimable: 0n,
  loading: false,
  error: null,
  success: null,
  claim: vi.fn(),
  ...over,
});
const cell = () => screen.getByTestId("creator-claimed-all-time");

describe("Creator fees: claimed all time", () => {
  beforeEach(() => {
    h.fetch.mockReset();
    h.claim = claimHook();
    h.slab = "5iGg1DPyoyWEzFCvbd26CVgPG2X9FgKaJrHaaGUWJyLr";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the total and the number of claims", async () => {
    h.fetch.mockResolvedValue({ claimedAtoms: 92_104n, claims: 1 });
    render(<CreatorClaimPanel />);
    expect(cell()).toHaveTextContent("—"); // loading
    expect(await screen.findByText("0.092104 USDC")).toBeInTheDocument();
    expect(screen.getByText("· 1 claim")).toBeInTheDocument();
    // Scanned for the creator's own token account on this market.
    expect(h.fetch.mock.calls[0][4].toBase58()).toBe(CREATOR.toBase58());
  });

  it("a failed read says unavailable, not 0", async () => {
    h.fetch.mockRejectedValue(new Error("429"));
    render(<CreatorClaimPanel />);
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
    expect(cell()).not.toHaveTextContent("0 USDC");
  });

  it("re-scans after a claim lowers the claimable balance", async () => {
    h.claim = claimHook({ claimable: 5_000_000n });
    h.fetch.mockResolvedValueOnce({ claimedAtoms: 1_000_000n, claims: 1 });
    const { rerender } = render(<CreatorClaimPanel />);
    expect(await screen.findByText("1 USDC")).toBeInTheDocument();
    h.claim = claimHook({ claimable: 0n });
    h.fetch.mockResolvedValueOnce({ claimedAtoms: 6_000_000n, claims: 2 });
    rerender(<CreatorClaimPanel />);
    expect(await screen.findByText("6 USDC")).toBeInTheDocument();
    expect(screen.getByText("· 2 claims")).toBeInTheDocument();
  });

  it("a failed re-scan shows unavailable, not the old (possibly short) total", async () => {
    h.claim = claimHook({ claimable: 5_000_000n });
    h.fetch.mockResolvedValueOnce({ claimedAtoms: 1_000_000n, claims: 1 });
    const { rerender } = render(<CreatorClaimPanel />);
    expect(await screen.findByText("1 USDC")).toBeInTheDocument();
    // A claim lowers the balance; the re-scan that would count it fails.
    h.claim = claimHook({ claimable: 0n });
    h.fetch.mockRejectedValueOnce(new Error("429"));
    h.fetch.mockReturnValue(new Promise(() => {})); // the automatic retry is still running
    rerender(<CreatorClaimPanel />);
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
    expect(screen.queryByText("1 USDC")).not.toBeInTheDocument();
    expect(screen.queryByText("· 1 claim")).not.toBeInTheDocument();
  });

  it("retries a failed read once on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.fetch.mockRejectedValueOnce(new Error("Minimum context slot has not been reached"));
    h.fetch.mockRejectedValueOnce(new Error("still behind"));
    render(<CreatorClaimPanel />);
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(CLAIMED_RETRY_MS);
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
    // Only one retry: a second failure waits for the next balance change.
    await act(async () => {
      vi.advanceTimersByTime(CLAIMED_RETRY_MS * 3);
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("the retry shows the total once the read succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.fetch.mockRejectedValueOnce(new Error("429"));
    h.fetch.mockResolvedValueOnce({ claimedAtoms: 92_104n, claims: 1 });
    render(<CreatorClaimPanel />);
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(CLAIMED_RETRY_MS);
    });
    expect(await screen.findByText("0.092104 USDC")).toBeInTheDocument();
  });

  it("switching market shows loading, not the previous market's total", async () => {
    h.fetch.mockResolvedValueOnce({ claimedAtoms: 92_104n, claims: 1 });
    const { rerender } = render(<CreatorClaimPanel />);
    expect(await screen.findByText("0.092104 USDC")).toBeInTheDocument();
    h.slab = "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ";
    h.fetch.mockReturnValueOnce(new Promise(() => {})); // the new market's read is still running
    rerender(<CreatorClaimPanel />);
    expect(cell()).toHaveTextContent("—");
  });

  it("does not scan for a wallet that isn't the claim authority", () => {
    h.claim = claimHook({ isClaimAuthority: false });
    render(<CreatorClaimPanel />);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
