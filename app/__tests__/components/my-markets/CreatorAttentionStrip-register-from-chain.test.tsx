/**
 * #3267: a market with no saved request on this device can still be connected: the creator enters the
 * token's address, the app rebuilds the request from chain and proves it against the on-chain memo, and
 * only then sends it. A refused proof sends nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ recover: vi.fn(), adopt: vi.fn(), retry: vi.fn() }));
const WALLET = new PublicKey("EXC8LS3YzsbyadhaQPqaeGjb2ttfGgDLno9jeCFWqqyi");
vi.mock("@/hooks/useCreateMarket", () => ({ useCreateMarket: () => ({ state: { keeperMessage: null, keeperRegistering: false }, retryKeeperRegistration: h.retry }) }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: WALLET }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/hooks/useDexPoolSearch", () => ({ searchVerifiedPools: vi.fn() }));
vi.mock("@/lib/tokenMeta", () => ({ fetchTokenMeta: vi.fn() }));
vi.mock("@/components/create/RecoverSolBanner", () => ({ RecoverSolBanner: () => null }));
vi.mock("@/components/my-markets/attentionLogic", () => ({ isKeeperFeedDead: () => true, isEngineCrankStale: () => false, summarizeAffectedMarkets: () => "" }));
vi.mock("@/lib/launch-recovery", async (orig) => ({ ...(await orig<object>()), recoverLaunchFromChain: h.recover, adoptRecoveredLaunch: h.adopt }));
vi.mock("@/lib/market-completeness", () => ({ isMarketauthComplete: (m: PublicKey) => m.toBase58() === "11111111111111111111111111111111" }));

import { CreatorAttentionStrip, unfinishedLaunchesWithoutLocalRecord } from "@/components/my-markets/CreatorAttentionStrip";

const SLAB = new PublicKey("GrKZUtyeaqbg1Q1J1kPWznui92sbLpX5F62LrBVGkifL");
const market = { slabAddress: SLAB, label: "UNKNOWN", configV17: {}, config: {} } as never;
const renderStrip = () => render(<CreatorAttentionStrip markets={[market]} details={{}} identities={{}} currentSlot={null} />);
const verified = { request: { slabAddress: SLAB.toBase58(), mainnetCA: "CA1", dexPoolAddress: "POOL", dexType: "meteora-dlmm", symbol: "AUTON", payload: { symbol: "AUTON" }, proofTx: "SIG" } };

beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  window.localStorage.clear();
});

describe("register from another device", () => {
  it("nothing saved: offers the token-address form, not a dead end", () => {
    renderStrip();
    expect(screen.getByTestId("register-from-chain-ca")).toBeTruthy();
    expect(screen.queryByText(/ask us to connect it/i)).toBeNull();
  });

  it("a proven launch is adopted and the exact request is sent", async () => {
    h.recover.mockResolvedValue({ ok: true, launch: verified });
    h.retry.mockResolvedValue({ registered: true, message: "ok" });
    renderStrip();
    fireEvent.change(screen.getByTestId("register-from-chain-ca"), { target: { value: "CA1" } });
    fireEvent.click(screen.getByTestId("register-from-chain-submit"));
    await waitFor(() => expect(h.retry).toHaveBeenCalledTimes(1));
    expect(h.recover.mock.calls[0][1]).toEqual({ slab: SLAB.toBase58(), wallet: WALLET.toBase58(), mainnetCA: "CA1" });
    expect(h.adopt).toHaveBeenCalledWith(verified);
    expect(h.retry.mock.calls[0][0]).toEqual({ slabAddress: SLAB.toBase58(), mainnetCA: "CA1", dexPoolAddress: "POOL", dexType: "meteora-dlmm", symbol: "AUTON", payload: { symbol: "AUTON" } });
  });

  it("a launch that does not match the memo: says so, saves nothing, sends nothing", async () => {
    h.recover.mockResolvedValue({ ok: false, reason: "no-match" });
    renderStrip();
    fireEvent.change(screen.getByTestId("register-from-chain-ca"), { target: { value: "WRONG" } });
    fireEvent.click(screen.getByTestId("register-from-chain-submit"));
    await waitFor(() => expect(screen.getByTestId("register-from-chain-note").textContent).toMatch(/doesn't match what this market was launched with/));
    expect(h.adopt).not.toHaveBeenCalled();
    expect(h.retry).not.toHaveBeenCalled();
  });
});

describe("unfinished launches found from chain", () => {
  const m = (marketauth: PublicKey) => ({ slabAddress: SLAB, configV17: { marketauth } }) as never;
  it("lists a launch whose marketauth is not rotated, with no localStorage involved", () => {
    expect(unfinishedLaunchesWithoutLocalRecord([m(WALLET)], new Set())).toHaveLength(1);
  });
  it("skips a finished market, a launch this browser has its own recovery card for, and a market with no v17 config", () => {
    expect(unfinishedLaunchesWithoutLocalRecord([m(PublicKey.default)], new Set())).toHaveLength(0);
    expect(unfinishedLaunchesWithoutLocalRecord([m(WALLET)], new Set([SLAB.toBase58()]))).toHaveLength(0);
    expect(unfinishedLaunchesWithoutLocalRecord([{ slabAddress: SLAB } as never], new Set())).toHaveLength(0);
  });
  it("the strip renders Continue to /create?resume=<slab>", () => {
    render(<CreatorAttentionStrip markets={[{ slabAddress: SLAB, label: "x", configV17: { marketauth: WALLET }, config: {} } as never]} details={{}} identities={{}} currentSlot={null} />);
    expect(screen.getByTestId("unfinished-launch-continue").getAttribute("href")).toBe(`/create?resume=${SLAB.toBase58()}`);
    expect(screen.getByTestId("unfinished-launch-row").textContent).toMatch(/Launch unfinished/);
  });
});
