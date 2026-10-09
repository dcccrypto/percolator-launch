/**
 * #3320: a live-price row names the market by the ticker in the launch's saved registration request
 * (before the slab address), and the final per-wallet refusal replaces the button with one calm line.
 * A retryable refusal keeps the button.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const retry = vi.fn();
vi.mock("@/hooks/useCreateMarket", () => ({
  useCreateMarket: () => ({ state: { keeperMessage: null, keeperRegistering: false }, retryKeeperRegistration: retry }),
}));
vi.mock("@/components/create/RecoverSolBanner", () => ({ RecoverSolBanner: () => null }));
vi.mock("@/components/my-markets/attentionLogic", async (orig) => ({
  ...(await orig<object>()),
  isKeeperFeedDead: () => true,
  isEngineCrankStale: () => true,
}));

import { CreatorAttentionStrip, attentionMarketName } from "@/components/my-markets/CreatorAttentionStrip";
import { GLOBAL_CAP_COPY, PER_CREATOR_CAP_COPY } from "@/lib/keeper-enrollment-guard";
import { PER_CREATOR_LIMIT_ROW_COPY, isPerCreatorCapRefusal, postKeeperRegistration } from "@/lib/keeper-register-client";

const SLAB = new PublicKey("BpFCMYFzNEWMR8hYhGy8xvD9a4yCSn5DtUQwe9VBRVxQ");
const slab = SLAB.toBase58();
const market = { slabAddress: SLAB, label: slab.slice(0, 8) + "…", configV17: {}, config: {} } as never;
const details = { [slab]: { symbol: "UNKNOWN", name: null, dex_pool_address: null } } as never;
const renderStrip = () => render(<CreatorAttentionStrip markets={[market]} details={details} identities={{}} currentSlot={null} />);
const buttonName = /connect the live price/i;

beforeEach(() => {
  retry.mockReset();
  window.localStorage.clear();
  window.localStorage.setItem(`perc.keeperProofTx.${slab}`, "PROOFSIG");
  window.localStorage.setItem(
    `perc.keeperRequest.${slab}`,
    JSON.stringify({ slabAddress: slab, mainnetCA: "CA1", dexPoolAddress: "9GBXHym9gxDZH3u6UnW71yXaixaBkG8K7EegywH2WQGg", dexType: "pumpswap", symbol: "TROLL" }),
  );
});

describe("name from the saved request", () => {
  it("the row shows the saved ticker, not the address", () => {
    renderStrip();
    expect(screen.getAllByText("TROLL").length).toBeGreaterThan(0);
    expect(screen.queryByText(slab.slice(0, 8) + "…")).toBeNull();
  });

  it("the 'catching up' summary names it the same way", () => {
    renderStrip();
    expect(screen.getByText(/TROLL — each catches up/)).toBeTruthy();
  });

  it("nothing saved: falls back to the address label; the identity ticker still wins", () => {
    window.localStorage.clear();
    expect(attentionMarketName(slab, "lbl…", null)).toBe("lbl…");
    expect(attentionMarketName(slab, "lbl…", "REAL", [{ slabAddress: slab, dexPoolAddress: "P", symbol: "TROLL", proofTx: "x" }])).toBe("REAL");
    expect(attentionMarketName(slab, "lbl…", null, [{ slabAddress: slab, dexPoolAddress: "P", symbol: "UNKNOWN", proofTx: "x" }])).toBe("lbl…");
  });
});

describe("per-wallet limit is final on the row", () => {
  it("a structured per-creator-cap refusal replaces the button with one line", async () => {
    retry.mockResolvedValue({ registered: false, message: PER_CREATOR_CAP_COPY, code: "per-creator-cap" });
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() => expect(screen.getByTestId("per-creator-limit-note").textContent).toBe(PER_CREATOR_LIMIT_ROW_COPY));
    expect(screen.queryByRole("button", { name: buttonName })).toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("the exact copy without a code is read the same way", async () => {
    retry.mockResolvedValue({ registered: false, message: PER_CREATOR_CAP_COPY });
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() => expect(screen.getByTestId("per-creator-limit-note")).toBeTruthy());
    expect(screen.queryByRole("button", { name: buttonName })).toBeNull();
  });

  it("the global ceiling (429) is retryable: the button stays", async () => {
    retry.mockResolvedValue({ registered: false, message: GLOBAL_CAP_COPY, code: "global-cap" });
    renderStrip();
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() => expect(screen.getByText(GLOBAL_CAP_COPY)).toBeTruthy());
    expect(screen.getByRole("button", { name: buttonName })).not.toBeDisabled();
    expect(screen.queryByTestId("per-creator-limit-note")).toBeNull();
  });

  it("the limit line is plain: no numbers, no jargon", () => {
    expect(PER_CREATOR_LIMIT_ROW_COPY).not.toMatch(/\d|portfolio|\blp\b|bps/i);
  });
});

describe("client reads the route's code", () => {
  const resp = (status: number, body: object) =>
    vi.fn().mockResolvedValue({ ok: false, status, headers: { get: () => null }, json: async () => body }) as unknown as typeof fetch;
  const req = { slabAddress: slab, dexPoolAddress: "P", proofTx: "x" };

  it("carries `code` through and treats 403 per-creator-cap as final", async () => {
    const r = await postKeeperRegistration(req, resp(403, { ok: false, registered: false, error: PER_CREATOR_CAP_COPY, code: "per-creator-cap" }));
    expect(r).toMatchObject({ registered: false, retryable: false, code: "per-creator-cap" });
    expect(isPerCreatorCapRefusal(r)).toBe(true);
  });

  it("the 429 ceiling is retryable and is not the per-creator limit", async () => {
    const r = await postKeeperRegistration(req, resp(429, { ok: false, registered: false, error: GLOBAL_CAP_COPY, code: "global-cap" }));
    expect(r.retryable).toBe(true);
    expect(isPerCreatorCapRefusal(r)).toBe(false);
  });
});
