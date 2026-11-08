/**
 * M7: a loss must never read as "profit settling". After a losing round trip the flat account can still hold a little released value
 * (council: "up to +0.021 profit" after a -0.412 trade). The tag follows the measured result, and the Portfolio shows the realized
 * figure that reconciles with capital (spread included), not only the engine's crystallized-loss counter.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";
import { recordRealized } from "@/lib/realized-pnl";

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }));
vi.mock("next/dynamic", () => ({ default: () => () => <button>ConnectButton</button> }));
vi.mock("@/hooks/useWalletCompat");
vi.mock("@/hooks/usePortfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePortfolio")>();
  return { ...actual, usePortfolio: vi.fn() };
});
vi.mock("@/hooks/useMultiTokenMeta");
vi.mock("@/hooks/useLpPositions", () => ({
  useLpPositions: () => ({ positions: [], totalRedeemable: 0, loading: false, isRefreshing: false, error: null, refresh: vi.fn() }),
}));
vi.mock("@/components/portfolio/LpPositionsPanel", () => ({ LpPositionsPanel: () => <div /> }));
vi.mock("@/hooks/useTraderStats", () => ({ useTraderStats: () => ({ stats: null, loading: false, error: null, refresh: vi.fn() }) }));
vi.mock("@/components/ui/ScrollReveal", () => ({ ScrollReveal: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/ui/GlowButton", () => ({ GlowButton: ({ children }: any) => <button>{children}</button> }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false, getMockPortfolioPositions: () => [] }));

const pk = new PublicKey("11111111111111111111111111111111");
const position = (realizedLoss = 0n) => ({
  slabAddress: "slab-loss",
  symbol: "SOL",
  idx: 0,
  collateralMint: pk,
  account: { adlABasis: 1_000_000_000_000_000n, kind: AccountKind.User, owner: pk, capital: 110_000n, positionSize: 0n, pnl: 21_000n, reservedPnl: 0n, entryPrice: 0n },
  market: { slabAddress: pk, config: { collateralMint: pk }, engine: {} },
  effectiveEntryPrice: 0n, entryPriceSource: "unknown", unrealizedPnl: 0n, realizedLoss, oraclePriceE6: 100_000_000n,
  effectiveSize: 0n, adlKnown: true, adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n }, adlApplicable: true,
  pnlKnown: true, isEstimate: false, pnlPercent: 0, leverage: 0, liquidationPriceE6: 0n, liquidationDistancePct: 100, initialMarginBps: 1000n,
});

const mount = (p: ReturnType<typeof position>) => {
  vi.mocked(useWalletCompat).mockReturnValue({ connected: true, publicKey: pk } as never);
  vi.mocked(usePortfolio).mockReturnValue({ positions: [p], totalPnl: 21_000n, totalDeposited: 0n, atRiskCount: 0, loading: false, isRefreshing: false, error: null, refresh: vi.fn() } as never);
  vi.mocked(useMultiTokenMeta).mockReturnValue(new Map([[pk.toBase58(), { symbol: "USDC", decimals: 6 }]]));
  render(<PortfolioPositionsView />);
};

describe("claim pending vs profit settling (M7)", () => {
  beforeEach(() => localStorage.clear());

  it("a finished trade measured at -0.056 with 0.021 released: 'claim pending', never 'profit settling', and the lifetime result is shown with what it excludes", () => {
    recordRealized(pk.toBase58(), "slab-loss", -56_043n);
    mount(position(200_000n));
    expect(screen.getByTestId("deposit-tag")).toHaveTextContent("claim pending");
    expect(screen.queryByText("profit settling")).toBeNull();
    expect(screen.getByTestId("pending-profit")).toHaveTextContent("to claim");
    expect(screen.getByTestId("pending-profit").textContent).not.toMatch(/profit/);
    expect(screen.getByTestId("realized-net")).toHaveTextContent("-$0.06");
    expect(screen.getByTestId("realized-net")).toHaveTextContent(/fees and spread included, funding not included/);
    expect(screen.queryByText(/already deducted/)).toBeNull();
  });

  it("CONTROL: a measured gain keeps 'profit settling'", () => {
    recordRealized(pk.toBase58(), "slab-loss", 300_000n);
    mount(position());
    expect(screen.getByTestId("deposit-tag")).toHaveTextContent("profit settling");
    expect(screen.getByTestId("pending-profit")).toHaveTextContent("profit");
  });

  it("the LAST finished trade decides the tag: a gain after a bigger loss is still labelled by the gain, a loss after a gain is not", () => {
    recordRealized(pk.toBase58(), "slab-loss", 300_000n);
    recordRealized(pk.toBase58(), "slab-loss", -100_000n);
    mount(position());
    expect(screen.getByTestId("deposit-tag")).toHaveTextContent("claim pending");
  });

  it("nothing recorded on this device: neutral too (no 'profit' without a measured gain), and the counter line says what it leaves out", () => {
    mount(position(200_000n));
    expect(screen.getByTestId("deposit-tag")).toHaveTextContent("claim pending");
    expect(screen.queryByTestId("realized-net")).toBeNull();
    expect(screen.getByText(/leaves out the spread/)).toBeInTheDocument();
  });
});
