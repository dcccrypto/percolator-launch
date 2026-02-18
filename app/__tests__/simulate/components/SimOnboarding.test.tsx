import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockSetVisible = vi.fn();
vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: vi.fn(() => ({ connected: false, publicKey: null })),
  useConnection: vi.fn(() => ({
    connection: {
      getBalance: vi.fn().mockResolvedValue(0),
      getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { uiAmount: 0 } }),
    },
  })),
}));
vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: vi.fn(() => ({ setVisible: mockSetVisible })),
}));
vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: vi.fn().mockResolvedValue("mock-ata"),
}));
vi.mock("@solana/web3.js", () => ({
  PublicKey: vi.fn().mockImplementation((s: string) => s),
  LAMPORTS_PER_SOL: 1_000_000_000,
}));

// Mock localStorage
const mockStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mockStorage[k] || null,
  setItem: (k: string, v: string) => { mockStorage[k] = v; },
  removeItem: (k: string) => { delete mockStorage[k]; },
});

import { SimOnboarding } from "@/app/simulate/components/SimOnboarding";
import { useWallet } from "@solana/wallet-adapter-react";

describe("SimOnboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    vi.mocked(useWallet).mockReturnValue({
      connected: false,
      publicKey: null,
    } as any);
  });

  it("renders GET STARTED header", () => {
    render(<SimOnboarding hasBalance={false} hasTraded={false} />);
    expect(screen.getByText(/GET STARTED/i)).toBeTruthy();
  });

  it("shows all 4 step titles", () => {
    render(<SimOnboarding hasBalance={false} hasTraded={false} />);
    // Use getAllByText since "Connect Wallet" appears as both title and button
    expect(screen.getAllByText(/Connect Wallet/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Get Devnet SOL/i)).toBeTruthy();
    expect(screen.getByText(/Get simUSDC/i)).toBeTruthy();
    expect(screen.getByText(/Start Trading/i)).toBeTruthy();
  });

  it("shows progress bar with /4 denominator", () => {
    render(<SimOnboarding hasBalance={false} hasTraded={false} />);
    expect(screen.getAllByText(/\/4/).length).toBeGreaterThanOrEqual(1);
  });

  it("shows step icons", () => {
    render(<SimOnboarding hasBalance={false} hasTraded={false} />);
    expect(screen.getByText("🔗")).toBeTruthy();
    expect(screen.getByText("⚡")).toBeTruthy();
    expect(screen.getByText("💵")).toBeTruthy();
    expect(screen.getByText("🚀")).toBeTruthy();
  });

  it("has dismiss button", () => {
    render(<SimOnboarding hasBalance={false} hasTraded={false} />);
    const dismissBtn = screen.getByTitle("Dismiss");
    expect(dismissBtn).toBeTruthy();
  });

  it("dismisses and shows reopen button", () => {
    render(<SimOnboarding hasBalance={false} hasTraded={false} />);
    fireEvent.click(screen.getByTitle("Dismiss"));
    // After dismiss, should show ? reopen button
    expect(screen.getByTitle(/getting-started/i)).toBeTruthy();
    expect(mockStorage["percolator_sim_onboarding_dismissed"]).toBe("true");
  });

  it("respects dismissed state from localStorage", () => {
    mockStorage["percolator_sim_onboarding_dismissed"] = "true";
    render(<SimOnboarding hasBalance={false} hasTraded={false} />);
    // Should show reopen button, not full panel
    expect(screen.queryByText(/GET STARTED/i)).toBeNull();
    expect(screen.getByTitle(/getting-started/i)).toBeTruthy();
  });

  it("shows Connect Wallet button when disconnected", () => {
    render(<SimOnboarding hasBalance={false} hasTraded={false} />);
    // The button text inside the StepCard action
    const buttons = screen.getAllByText(/Connect Wallet/i);
    // Should have the title + the button = at least 2
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });
});
