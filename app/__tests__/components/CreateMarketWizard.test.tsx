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
  // v2.2 only (LaunchSuccess reads the share token through it); never called with the flag off.
  useConnectionCompat: () => ({ connection: {} }),
}));

// Mock next/navigation — LaunchSuccess calls useRouter() for post-mint navigation.
// mockPush is a single hoisted fn (not a fresh vi.fn() per render) so the
// GH#2610 tests below can assert on whether/how it was called.
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
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
    expect(screen.getByRole("button", { name: /^Continue$/i })).toBeDefined();
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
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
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
    expect(screen.queryByRole("button", { name: /^Continue$/i })).toBeNull();
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
    marketAddress: "FakeSlab11111111111111111111111111111111111",
    txSigs: ["sig1", "sig2", "sig3", "sig4", "sig5"],
    onDeployAnother: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the 'Ready to trade' heading", () => {
    render(<LaunchSuccess {...defaultProps} />);
    expect(screen.getByText("Ready to trade")).toBeDefined();
  });

  it("shows the token symbol (UX WP-10 §4.2: \"SOL\", never \"SOL-PERP\")", () => {
    render(<LaunchSuccess {...defaultProps} />);
    expect(screen.getAllByText("SOL").length).toBeGreaterThan(0);
    expect(screen.queryByText("SOL-PERP")).toBeNull();
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
    // Fee and leverage are shown in the market preview. v17 slabs have no tier, and a new market is no
    // longer "max capacity" (one asset slot): that phrase must not come back.
    // UX WP-10 (§5.1): fees as a percentage, not bps.
    expect(screen.getAllByText(/0\.30%/).length).toBeGreaterThan(0);
    expect(screen.getByText(/10x/)).toBeDefined();
    expect(screen.queryByText(/max capacity/i)).toBeNull();
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
      // The success screen keeps its actions; the failed price registration is a one-line status
      // with Retry next to them.
      render(
        <LaunchSuccess
          {...defaultProps}
          priceFeedRequired
          keeperPhase="failed"
          keeperDelegated={false}
          keeperMessage="Signature verification failed."
          onRetryKeeperRegistration={onRetry}
        />
      );
      const retryBtn = screen.getByText("Retry");
      fireEvent.click(retryBtn);
      expect(onRetry).toHaveBeenCalledOnce();
    });

    it("disables the retry button and shows a spinner while keeperRegistering is true", () => {
      render(
        <LaunchSuccess
          {...defaultProps}
          priceFeedRequired
          keeperPhase="failed"
          keeperDelegated={false}
          keeperMessage="Signature verification failed."
          onRetryKeeperRegistration={vi.fn()}
          keeperRegistering
        />
      );
      expect(screen.getByText(/Retrying/)).toBeDefined();
      const retryBtn = screen.getByText(/Retrying/).closest("button");
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

  describe("GH#2610: post-creation Sim-USDC claim failure handling", () => {
    const mint = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    it("defect 2: shows no permanent 'in progress' status when there is no claim result yet", () => {
      // The automatic background claim that used to populate this status line is
      // gone (see useCreateMarket.ts) — with only devnetMint set (the normal
      // post-creation state now), there is nothing in flight to report.
      render(<LaunchSuccess {...defaultProps} devnetMint={mint} />);
      expect(screen.queryByText(/Sending Sim-USDC/)).toBeNull();
    });

    it("defect 1: the panel states what Sim-USDC is and where to get it", () => {
      // This test used to render `devnetMintError="Server not configured…"` and
      // assert the real reason appeared instead of a fixed sentence. That fix was
      // correct but UNREACHABLE: removing the automatic claim removed the only
      // writer of devnetAirdropAmount/devnetMintError, which the hook then set to
      // null at its two initial-state sites and nowhere else. Supplying the prop
      // by hand was the only way the branch rendered, so the test passed while
      // production always took the `: null` arm — and the panel showed nothing at
      // all above the Details disclosure.
      //
      // The props are deleted now. Printing the route's real reason is still
      // pinned, on the path that can actually reach it: the button's own failure,
      // in "defect 3" below.
      render(<LaunchSuccess {...defaultProps} devnetMint={mint} />);

      expect(screen.getByText(/is your collateral/i)).toBeDefined();
      const faucet = screen.getByText(/faucet/i).closest("a");
      expect(faucet).toHaveAttribute("href", "/faucet");
      // The old fixed sentence stood in for all ~16 of the route's failure exits —
      // that's what made #2608 take devtools work to extract a real reason.
      expect(screen.queryByText(/use the faucet on the trade page\./)).toBeNull();
    });

    it("defect 3: a genuine claim failure does NOT navigate away, and shows the real reason with an actionable path", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Server not configured for devnet minting" }),
      });
      render(<LaunchSuccess {...defaultProps} devnetMint={mint} />);
      fireEvent.click(screen.getByText("GET SIM-USDC & TRADE →"));

      await screen.findByText(/Server not configured for devnet minting/);
      // GH#1266 made this ALWAYS navigate, so the message above never had a
      // chance to render before the component unmounted — pin the opposite.
      expect(mockPush).not.toHaveBeenCalled();

      const continueLink = screen.getByText("Continue to trade page without claiming →");
      fireEvent.click(continueLink);
      expect(mockPush).toHaveBeenCalledWith(`/trade/${defaultProps.marketAddress}`);
    });

    it("an ALREADY-CLAIMED 429 still navigates — a claim is on record", async () => {
      // The daily claim gate's 429 always carries nextClaimAt — built from
      // `retryAfterSecs` at that exit, and the only paths where retryAfterSecs is
      // null return 503, not 429. (RATE_LIMIT_WINDOW_MS builds the SUCCESS body's
      // nextClaimAt, a different exit.) A claim is on record, so navigating on is
      // right, and this must keep working.
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          error: "Already claimed — try again in 23h 59m",
          nextClaimAt: "2026-01-01T00:00:00Z",
        }),
      });
      render(<LaunchSuccess {...defaultProps} devnetMint={mint} />);
      fireEvent.click(screen.getByText("GET SIM-USDC & TRADE →"));

      await vi.waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(`/trade/${defaultProps.marketAddress}`);
      });
    });

    it("a MIDDLEWARE 429 does not navigate — the route never ran", async () => {
      // middleware.ts rate-limits every /api/* path before the route is reached,
      // so this 429 has a different body and no nextClaimAt. It is the 429 a real
      // creator is most likely to hit, and nothing was minted.
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: "Too many requests. Please try again later." }),
      });
      render(<LaunchSuccess {...defaultProps} devnetMint={mint} />);
      fireEvent.click(screen.getByText("GET SIM-USDC & TRADE →"));

      await screen.findByText(/Too many requests. Please try again later./);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("a 429 with a non-JSON body does not navigate — it fails closed", async () => {
      // A CDN/WAF 429 returns HTML, so resp.json() rejects and the parse falls
      // back to {}. `nextClaimAt` is then undefined, which must read as "no claim
      // on record" rather than throwing or silently navigating.
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
      });
      render(<LaunchSuccess {...defaultProps} devnetMint={mint} />);
      fireEvent.click(screen.getByText("GET SIM-USDC & TRADE →"));

      await screen.findByText(/Sim-USDC claim failed \(HTTP 429\)/);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("a RATE-LIMITED 429 does not navigate — nothing was minted", async () => {
      // The route's per-IP fund limiter: Retry-After, no nextClaimAt, mints
      // nothing. `resp.status === 429` alone treated it as success and sent the
      // creator to the trade page with no collateral and no message.
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: "Too many requests. Please slow down and try again shortly." }),
      });
      render(<LaunchSuccess {...defaultProps} devnetMint={mint} />);
      fireEvent.click(screen.getByText("GET SIM-USDC & TRADE →"));

      await screen.findByText(/Too many requests/);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("a successful claim navigates to the trade page", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ amount: 500, symbol: "USDC", signature: "sig123" }),
      });
      render(<LaunchSuccess {...defaultProps} devnetMint={mint} />);
      fireEvent.click(screen.getByText("GET SIM-USDC & TRADE →"));

      await vi.waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(`/trade/${defaultProps.marketAddress}`);
      });
    });
  });
});
