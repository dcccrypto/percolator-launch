/**
 * #3615 / #3600 follow-up: the Earn hub's rail (/earn -> EarnHubPage -> EarnVaultView -> VaultDepositRail) rendered
 * DepositWithdrawPanel without `exitV22`, so on v2.2 a pending, cooldown-elapsed redemption was collected by the
 * legacy bare tag 77 ("Finish withdrawal"): a stored floor above today's payout is refused 117 on every click and the
 * hub never offered the cancel-and-request-again way out (it lives only in PendingClaimV22). Same for the withdraw tab:
 * no quote-first exit, and a cooldown-0 withdraw signed the 10% request floor instead of the quoted one.
 * The real rail + the real panel; only the chain reads and the exit hook are stubbed.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const SLAB = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const PROGRAM = new PublicKey("11111111111111111111111111111113");
const MINT = new PublicKey("11111111111111111111111111111114");
const WALLET = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");

const h = vi.hoisted(() => ({
  lp: {} as Record<string, unknown>,
  slabLoaded: true,
  resizeRedemption: vi.fn(async (_shares: bigint) => "sig"),
  refreshState: vi.fn(async () => {}),
  withdraw: vi.fn(async () => ({ step: "executed" as const, signature: "sig" })),
  exitApi: null as unknown,
  useEarnExitV22: vi.fn(),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: React.ReactNode }) => children,
  useSlabState: () => (h.slabLoaded ? { config: { collateralMint: MINT }, raw: null, programId: PROGRAM } : { config: null, raw: null, programId: null }),
}));
vi.mock("@/hooks/useInsuranceLP", () => ({
  useInsuranceLP: () => ({
    state: h.lp, loading: false, readError: false, deposit: vi.fn(), withdraw: h.withdraw,
    resizeRedemption: h.resizeRedemption, refreshState: h.refreshState, lastDrawSummary: null,
  }),
}));
vi.mock("@/hooks/useEarnExitV22", () => ({ useEarnExitV22: (p: unknown) => h.useEarnExitV22(p) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: WALLET, connected: true }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/hooks/useLpShareToken", () => ({ useLpShareToken: () => ({ decimals: 6, metadataPresent: true }) }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => ({ vaultLp: null, vaultState: null, registryShares: null, engine: null, lpRealQ: null }) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/hooks/useVaultLpValuation", () => ({ useVaultLpValuation: () => ({ value: null, sim: null }) }));
vi.mock("@/lib/limits/earn", () => ({
  earnDepositPause: () => null, earnGateShares: () => null, earnViewFromLimits: () => null,
  earnPanelPricing: () => null, withSplitPotPricing: () => null,
}));
vi.mock("@/lib/limits/resolved-finish", () => ({ earnExitProps: () => ({}) }));
vi.mock("@/components/limits/EarnTrancheCard", () => ({ EarnTrancheCardView: () => null }));
vi.mock("@/components/limits/ResolvedExitPanel", () => ({ ResolvedExitPanel: () => null }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/earn/BondCard", () => ({ BondCard: () => null }));
vi.mock("@/components/earn/RescueAction", () => ({ RescueAction: () => null }));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick, ...rest }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void; "data-testid"?: string }) => (
    <button disabled={disabled} onClick={onClick} data-testid={rest["data-testid"]}>{children}</button>
  ),
}));

import { VaultDepositRail } from "@/components/earn/VaultDepositRail";

const PENDING = 9_523_809n;
const lpState = (o: Record<string, unknown> = {}) => ({
  registryExists: true, mintExists: true, vaultTotalAtoms: 1_000_000_000n, lpSupply: 1_000_000_000n, userVaultValueAtoms: 0n,
  userCollateralBalance: 500_000_000n, userLpBalance: 0n, pendingRedemptionShares: PENDING, hasPendingRedemption: true,
  cooldownElapsed: true, cooldownRemainingSlots: 0n, redemptionCooldownSlots: 150n, userSharePct: 0, backingNavAtoms: 1_000_000_000n,
  splitPot: null, lpVaultDomain: 1, lpDecimals: 6, ...o,
});
const api = (phase: string, extra: Record<string, unknown> = {}) => ({
  state: { phase, quote: null, requoted: false, message: phase === "error" ? "The price fell below your request's minimum." : null, signature: null, ...extra },
  getQuote: vi.fn(), confirm: vi.fn(), reset: vi.fn(),
});
const openWithdraw = () => fireEvent.click(screen.getAllByTestId("earn-tab").find((t) => t.dataset.tab === "withdraw")!);

beforeEach(() => {
  h.lp = lpState();
  h.slabLoaded = true;
  h.resizeRedemption.mockClear();
  h.refreshState.mockClear();
  h.withdraw.mockClear();
  h.exitApi = api("error", { floorStuck: true });
  h.useEarnExitV22.mockReset();
  h.useEarnExitV22.mockImplementation(() => h.exitApi);
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

describe("Earn hub rail on v2.2: pending, cooldown-elapsed, floor-stuck redemption", () => {
  it("collects through the v2.2 quote (execute mode, this vault's market / program / mint / pot), not the legacy 77", () => {
    __setDevnetV22ForTest(true);
    render(<VaultDepositRail slab={SLAB} vault={null} />);
    expect(screen.getByTestId("earn-pending-claim-v22")).toBeInTheDocument();
    expect(screen.queryByTestId("earn-withdraw-execute")).toBeNull();
    const p = h.useEarnExitV22.mock.calls.find((c) => c[0].mode === "execute")![0];
    expect(p.shares).toBe(PENDING);
    expect(p.market.toBase58()).toBe(SLAB);
    expect(p.programId.equals(PROGRAM)).toBe(true);
    expect(p.collateralMint.equals(MINT)).toBe(true);
    expect(p.sourceDomain).toBe(1); // the registry's own pot, not a hard-coded 0
  });

  it("offers 'Cancel and request again at today's price', which re-requests the pending shares and re-reads the vault", async () => {
    __setDevnetV22ForTest(true);
    const onTxSuccess = vi.fn();
    render(<VaultDepositRail slab={SLAB} vault={null} onTxSuccess={onTxSuccess} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("earn-pending-rerequest-v22"));
    });
    expect(h.resizeRedemption).toHaveBeenCalledWith(PENDING);
    expect(h.refreshState).toHaveBeenCalled();
    expect((h.exitApi as ReturnType<typeof api>).reset).toHaveBeenCalled();
    expect(h.withdraw).not.toHaveBeenCalled(); // never the legacy bare 77
  });

  it("withdraw tab, cooldown-0 vault: the quote-first exit in one transaction (pair), no one-step legacy button", () => {
    __setDevnetV22ForTest(true);
    h.lp = lpState({ hasPendingRedemption: false, pendingRedemptionShares: 0n, userLpBalance: 100_000_000n, redemptionCooldownSlots: 0n });
    h.exitApi = api("idle");
    render(<VaultDepositRail slab={SLAB} vault={null} />);
    openWithdraw();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "10" } });
    expect(screen.getByTestId("earn-exit-get-quote")).toBeInTheDocument();
    expect(screen.queryByTestId("earn-withdraw-request")).toBeNull();
    expect(h.useEarnExitV22.mock.calls.at(-1)![0]).toMatchObject({ mode: "pair", sourceDomain: 1 });
  });

  it("withdraw tab, cooldown vault: the quote-first request (request mode)", () => {
    __setDevnetV22ForTest(true);
    h.lp = lpState({ hasPendingRedemption: false, pendingRedemptionShares: 0n, userLpBalance: 100_000_000n });
    h.exitApi = api("idle");
    render(<VaultDepositRail slab={SLAB} vault={null} />);
    openWithdraw();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "10" } });
    expect(screen.getByTestId("earn-exit-get-quote")).toBeInTheDocument();
    expect(h.useEarnExitV22.mock.calls.at(-1)![0]).toMatchObject({ mode: "request" });
    expect(screen.queryByTestId("earn-withdraw-request")).toBeNull();
  });

  // A fix gated on the slab having loaded (e.g. on v22Ctx) would fall back to the legacy one-step button, and its 10% floor,
  // while SlabProvider is still reading the market after a vault switch.
  it("flag on, market not read yet (vault switch): never the legacy one-step withdraw", () => {
    __setDevnetV22ForTest(true);
    h.slabLoaded = false;
    h.lp = lpState({ hasPendingRedemption: false, pendingRedemptionShares: 0n, userLpBalance: 100_000_000n, redemptionCooldownSlots: 0n });
    h.exitApi = api("idle");
    render(<VaultDepositRail slab={SLAB} vault={null} />);
    openWithdraw();
    expect(screen.getByTestId("earn-exit-v22")).toBeInTheDocument();
    expect(screen.queryByTestId("earn-withdraw-request")).toBeNull();
  });

  it("CONTROL: still counting down keeps the countdown card", () => {
    __setDevnetV22ForTest(true);
    h.lp = lpState({ cooldownElapsed: false, cooldownRemainingSlots: 150n });
    render(<VaultDepositRail slab={SLAB} vault={null} />);
    expect(screen.getByTestId("earn-pending-withdrawal").dataset.phase).toBe("counting");
    expect(screen.queryByTestId("earn-pending-claim-v22")).toBeNull();
  });

  it("CONTROL flag off: the hub stays on the legacy 'Finish withdrawal' claim and never mounts the v2.2 hook", () => {
    __setDevnetV22ForTest(false);
    render(<VaultDepositRail slab={SLAB} vault={null} />);
    expect(screen.getByTestId("earn-withdraw-execute")).toBeInTheDocument();
    expect(screen.queryByTestId("earn-pending-claim-v22")).toBeNull();
    expect(h.useEarnExitV22).not.toHaveBeenCalled();
  });
});

describe("Earn hub rail on v2.2: after an exit lands", () => {
  it("collect sent: re-reads the vault and refreshes the table once (the legacy path did both)", () => {
    __setDevnetV22ForTest(true);
    h.exitApi = api("sent", { signature: "sig" });
    const onTxSuccess = vi.fn();
    const { rerender } = render(<VaultDepositRail slab={SLAB} vault={null} onTxSuccess={onTxSuccess} />);
    expect(screen.getByTestId("earn-pending-claim-v22")).toBeInTheDocument();
    expect(h.refreshState).toHaveBeenCalledTimes(1);
    expect(onTxSuccess).toHaveBeenCalledTimes(1);
    rerender(<VaultDepositRail slab={SLAB} vault={null} onTxSuccess={onTxSuccess} />);
    expect(onTxSuccess).toHaveBeenCalledTimes(1); // once per landing, not per render
    h.exitApi = api("sent", { signature: "sig2" }); // a later exit lands
    rerender(<VaultDepositRail slab={SLAB} vault={null} onTxSuccess={onTxSuccess} />);
    expect(onTxSuccess).toHaveBeenCalledTimes(2);
  });
  it("withdraw sent: the form clears, the vault is re-read, the table refreshed", () => {
    __setDevnetV22ForTest(true);
    h.lp = lpState({ hasPendingRedemption: false, pendingRedemptionShares: 0n, userLpBalance: 100_000_000n, redemptionCooldownSlots: 0n });
    h.exitApi = api("idle");
    const onTxSuccess = vi.fn();
    const { rerender } = render(<VaultDepositRail slab={SLAB} vault={null} onTxSuccess={onTxSuccess} />);
    openWithdraw();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "10" } });
    expect(onTxSuccess).not.toHaveBeenCalled();
    h.exitApi = api("sent", { signature: "sig" });
    rerender(<VaultDepositRail slab={SLAB} vault={null} onTxSuccess={onTxSuccess} />);
    expect(h.refreshState).toHaveBeenCalledTimes(1);
    expect(onTxSuccess).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("earn-withdraw-input") as HTMLInputElement).value).toBe("");
  });
  it("collect sent: once the re-read drops the pending request, the 'Sent ≈ X to your wallet.' line stays", () => {
    __setDevnetV22ForTest(true);
    h.exitApi = api("sent", { signature: "sig" });
    const { rerender } = render(<VaultDepositRail slab={SLAB} vault={null} />);
    h.lp = lpState({ hasPendingRedemption: false, pendingRedemptionShares: 0n });
    rerender(<VaultDepositRail slab={SLAB} vault={null} />);
    expect(screen.queryByTestId("earn-pending-claim-v22")).toBeNull();
    expect(screen.getByTestId("earn-withdraw-sent").textContent).toMatch(/^Sent ≈ 9\.52 .* to your wallet\.$/);
  });
  it("collect sent while a deposit amount is typed: the deposit input keeps it", () => {
    __setDevnetV22ForTest(true);
    h.exitApi = api("idle");
    const { rerender } = render(<VaultDepositRail slab={SLAB} vault={null} />);
    fireEvent.change(screen.getByTestId("earn-deposit-input"), { target: { value: "25" } });
    h.exitApi = api("sent", { signature: "sig" });
    rerender(<VaultDepositRail slab={SLAB} vault={null} />);
    expect((screen.getByTestId("earn-deposit-input") as HTMLInputElement).value).toBe("25");
  });
  it("CONTROL: a quote or a failure refreshes nothing", () => {
    __setDevnetV22ForTest(true);
    const onTxSuccess = vi.fn();
    render(<VaultDepositRail slab={SLAB} vault={null} onTxSuccess={onTxSuccess} />);
    expect(h.refreshState).not.toHaveBeenCalled();
    expect(onTxSuccess).not.toHaveBeenCalled();
  });
});
