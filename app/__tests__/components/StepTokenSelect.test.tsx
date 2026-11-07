/**
 * StepTokenSelect regression tests — GH#1263
 *
 * Verifies the debounce race-condition fix: when the component mounts with a
 * pre-filled mint address (e.g. /create?mint=...) the 400 ms debounce must NOT
 * call onMintChange with the same value, which would reset mintExistsOnNetwork
 * in the parent and permanently disable the Continue button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { StepTokenSelect } from "@/components/create/StepTokenSelect";

// ─────────────────────────────────────────────────────────────
// Minimal mocks
// ─────────────────────────────────────────────────────────────

// Stable fake mint — valid base58, 44 chars
const DEVNET_MINT = "4RkzTf5WWPVJHuFr8TW7et4SsQwKK1veJqEKdxMNmKyX";
const MAINNET_MINT = "So11111111111111111111111111111111111111112";

const mockPublicKey = {
  toBase58: () => "G7NGnUffoo2bKBY7nGjJmSZq7rSvG4bsJpK931rGQshD",
  equals: () => false,
};

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: null }),
  useConnectionCompat: () => ({
    connection: {
      rpcEndpoint: "https://api.devnet.solana.com",
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getParsedAccountInfo: vi.fn().mockResolvedValue({ value: null }),
    },
  }),
}));

vi.mock("@/hooks/useTokenMeta", () => ({
  useTokenMeta: () => null,
}));

vi.mock("@/lib/config", () => ({
  getNetwork: () => "devnet",
}));

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: vi.fn(),
  getAccount: vi.fn(),
  TOKEN_PROGRAM_ID: { toBase58: () => "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", equals: () => true },
  TOKEN_2022_PROGRAM_ID: { toBase58: () => "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", equals: () => false },
}));

vi.mock("@/lib/parseAmount", () => ({
  formatHumanAmount: (amount: bigint, _decimals: number) => amount.toString(),
}));

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function renderStep(
  mintAddress: string,
  callbacks: {
    onMintChange?: (mint: string) => void;
    onTokenResolved?: (meta: { name: string; symbol: string; decimals: number } | null) => void;
    onMintNetworkValidChange?: (valid: boolean) => void;
    onContinue?: () => void;
    canContinue?: boolean;
  } = {}
) {
  const {
    onMintChange = vi.fn(),
    onTokenResolved = vi.fn(),
    onMintNetworkValidChange = vi.fn(),
    onContinue = vi.fn(),
    canContinue = false,
  } = callbacks;

  return render(
    <StepTokenSelect
      mintAddress={mintAddress}
      onMintChange={onMintChange}
      onTokenResolved={onTokenResolved}
      onBalanceChange={vi.fn()}
      onMintNetworkValidChange={onMintNetworkValidChange}
      onContinue={onContinue}
      canContinue={canContinue}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("StepTokenSelect — GH#1263 debounce race condition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT call onMintChange when mounted with a pre-filled mint (debounce no-op)", async () => {
    const onMintChange = vi.fn();

    renderStep(DEVNET_MINT, { onMintChange });

    // Advance 400 ms to let the debounce timer fire
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // onMintChange must NOT have been called — the value didn't change
    expect(onMintChange).not.toHaveBeenCalled();
  });

  it("DOES call onMintChange when the user changes the value from empty", async () => {
    const onMintChange = vi.fn();

    renderStep("", { onMintChange });

    const input = screen.getByPlaceholderText(/paste mint address/i);
    // Simulate paste/change from empty to a new mint
    fireEvent.change(input, { target: { value: DEVNET_MINT } });

    // Advance past debounce window
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // onMintChange should have been called with the new value
    expect(onMintChange).toHaveBeenCalledWith(DEVNET_MINT);
  });

  it("calls onMintChange when the user changes from one pre-filled mint to another", async () => {
    const onMintChange = vi.fn();

    renderStep(DEVNET_MINT, { onMintChange });

    // Advance past the initial debounce — should be a no-op (same value)
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onMintChange).not.toHaveBeenCalled();

    // Now user pastes a different mint
    const input = screen.getByPlaceholderText(/paste mint address/i);
    fireEvent.change(input, { target: { value: MAINNET_MINT } });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // Should be called with the new value
    expect(onMintChange).toHaveBeenLastCalledWith(MAINNET_MINT);
  });

  it("renders the input field with the pre-filled value", () => {
    renderStep(DEVNET_MINT);

    const input = screen.getByPlaceholderText(/paste mint address/i) as HTMLInputElement;
    expect(input.value).toBe(DEVNET_MINT);
  });
});

// ─────────────────────────────────────────────────────────────
// Mirror-mint model removed (2026-07): the playground no longer creates a
// per-market devnet mirror mint — collateral is always the universal
// Sim-USDC mint (see CreateMarketWizard.tsx's collateralMintAddress). The
// Council 2026-11-06-go1106-ux, Creator (low): "Pasting the sim-USDC collateral mint says 'This token already has a
// market' and links to Percolator, PUMP and PENGU, which is the wrong reason." (shots/cr2-create-simusdc.png)
describe("StepTokenSelect: pasting the collateral mint", () => {
  const COLLATERAL = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
  const dupes = [
    { slab: "BbuB3mb5DkFmJLfoaumkbM6eEv3wZDjz9YZokhEgVJv3", symbol: "Percolator" },
    { slab: "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ", symbol: "PENGU" },
  ];
  const renderWith = (mint: string) =>
    render(
      <StepTokenSelect
        mintAddress={mint}
        onMintChange={vi.fn()}
        onTokenResolved={vi.fn()}
        onBalanceChange={vi.fn()}
        onMintNetworkValidChange={vi.fn()}
        onContinue={vi.fn()}
        canContinue={true}
        duplicateMarkets={dupes}
      />,
    );

  it("says it is the collateral, not 'already has a market', and lists no markets", () => {
    renderWith(COLLATERAL);
    expect(screen.getByTestId("create-collateral-mint-blocked").textContent).toMatch(/collateral every market uses/);
    expect(screen.queryByText(/already has a market/)).toBeNull();
    expect(screen.queryByRole("link", { name: /PENGU/ })).toBeNull();
  });

  it("a real duplicate still shows the one-market-per-token box (negative control)", () => {
    renderWith(DEVNET_MINT);
    expect(screen.queryByTestId("create-collateral-mint-blocked")).toBeNull();
    expect(screen.getByText(/already has a market/)).toBeTruthy();
  });
});

// GH#1614 regression tests that used to live here asserted the now-deleted
// /api/devnet-mirror-mint POST call existed in source; removed along with
// that code path. See StepTokenSelect.tsx's validation effect doc comment
// for the current devnet behavior.
// ─────────────────────────────────────────────────────────────
