/**
 * #3637: a live-price row whose registration was refused for good says so once, links the support
 * channel, and drops the connect button (pressing it again cannot change the answer).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ state: { keeperMessage: null as string | null, keeperRegistering: false, keeperFinal: false } }));
vi.mock("@/hooks/useCreateMarket", () => ({
  useCreateMarket: () => ({ state: h.state, retryKeeperRegistration: vi.fn() }),
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

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(`perc.keeperProofTx.${slab}`, "2U4TFzSboHomgWAo1REiwVMC6jA8BZR77VdeNBChnE4NvSDsghA1Bg59oJ3fP6Gzk4FTv6THAJANRoYwV5Q1PRbY");
  window.localStorage.setItem(
    `perc.keeperRequest.${slab}`,
    JSON.stringify({ slabAddress: slab, mainnetCA: "CA1", dexPoolAddress: "9GBXHym9gxDZH3u6UnW71yXaixaBkG8K7EegywH2WQGg", dexType: "pumpswap", symbol: "TROLL" }),
  );
  h.state = { keeperMessage: null, keeperRegistering: false, keeperFinal: false };
});

describe("final refusal in the live-price row", () => {
  it("says the refusal once, with a Discord link, and no connect button", () => {
    h.state = { keeperMessage: KEEPER_REGISTER_COPY.oracleNotKeeper, keeperRegistering: false, keeperFinal: true };
    renderStrip();
    expect(screen.queryByRole("button", { name: button })).toBeNull();
    expect(screen.getAllByText(KEEPER_REGISTER_COPY.oracleNotKeeper, { exact: false })).toHaveLength(1);
    expect(screen.getByTestId("live-price-row-support").getAttribute("href")).toBe("https://discord.gg/fJa4BDBxPN");
  });

  it("a retryable state keeps the button and shows no support link", () => {
    h.state = { keeperMessage: KEEPER_REGISTER_COPY.serverTrouble, keeperRegistering: false, keeperFinal: false };
    renderStrip();
    expect(screen.getByRole("button", { name: button })).toBeTruthy();
    expect(screen.queryByTestId("live-price-row-support")).toBeNull();
  });
});
