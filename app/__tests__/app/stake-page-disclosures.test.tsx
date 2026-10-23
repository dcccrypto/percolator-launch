/**
 * The stake page leads with what staking does; the detail opens on request (same pattern as the
 * Earn vaults tab). The full fee split sits behind a toggle in the header, and How it works / what
 * moved stake backs / Risk notice are rows that start closed, with at most one open at a time.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const STAKE_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
const h = vi.hoisted(() => ({ fetch: vi.fn(), conn: null as unknown as { connection: Record<string, unknown> } }));
h.conn = {
  connection: {
    getAccountInfo: async () => null,
    getSlot: async () => 0,
    getTokenAccountBalance: async () => { throw new Error("n/a"); },
  },
};

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: false, publicKey: null }),
  useConnectionCompat: () => h.conn,
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ vaultProgramId: STAKE_PROGRAM.toBase58() }) }));
vi.mock("@/hooks/useStakeDepositByPool", () => ({ useStakeDepositByPool: () => ({ deposit: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useStakeWithdrawByPool", () => ({ useStakeWithdrawByPool: () => ({ withdraw: vi.fn(), loading: false, error: null }) }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/wallet/ConnectWalletCta", () => ({ ConnectWalletCta: ({ label }: { label: string }) => <button>{label}</button> }));

import StakePage from "@/app/stake/page";

beforeEach(() => {
  h.fetch.mockReset();
  h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ pools: [] }) });
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const panel = (id: string) => document.getElementById(`stake-info-${id}`)!;
const row = (name: RegExp) => screen.getByRole("button", { name });

describe("Stake header", () => {
  it("states the downside without any click, whichever intro shows (fee split and Risk notice start closed)", async () => {
    render(<StakePage />);
    await screen.findByTestId("stake-fee-split-toggle");
    // Some "lose value" sentence must be on screen with nothing opened: not inside a hidden panel or a closed row.
    const visible = Array.from(document.querySelectorAll("p, span"))
      .filter((el) => /lose value/.test(el.textContent ?? "") && !el.closest("[hidden]"));
    expect(visible.length).toBeGreaterThan(0);
  });

  it("keeps the full fee split closed until asked for, then opens and closes it", async () => {
    render(<StakePage />);
    const toggle = await screen.findByTestId("stake-fee-split-toggle");
    const split = screen.getByTestId("stake-fee-split");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(split.id);
    expect(split.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(split.hidden).toBe(false);
    // The staker row (easy to mistake for the insurance share) still renders beside the others.
    expect(split.textContent).toContain("Stakers");
    expect(split.textContent).toContain("Insurance fund");
    fireEvent.click(toggle);
    expect(split.hidden).toBe(true);
  });
});

describe("Stake info rows", () => {
  it("start closed", async () => {
    render(<StakePage />);
    await waitFor(() => expect(panel("how")).toBeTruthy());
    for (const id of ["how", "backs", "risk"]) expect(panel(id).hidden).toBe(true);
  });

  it("open one at a time: opening another closes the first", async () => {
    render(<StakePage />);
    await waitFor(() => expect(panel("how")).toBeTruthy());
    fireEvent.click(row(/How it works/));
    expect(panel("how").hidden).toBe(false);
    fireEvent.click(row(/If the pool admin moves stake into insurance/));
    expect(panel("backs").hidden).toBe(false);
    expect(panel("how").hidden).toBe(true);
    expect(row(/How it works/).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row(/Risk notice/));
    expect(panel("risk").hidden).toBe(false);
    expect(panel("backs").hidden).toBe(true);
    expect(panel("risk").textContent).toMatch(/Only stake what you can afford to lose/);
  });

  it("clicking the open row again closes it", async () => {
    render(<StakePage />);
    await waitFor(() => expect(panel("risk")).toBeTruthy());
    fireEvent.click(row(/Risk notice/));
    fireEvent.click(row(/Risk notice/));
    for (const id of ["how", "backs", "risk"]) expect(panel(id).hidden).toBe(true);
  });

  it("each row's button controls its own labelled region", async () => {
    render(<StakePage />);
    await waitFor(() => expect(panel("how")).toBeTruthy());
    for (const id of ["how", "backs", "risk"]) {
      const b = document.getElementById(`stake-info-${id}-button`)!;
      expect(b.getAttribute("aria-controls")).toBe(`stake-info-${id}`);
      expect(panel(id).getAttribute("role")).toBe("region");
      expect(panel(id).getAttribute("aria-labelledby")).toBe(b.id);
    }
  });
});
