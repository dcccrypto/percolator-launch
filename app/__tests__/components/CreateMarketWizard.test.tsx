/**
 * CreateMarketWizard tests — focused on LaunchProgress and LaunchSuccess states
 * which are the most critical for error recovery and UX.
 * 
 * We test the sub-components directly to avoid heavy mocking of the full wizard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SystemProgram } from "@solana/web3.js";
import { LaunchProgress } from "@/components/create/LaunchProgress";
import { LaunchSuccess } from "@/components/create/LaunchSuccess";

// Mock next/link for LaunchSuccess
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// LaunchSuccess calls useWalletCompat() for the "Mint & Trade"/"Get Sim-USDC & Trade"
// CTA gate (isDevnet && devnetMint && publicKey). Existing tests never set devnetMint,
// so this fixed publicKey has no effect on them (the condition still short-circuits);
// the new collateral-copy tests below need it non-null to exercise that CTA branch.
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({
    publicKey: SystemProgram.programId,
    connected: true,
    connecting: false,
    wallet: null,
    signTransaction: undefined,
    signAndSendTransaction: undefined,
    signMessage: undefined,
    disconnect: async () => {},
  }),
}));

// Mock next/navigation — LaunchSuccess calls useRouter() for post-mint navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock LogoUpload
vi.mock("@/components/create/LogoUpload", () => ({
  LogoUpload: () => <div data-testid="logo-upload" />,
}));

describe("LaunchProgress", () => {
  const baseState = {
    step: 0,
    loading: false,
    error: null,
    slabAddress: null,
    txSigs: [] as string[],
    stepLabel: "",
  };
  const onReset = vi.fn();
  const onRetry = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders launch heading", () => {
    render(<LaunchProgress state={baseState} onReset={onReset} />);
    expect(screen.getByText("Launching Market")).toBeDefined();
  });

  it("shows signing state for active step", () => {
    render(
      <LaunchProgress
        state={{ ...baseState, step: 0, loading: true, stepLabel: "Creating..." }}
        onReset={onReset}
      />
    );
    expect(screen.getByText("SIGNING...")).toBeDefined();
  });

  it("shows DONE for completed steps", () => {
    render(
      <LaunchProgress
        state={{ ...baseState, step: 3, loading: true, txSigs: ["sig1", "sig2", "sig3"] }}
        onReset={onReset}
      />
    );
    const doneLabels = screen.getAllByText("DONE");
    expect(doneLabels.length).toBe(3);
  });

  it("shows FAILED for errored step", () => {
    render(
      <LaunchProgress
        state={{ ...baseState, step: 1, error: "Something went wrong", slabAddress: "Slab123" }}
        onReset={onReset}
      />
    );
    expect(screen.getByText("FAILED")).toBeDefined();
  });

  it("shows error message and action buttons on failure", () => {
    render(
      <LaunchProgress
        state={{ ...baseState, step: 2, error: "Transaction cancelled" }}
        onReset={onReset}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText("Transaction cancelled")).toBeDefined();
    expect(screen.getByRole("button", { name: /Retry Step 3/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Start Over/i })).toBeDefined();
  });

  it("clicking retry calls onRetry", () => {
    render(
      <LaunchProgress
        state={{ ...baseState, step: 1, error: "Error" }}
        onReset={onReset}
        onRetry={onRetry}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("clicking start over calls onReset", () => {
    render(
      <LaunchProgress
        state={{ ...baseState, step: 1, error: "Error" }}
        onReset={onReset}
        onRetry={onRetry}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Start Over/i }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("hides retry button when onRetry not provided", () => {
    render(
      <LaunchProgress
        state={{ ...baseState, step: 1, error: "Error" }}
        onReset={onReset}
      />
    );
    expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Start Over/i })).toBeDefined();
  });

  it("shows tx signature link for completed steps", () => {
    render(
      <LaunchProgress
        state={{ ...baseState, step: 2, loading: true, txSigs: ["abc12345abcdef"] }}
        onReset={onReset}
      />
    );
    const link = screen.getByText(/tx: abc12345/);
    expect(link.closest("a")?.getAttribute("href")).toContain("abc12345abcdef");
  });

  it("shows step progress text when loading", () => {
    render(
      <LaunchProgress
        state={{ ...baseState, step: 2, loading: true }}
        onReset={onReset}
      />
    );
    expect(screen.getByText(/Step 3 of 6/i)).toBeDefined();
  });

  it("has proper aria attributes for accessibility", () => {
    const { container } = render(
      <LaunchProgress state={baseState} onReset={onReset} />
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-label")).toBe("Market launch progress");
  });

  it("renders all 6 step labels", () => {
    render(<LaunchProgress state={baseState} onReset={onReset} />);
    expect(screen.getByText("Create slab & initialize market")).toBeDefined();
    expect(screen.getByText("Oracle setup & crank")).toBeDefined();
    expect(screen.getByText("Initialize LP")).toBeDefined();
    expect(screen.getByText(/Deposit, insurance & finalize/)).toBeDefined();
    expect(screen.getByText("Create Earn vault")).toBeDefined();
    expect(screen.getByText("Initialize stake pool")).toBeDefined();
  });
});

describe("LaunchSuccess", () => {
  const defaultProps = {
    tokenSymbol: "SOL",
    tradingFeeBps: 30,
    maxLeverage: 10,
    slabLabel: "Small",
    marketAddress: "FakeSlab11111111111111111111111111111111111",
    txSigs: ["sig1", "sig2", "sig3", "sig4", "sig5"],
    onDeployAnother: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows MARKET LAUNCHED heading", () => {
    render(<LaunchSuccess {...defaultProps} />);
    expect(screen.getByText("MARKET LAUNCHED")).toBeDefined();
  });

  it("shows token symbol in PERP format", () => {
    render(<LaunchSuccess {...defaultProps} />);
    expect(screen.getByText("SOL-PERP")).toBeDefined();
  });

  it("shows market address with copy and explorer buttons", () => {
    render(<LaunchSuccess {...defaultProps} />);
    expect(screen.getByText(defaultProps.marketAddress)).toBeDefined();
    expect(screen.getByTitle("Copy address")).toBeDefined();
    expect(screen.getByTitle("View on Solscan")).toBeDefined();
  });

  it("shows trade and deploy another CTAs", () => {
    render(<LaunchSuccess {...defaultProps} />);
    const tradeLink = screen.getByText("TRADE THIS MARKET →");
    expect(tradeLink.closest("a")?.getAttribute("href")).toContain(defaultProps.marketAddress);
    expect(screen.getByText("DEPLOY ANOTHER MARKET")).toBeDefined();
  });

  it("shows transaction signatures with explorer links", () => {
    // The success screen had grown into a wall of text, so the tx links moved
    // into the "Details" disclosure (still rendered in the DOM — <details>
    // content is present, just visually collapsed) and shortened from
    // "Step N: <sig>… ↗" to "tx N ↗". The contract this test guards is
    // unchanged: one explorer link per landed transaction.
    render(<LaunchSuccess {...defaultProps} devnetMint="DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC" />);
    for (let i = 0; i < 5; i++) {
      const link = screen.getByText(new RegExp(`^tx ${i + 1}\\s`));
      expect(link).toBeDefined();
      expect(link.getAttribute("href")).toContain(defaultProps.txSigs[i]);
    }
  });

  it("clicking deploy another calls onDeployAnother", () => {
    render(<LaunchSuccess {...defaultProps} />);
    fireEvent.click(screen.getByText("DEPLOY ANOTHER MARKET"));
    expect(defaultProps.onDeployAnother).toHaveBeenCalledOnce();
  });

  it("shows market preview card with parameters", () => {
    render(<LaunchSuccess {...defaultProps} />);
    // Fee, leverage, and slab tier are shown in the market preview
    expect(screen.getByText(/30 bps/)).toBeDefined();
    expect(screen.getByText(/10x/)).toBeDefined();
    expect(screen.getByText(/Small/)).toBeDefined();
  });

  it("copy button changes to checkmark on click", async () => {
    // Mock clipboard
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    render(<LaunchSuccess {...defaultProps} />);
    const copyBtn = screen.getByTitle("Copy address");
    expect(copyBtn.textContent).toBe("copy");

    fireEvent.click(copyBtn);
    // After click, should show checkmark
    await vi.waitFor(() => {
      expect(copyBtn.textContent).toBe("✓");
    });
  });

  describe("keeper registration retry (2026-07-09 fix)", () => {
    it("shows a Retry registration button when registration failed and a retry handler is provided", () => {
      const onRetry = vi.fn();
      render(
        <LaunchSuccess
          {...defaultProps}
          keeperDelegated={false}
          keeperMessage="Signature verification failed."
          onRetryKeeperRegistration={onRetry}
        />
      );
      const retryBtn = screen.getByText("RETRY REGISTRATION");
      fireEvent.click(retryBtn);
      expect(onRetry).toHaveBeenCalledOnce();
    });

    it("disables the retry button and shows a spinner while keeperRegistering is true", () => {
      render(
        <LaunchSuccess
          {...defaultProps}
          keeperDelegated={false}
          keeperMessage="Signature verification failed."
          onRetryKeeperRegistration={vi.fn()}
          keeperRegistering
        />
      );
      expect(screen.getByText(/RETRYING/)).toBeDefined();
      const retryBtn = screen.getByText(/RETRYING/).closest("button");
      expect(retryBtn?.hasAttribute("disabled")).toBe(true);
    });

    it("does not show a retry button when registration succeeded", () => {
      render(
        <LaunchSuccess
          {...defaultProps}
          keeperDelegated
          keeperMessage="Registered."
          onRetryKeeperRegistration={vi.fn()}
        />
      );
      expect(screen.queryByText("RETRY REGISTRATION")).toBeNull();
    });

    it("does not show a retry button when no retry handler is provided", () => {
      render(
        <LaunchSuccess
          {...defaultProps}
          keeperDelegated={false}
          keeperMessage="Signature verification failed."
        />
      );
      expect(screen.queryByText("RETRY REGISTRATION")).toBeNull();
    });
  });

  describe("collateral copy accuracy (2026-07-09 fix)", () => {
    const simUsdcMint = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

    it("frames the airdropped mint as Sim-USDC collateral, not the launched token", () => {
      render(
        <LaunchSuccess
          {...defaultProps}
          mainnetCA="9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump"
          devnetMint={simUsdcMint}
          devnetAirdropAmount={500}
          devnetAirdropSymbol="USDC"
        />
      );
      // The "COLLATERAL & PRICING" heading is gone — that whole explainer now
      // lives inside the "Details" disclosure (text-trim pass). The mint and
      // the framing copy it guards are still rendered.
      expect(screen.getByText(simUsdcMint)).toBeDefined();
      // The old copy claimed devnet used "a different mint address than mainnet"
      // for the launched token — that framing must be gone.
      expect(screen.queryByText(/different mint address/i)).toBeNull();
      expect(screen.queryByText(/Airdropped/)).toBeNull();
      // New copy explains the token is a price reference, not something you hold.
      expect(screen.getByText(/price reference only/)).toBeDefined();
    });

    it("shows a Sim-USDC-flavored CTA instead of 'MINT & TRADE'", () => {
      render(
        <LaunchSuccess
          {...defaultProps}
          devnetMint={simUsdcMint}
        />
      );
      expect(screen.queryByText("MINT & TRADE →")).toBeNull();
      expect(screen.getByText(/SIM-USDC/)).toBeDefined();
    });
  });
});
