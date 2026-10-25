/**
 * #3637: a live-price row whose registration was refused for good says so once, links the support
 * channel, and drops the connect button (pressing it again cannot change the answer).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

// The REAL useCreateMarket (its retry logic decides what is final); only the wallet and the network are faked.
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(() => ({ connection: {} })),
  useWalletCompat: vi.fn(() => ({ publicKey: null, connected: false, signTransaction: vi.fn(), signMessage: vi.fn(), disconnect: vi.fn() })),
}));
vi.mock("@/components/create/RecoverSolBanner", () => ({ RecoverSolBanner: () => null }));
vi.mock("@/components/my-markets/attentionLogic", async (orig) => ({
  ...(await orig<object>()),
  isKeeperFeedDead: () => true,
  isEngineCrankStale: () => true,
}));

import { CreatorAttentionStrip } from "@/components/my-markets/CreatorAttentionStrip";
import { KEEPER_REGISTER_COPY } from "@/lib/keeper-register-client";

const SLAB = new PublicKey("BpFCMYFzNEWMR8hYhGy8xvD9a4yCSn5DtUQwe9VBRVxQ");
const slab = SLAB.toBase58();
const market = { slabAddress: SLAB, label: slab.slice(0, 8) + "…", configV17: {}, config: {} } as never;
const details = { [slab]: { symbol: "UNKNOWN", name: null, dex_pool_address: null } } as never;
const renderStrip = () => render(<CreatorAttentionStrip markets={[market]} details={details} identities={{}} currentSlot={null} />);
const button = /connect the live price/i;

const resp = (status: number, body: Record<string, unknown>) => ({ ok: status < 300, status, headers: new Headers(), json: async () => body });
const NOT_KEEPER = resp(403, { error: "Market is not ready for the live price: oracle-not-keeper", code: "oracle-not-keeper" });
const MISMATCH = resp(403, { error: "Registration proof refused: no matching registration memo signed in the proof transaction" });
const PROOF = "2U4TFzSboHomgWAo1REiwVMC6jA8BZR77VdeNBChnE4NvSDsghA1Bg59oJ3fP6Gzk4FTv6THAJANRoYwV5Q1PRbY";
const POOL = "9GBXHym9gxDZH3u6UnW71yXaixaBkG8K7EegywH2WQGg";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(`perc.keeperProofTx.${slab}`, PROOF);
  window.localStorage.setItem(`perc.keeperRequest.${slab}`, JSON.stringify({ slabAddress: slab, mainnetCA: "CA1", dexPoolAddress: POOL, dexType: "pumpswap", symbol: "TROLL" }));
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("live-price row with the real retry logic (#3637)", () => {
  it("a market that IS registered (keeper outage): a mismatched request is not presented as final", async () => {
    fetchMock.mockResolvedValue(MISMATCH);
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: button }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByTestId("live-price-row-support")).toBeNull();
    expect(screen.queryByText(/will not show a price|won't change that/i)).toBeNull();
  });

  it("a permanent refusal: said once, with a Discord link, and no connect button", async () => {
    fetchMock.mockResolvedValue(NOT_KEEPER);
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(screen.queryByRole("button", { name: button })).toBeNull());
    expect(screen.getAllByText(KEEPER_REGISTER_COPY.oracleNotKeeper, { exact: false })).toHaveLength(1);
    expect(screen.getByTestId("live-price-row-support").getAttribute("href")).toBe("https://discord.gg/fJa4BDBxPN");
  });

  it("two candidates: the permanent answer is not replaced by a later wrong guess", async () => {
    window.localStorage.removeItem(`perc.keeperRequest.${slab}`);
    window.localStorage.setItem(`perc.keeperRequest.${slab}`, JSON.stringify({ slabAddress: slab, mainnetCA: "CA1", dexPoolAddress: POOL, symbol: "TROLL" }));
    fetchMock.mockResolvedValueOnce(NOT_KEEPER).mockResolvedValue(MISMATCH);
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(screen.queryByRole("button", { name: button })).toBeNull());
    expect(screen.getByTestId("live-price-row-support")).toBeTruthy();
  });
});
