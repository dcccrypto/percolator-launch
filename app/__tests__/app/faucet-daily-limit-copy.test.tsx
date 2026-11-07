/**
 * Council 2026-11-06-go1106-ux, First-timer (low): "The faucet limit says one thing and does another. The modal says
 * '1 claim per wallet per day', but ... the /faucet page let me claim another 10,000 ... then said 'Next claim: ...
 * (1 hour)'. The same screen also said 'SOL airdrop skipped (public faucet busy). Try faucet.solana.com' though the
 * wallet already had 1.9 SOL." (shots/ft-f2m-02-faucet-second-claim.png)
 *
 * The page states the same daily limit as the modal, never promises a 1-hour retry, and does not send a wallet that
 * already holds SOL to another faucet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const WALLET = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const fetchMock = vi.fn();

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: true, publicKey: WALLET }) }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyAvailable: () => false, usePrivyLogin: () => () => {} }));
vi.mock("@/components/playground/SimUsdcBalance", () => ({ SimUsdcBalance: () => null }));
vi.mock("@/components/wallet/ConnectButton", () => ({ ConnectButton: () => null }));

import FaucetPage from "@/app/faucet/page";

const DAY = 24 * 60 * 60 * 1000;
const base = { funded: true, usdc_amount: 10_000, usdc_sig: "usdcsig111" };

function respond(status: number, body: Record<string, unknown>) {
  fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body });
}

async function clickClaim() {
  render(<FaucetPage />);
  fireEvent.click(screen.getByRole("button", { name: /Get 10,000/ }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/faucet: the daily limit, said the same way as the modal", () => {
  it("states the limit before you claim", () => {
    render(<FaucetPage />);
    expect(document.body.textContent).toMatch(/1 claim per wallet per day/);
  });

  it("a success with no next-claim time never promises '1 hour'", async () => {
    respond(200, { ...base, sol_airdropped: true, sol_amount: 0 });
    await clickClaim();
    await screen.findByText(/minted/);
    expect(document.body.textContent).not.toMatch(/1 hour/);
    expect(screen.getByText(/Next claim:/).textContent).toMatch(/in 24 hours/);
  });

  it("a refused second claim says it is once per day and when the next one is", async () => {
    const next = new Date(Date.now() + DAY - 60_000).toISOString();
    respond(429, { error: "You've already claimed today: the faucet gives once per wallet per day.", nextClaimAt: next });
    await clickClaim();
    await screen.findByText(/already claimed today/);
    expect(screen.getByText(/Next claim:/)).toBeTruthy();
  });

  it("a wallet that already holds enough SOL is told so, not sent to faucet.solana.com", async () => {
    respond(200, { ...base, sol_airdropped: false, sol_has_enough: true, sol_amount: 0, nextClaimAt: new Date(Date.now() + DAY).toISOString() });
    await clickClaim();
    await screen.findByText(/minted/);
    expect(screen.getByText(/already have enough SOL/i)).toBeTruthy();
    expect(screen.queryByText(/skipped/)).toBeNull();
    expect(screen.queryByRole("link", { name: "faucet.solana.com" })).toBeNull();
  });
});
