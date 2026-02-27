/**
 * CreateMarketWizard tests — focused on LaunchProgress and LaunchSuccess states
 * which are the most critical for error recovery and UX.
 * 
 * We test the sub-components directly to avoid heavy mocking of the full wizard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LaunchProgress } from "@/components/create/LaunchProgress";
import { LaunchSuccess } from "@/components/create/LaunchSuccess";

// Mock next/link for LaunchSuccess
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
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
    expect(screen.getByText(/Step 3 of 5/i)).toBeDefined();
  });

  it("has proper aria attributes for accessibility", () => {
    const { container } = render(
      <LaunchProgress state={baseState} onReset={onReset} />
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-label")).toBe("Market launch progress");
  });

  it("renders all 5 step labels", () => {
    render(<LaunchProgress state={baseState} onReset={onReset} />);
    expect(screen.getByText("Create slab & initialize market")).toBeDefined();
    expect(screen.getByText("Oracle setup & crank")).toBeDefined();
    expect(screen.getByText("Initialize LP")).toBeDefined();
    expect(screen.getByText(/Deposit, insurance & finalize/)).toBeDefined();
    expect(screen.getByText("Insurance LP mint")).toBeDefined();
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
    render(<LaunchSuccess {...defaultProps} />);
    for (let i = 0; i < 5; i++) {
      expect(screen.getByText(new RegExp(`Step ${i + 1}:`))).toBeDefined();
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
});
