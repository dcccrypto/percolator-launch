/**
 * #3266: what My Markets shows for each state a launch can stop in. The row is rendered for real;
 * only wallet / chain hooks and heavy children are stubbed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ complete: false }));
vi.mock("@/lib/market-completeness", () => ({ isMarketauthComplete: () => h.complete }));
vi.mock("@/components/providers/SlabProvider", () => ({ SlabProvider: ({ children }: { children: unknown }) => children, useSlabState: () => ({ assetProfile: null }) }));
vi.mock("@/components/market/CreatorClaimPanel", () => ({ CreatorClaimPanel: () => null }));
vi.mock("@/components/create/LogoUpload", () => ({ LogoUpload: () => null }));
vi.mock("@/components/limits/CreatorLimits", () => ({ CreatorTranchePanel: () => null }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/hooks/useAdminActions", () => ({ useAdminActions: () => ({ loading: null }) }));
vi.mock("@/hooks/useCloseMarket", () => ({ useCloseMarket: () => ({ closeSlab: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useClaimCreatorFees", () => ({ useClaimCreatorFees: () => ({ claim: vi.fn(), busy: false, outcomes: [] }) }));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const WALLET = new PublicKey("EXC8LS3YzsbyadhaQPqaeGjb2ttfGgDLno9jeCFWqqyi");
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: WALLET }) }));
vi.mock("@/lib/priceStore/priceStore", () => ({ subscribeSlab: () => () => {}, getSnapshot: () => ({ priceUsd: null }) }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getConfig: () => ({ network: "devnet", explorerUrl: "https://explorer.solana.com" }) }));

import { CreatorMarketRow } from "@/components/my-markets/CreatorMarketRow";

const SLAB = new PublicKey("GrKZUtyeaqbg1Q1J1kPWznui92sbLpX5F62LrBVGkifL");
const slab = SLAB.toBase58();
const mkt = (launch?: { mode: number; cTot: bigint; portfolios: bigint; backingFunded?: boolean }, insurance = 0n) =>
  ({
    slabAddress: SLAB,
    programId: PublicKey.default,
    label: "USDC",
    config: undefined,
    configV17: { oracleMode: 3, markEwmaE6: 0n, markEwmaLastSlot: 0n, invert: 0, unitScale: 1_000_000, collateralMint: PublicKey.default, marketauth: WALLET },
    v17Stats: { oi: { insuranceBalance: insurance, totalLongOiQ: 0n, totalShortOiQ: 0n, assets: [] }, assetSlotLast: null, launch },
  }) as never;
const placeholderDetail = { slab_address: slab, symbol: "UNKNOWN", name: "Market GrKZUtye", creator_fee_authority: WALLET.toBase58(), creator_fee_claimable_atoms: "0" } as never;

const renderRow = (m: never, detail: unknown = placeholderDetail, expanded = true) =>
  render(<CreatorMarketRow market={m} detail={detail as never} identity={null} chainCurrentSlot={null} expanded={expanded} onToggleExpand={() => {}} />);

beforeEach(() => {
  h.complete = false;
  window.localStorage.clear();
});

describe("My Markets: an unfinished launch", () => {
  it("is not called UNKNOWN: it reads 'Launch unfinished'", () => {
    renderRow(mkt({ mode: 0, cTot: 0n, portfolios: 0n }), placeholderDetail, false);
    expect(screen.getByText("Launch unfinished")).toBeTruthy();
    expect(screen.queryByText("UNKNOWN")).toBeNull();
  });

  it("uses the real symbol when the launching browser saved it, with an unfinished marker", () => {
    window.localStorage.setItem(`perc.keeperPayload.${slab}`, JSON.stringify({ symbol: "AUTON", name: "auton" }));
    renderRow(mkt({ mode: 0, cTot: 0n, portfolios: 0n }), placeholderDetail, false);
    expect(screen.getByText("AUTON")).toBeTruthy();
    expect(screen.getByTestId("unfinished-pill").textContent).toMatch(/launch unfinished/i);
  });

  it("created only / oracle handed off: Continue + Reclaim rent, and a reclaim dialog that never says 'close UNKNOWN market'", () => {
    renderRow(mkt({ mode: 0, cTot: 0n, portfolios: 0n }));
    expect(screen.getByTestId("unfinished-launch-panel").dataset.stage).toBe("removable");
    expect(screen.getByTestId("unfinished-continue").getAttribute("href")).toBe(`/create?resume=${slab}`);
    fireEvent.click(screen.getByTestId("unfinished-reclaim"));
    expect(screen.getByText("Reclaim rent from this unfinished launch")).toBeTruthy();
    expect(screen.queryByText(/Close .* market/)).toBeNull();
    // removable: the dialog may say what was found
    expect(screen.getByText("Remove this unfinished launch and get back its rent. No funds, portfolio or backing were found on it. You can't reopen it.")).toBeTruthy();
  });

  it("LP initialised (a portfolio, nothing deposited): Continue only, no close, no funds claim", () => {
    renderRow(mkt({ mode: 0, cTot: 0n, portfolios: 1n }));
    expect(screen.getByTestId("unfinished-launch-panel").dataset.stage).toBe("committed");
    expect(screen.queryByTestId("unfinished-reclaim")).toBeNull();
    expect(screen.queryByTestId("close-market-button")).toBeNull();
    expect(screen.getByTestId("unfinished-launch-copy").textContent).not.toMatch(/funds went in/);
  });

  it("funded / vault created: told it can't be removed and to finish it; no close button, no dead-end checklist", () => {
    renderRow(mkt({ mode: 0, cTot: 1_000_000_000n, portfolios: 2n }, 50_000_000n));
    expect(screen.getByTestId("unfinished-launch-copy").textContent).toBe(
      "It stopped after its funds went in, so it can't be removed from here. The only way forward from here is to finish it from Create Market. Nothing about your funds has changed, and they are not lost.",
    );
    expect(screen.queryByTestId("unfinished-reclaim")).toBeNull();
    expect(screen.queryByTestId("close-market-button")).toBeNull();
    expect(screen.queryByTestId("close-market-checklist")).toBeNull();
    expect(screen.queryByText("The market's insurance fund still holds funds.")).toBeNull();
    expect(screen.getByTestId("unfinished-continue")).toBeTruthy();
  });

  it("backing funded, everything else zero: Continue only (it would otherwise look removable)", () => {
    renderRow(mkt({ mode: 0, cTot: 0n, portfolios: 0n, backingFunded: true }));
    expect(screen.getByTestId("unfinished-launch-panel").dataset.stage).toBe("committed");
    expect(screen.queryByTestId("unfinished-reclaim")).toBeNull();
  });

  it("not read yet: Continue only; the dialog never claims nothing was deposited", () => {
    renderRow(mkt(undefined));
    expect(screen.getByTestId("unfinished-launch-panel").dataset.stage).toBe("unknown");
    expect(screen.queryByTestId("unfinished-reclaim")).toBeNull();
    // the drawer's own reclaim button still exists while the read is pending: its dialog claims nothing
    fireEvent.click(screen.getByTestId("close-market-button"));
    expect(screen.getByText("Remove this unfinished launch and get back its rent. You can't reopen it.")).toBeTruthy();
    expect(screen.queryByText(/Nothing was deposited|No funds, portfolio or backing/)).toBeNull();
  });
});

describe("My Markets: a finished market", () => {
  it("finished and registered: no unfinished panel, the normal close button and name", () => {
    h.complete = true;
    renderRow(mkt({ mode: 0, cTot: 1n, portfolios: 2n }, 5n), { ...(placeholderDetail as object), symbol: "AUTON" });
    expect(screen.queryByTestId("unfinished-launch-panel")).toBeNull();
    expect(screen.getByText("AUTON")).toBeTruthy();
    expect(screen.getByTestId("close-market-button").textContent).toBe("close market");
  });

  it("finished but unregistered (still on the placeholder): 'Unnamed market', not UNKNOWN and not the collateral symbol", () => {
    h.complete = true;
    renderRow(mkt({ mode: 0, cTot: 1n, portfolios: 2n }, 5n), placeholderDetail, false);
    expect(screen.getByText("Unnamed market")).toBeTruthy();
    expect(screen.queryByText("UNKNOWN")).toBeNull();
    expect(screen.queryByText("USDC")).toBeNull();
    expect(screen.queryByTestId("unfinished-pill")).toBeNull();
  });
});
