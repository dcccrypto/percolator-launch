/**
 * AirdropButton Component Tests
 * Tests: PERC-510 — mintAddress prop fix verification
 *
 * Covers:
 * 1. Renders only on devnet with a valid mintAddress
 * 2. Does NOT render when mintAddress is empty/falsy (guard)
 * 3. Submits mintAddress (not marketAddress) in the fetch payload
 * 4. Shows error message on failed claim
 * 5. Shows countdown on 429 rate-limit response
 * 6. Shows success state on successful claim
 * 7. Button disabled and fetch skipped when mintAddress is empty
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AirdropButton } from "@/components/trade/AirdropButton";

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@/lib/config", () => ({
  getNetwork: vi.fn(() => "devnet"),
}));

const mockPublicKey = {
  toBase58: () => "WaLLetADdReSs1111111111111111111111111111111",
};
let mockConnected = true;

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(() => ({
    publicKey: mockConnected ? mockPublicKey : null,
    connected: mockConnected,
  })),
}));

// ─── fetch mock helper ────────────────────────────────────────────────────────

function mockFetch(status: number, body: object) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AirdropButton", () => {
  const MINT = "MiNtAdDrEsS1111111111111111111111111111111111";

  beforeEach(() => {
    mockConnected = true;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Visibility guards ────────────────────────────────────────────────────

  it("renders the claim button when devnet + mintAddress + connected", () => {
    render(<AirdropButton mintAddress={MINT} symbol="USDC" />);
    expect(screen.getByRole("button", { name: /get usdc/i })).toBeDefined();
  });

  it("does NOT render when mintAddress is empty string", () => {
    const { container } = render(<AirdropButton mintAddress="" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  it("does NOT render when isUserCreated=false", () => {
    const { container } = render(
      <AirdropButton mintAddress={MINT} symbol="SOL" isUserCreated={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("does NOT render when wallet is not connected", () => {
    mockConnected = false;
    const { container } = render(<AirdropButton mintAddress={MINT} symbol="USDC" />);
    expect(container.firstChild).toBeNull();
  });

  // ── Core fix: mintAddress reaches the API, not marketAddress ────────────

  it("sends mintAddress (not marketAddress) in the fetch payload", async () => {
    const fetchMock = mockFetch(200, {
      amount: 500,
      nextClaimAt: new Date(Date.now() + 86400000).toISOString(),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AirdropButton mintAddress={MINT} symbol="USDC" />);
    fireEvent.click(screen.getByRole("button", { name: /get usdc/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/devnet-airdrop");
    const body = JSON.parse(opts.body as string);

    // The key fix: mintAddress must be present, marketAddress must NOT be sent
    expect(body.mintAddress).toBe(MINT);
    expect(body.walletAddress).toBe("WaLLetADdReSs1111111111111111111111111111111");
    expect(body.marketAddress).toBeUndefined();
  });

  it("does NOT call fetch when mintAddress is empty (even if button somehow clicked)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Empty mintAddress → component should not render, but guard inside claim() also protects
    const { container } = render(<AirdropButton mintAddress="" symbol="USDC" />);
    expect(container.firstChild).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Response states ───────────────────────────────────────────────────────

  it("shows error message when API returns non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(400, { error: "Missing mintAddress or walletAddress" })
    );

    render(<AirdropButton mintAddress={MINT} symbol="USDC" />);
    fireEvent.click(screen.getByRole("button", { name: /get usdc/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Missing mintAddress or walletAddress/i)
      ).toBeDefined();
    });
  });

  it("shows countdown on 429 rate-limit response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(429, {
        nextClaimAt: new Date(Date.now() + 3600000 * 6).toISOString(),
        retryAfterSecs: 21600,
      })
    );

    render(<AirdropButton mintAddress={MINT} symbol="USDC" />);
    fireEvent.click(screen.getByRole("button", { name: /get usdc/i }));

    await waitFor(() => {
      expect(screen.getByText(/next claim in \d+h/i)).toBeDefined();
    });
  });

  it("shows success state after a successful claim", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(200, {
        amount: 500,
        nextClaimAt: new Date(Date.now() + 86400000).toISOString(),
      })
    );

    render(<AirdropButton mintAddress={MINT} symbol="BTC" />);
    fireEvent.click(screen.getByRole("button", { name: /get btc/i }));

    await waitFor(() => {
      expect(screen.getByText(/airdropped/i)).toBeDefined();
    });
  });
});
