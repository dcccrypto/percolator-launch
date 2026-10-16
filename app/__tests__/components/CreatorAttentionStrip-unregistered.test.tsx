/**
 * An unregistered launch (no dex_pool_address on its markets row) used to read "no DEX pool on
 * record — can't auto-retry, contact support" even when the creator's own browser still held the
 * creation-tx proof and the request the memo bound. It now offers the retry from that browser, and
 * says what is actually wrong (another device) otherwise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const retry = vi.fn();
vi.mock("@/hooks/useCreateMarket", () => ({
  useCreateMarket: () => ({ state: { keeperMessage: null, keeperRegistering: false }, retryKeeperRegistration: retry }),
}));
vi.mock("@/components/create/RecoverSolBanner", () => ({ RecoverSolBanner: () => null }));
vi.mock("@/components/my-markets/attentionLogic", () => ({
  isKeeperFeedDead: () => true,
  isEngineCrankStale: () => false,
  summarizeAffectedMarkets: () => "",
}));

import { CreatorAttentionStrip, NO_SAVED_REGISTRATION_COPY } from "@/components/my-markets/CreatorAttentionStrip";

const SLAB = new PublicKey("BpFCMYFzNEWMR8hYhGy8xvD9a4yCSn5DtUQwe9VBRVxQ");
const POOL = "9GBXHym9gxDZH3u6UnW71yXaixaBkG8K7EegywH2WQGg";
const market = { slabAddress: SLAB, label: "UNKNOWN", configV17: {}, config: {} } as never;
const renderStrip = () => render(<CreatorAttentionStrip markets={[market]} details={{}} identities={{}} currentSlot={null} />);

beforeEach(() => {
  retry.mockReset();
  window.localStorage.clear();
});

describe("My Markets: an unregistered launch", () => {
  it("nothing saved on this device: says so, no 'contact support', no button", () => {
    renderStrip();
    expect(screen.getByText(NO_SAVED_REGISTRATION_COPY)).toBeTruthy();
    expect(screen.queryByText(/contact support/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /connect the live price/i })).toBeNull();
  });

  it("the launching browser still has the proof + request: offers the retry and sends them", async () => {
    const slab = SLAB.toBase58();
    window.localStorage.setItem(`perc.keeperProofTx.${slab}`, "PROOFSIG");
    window.localStorage.setItem(`perc.keeperRequest.${slab}`, JSON.stringify({ slabAddress: slab, mainnetCA: "CA1", dexPoolAddress: POOL, dexType: "pumpswap", symbol: "TOK" }));
    retry.mockResolvedValue({ registered: true, message: "ok" });
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: /connect the live price/i }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(retry.mock.calls[0][0]).toMatchObject({ slabAddress: slab, dexPoolAddress: POOL, dexType: "pumpswap", mainnetCA: "CA1", symbol: "TOK" });
  });
});
