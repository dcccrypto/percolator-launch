/**
 * The launch success screen shows its actions (trade, Sim-USDC claim, copy address, explorer, my
 * markets) as soon as the market's creation has landed, while the live price is still connecting.
 * The price status is a one-line secondary status that is bounded: it settles on a calm final line
 * after LAUNCH_PRICE_WAIT_MS, and a keeper-register 5xx is retried with backoff a few times and then
 * surfaced with Retry, never an endless spinner.
 *
 * Regression: WP-7 replaced the whole screen with an "Almost ready" waiting state that hid every
 * action until the price connected; a persistent 5xx kept it there forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/config", () => ({
  getNetwork: () => "devnet",
  // The real helpers on a devnet build (lib/config.ts explorerTxUrl / explorerAccountUrl).
  explorerTxUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  explorerAccountUrl: (addr: string) => `https://explorer.solana.com/account/${addr}?cluster=devnet`,
}));
const WALLET = new PublicKey("11111111111111111111111111111112");
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: WALLET, connected: true }) }));
vi.mock("@/components/create/LogoUpload", () => ({ LogoUpload: () => null }));

import { LaunchSuccess, LAUNCH_PRICE_WAIT_MS } from "@/components/create/LaunchSuccess";
import { PRICE_SOURCE_LOCKED } from "@/lib/market-registration";
import { TICKET_COPY } from "@/lib/limits/copy";
import {
  KEEPER_REGISTER_COPY,
  postKeeperRegistration,
  runKeeperRegistration,
  type KeeperRegisterPhase,
} from "@/lib/keeper-register-client";

const SLAB = "7A2g9aUDHgJdeg5E53TqcXrVsKGpiaPbKDrJXRi7dfC1";
const SIM_USDC = "So11111111111111111111111111111111111111112";

type Props = Parameters<typeof LaunchSuccess>[0];
const base = (over: Partial<Props> = {}): Props => ({
  tokenSymbol: "WIF",
  tradingFeeBps: 5,
  maxLeverage: 5,
  marketAddress: SLAB,
  txSigs: [],
  onDeployAnother: () => {},
  devnetMint: SIM_USDC,
  priceFeedRequired: true,
  keeperDelegated: false,
  keeperPhase: "connecting",
  keeperMessage: KEEPER_REGISTER_COPY.connecting,
  onRetryKeeperRegistration: () => {},
  ...over,
});

beforeEach(() => {
  push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("launch success: actions while the live price is still connecting", () => {
  it("renders the success actions immediately while registration is pending", () => {
    render(<LaunchSuccess {...base()} />);
    expect(screen.getByTestId("launch-success")).toBeTruthy();
    expect(screen.getByTestId("launch-go-to-market")).toBeTruthy();
    expect(screen.getByTestId("launch-claim-sim-usdc").textContent).toMatch(/SIM-USDC/);
    expect(screen.getByTestId("launch-copy-address")).toBeTruthy();
    expect(screen.getByText("VIEW MY MARKETS")).toBeTruthy();
    expect(screen.getByText(/Explorer/)).toBeTruthy();
    // The price is a secondary status line, not the screen.
    expect(screen.getByTestId("launch-price-status").getAttribute("data-status")).toBe("connecting");
    expect(screen.getByTestId("launch-price-status-line").textContent).toMatch(/Live price connecting/);
    expect(screen.queryByText("Almost ready")).toBeNull();
    expect(screen.queryByText("Ready to trade")).toBeNull();
  });

  it("the trade link goes to /trade/<slab>", () => {
    render(<LaunchSuccess {...base()} />);
    expect(screen.getByTestId("launch-go-to-market").getAttribute("href")).toBe(`/trade/${SLAB}`);
  });

  it("copy writes the market address", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<LaunchSuccess {...base()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("launch-copy-address"));
    });
    expect(writeText).toHaveBeenCalledWith(SLAB);
  });

  it("the pending status resolves to the calm timeout line after the bound, with Retry", () => {
    vi.useFakeTimers();
    render(<LaunchSuccess {...base()} />);
    expect(screen.queryByTestId("launch-price-retry")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(LAUNCH_PRICE_WAIT_MS - 1);
    });
    expect(screen.getByTestId("launch-price-status").getAttribute("data-status")).toBe("connecting");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("launch-price-status").getAttribute("data-status")).toBe("timed-out");
    expect(screen.getByTestId("launch-price-status-line").textContent).toBe(
      "Live price is still connecting; your market is live and tradable once it arrives.",
    );
    expect(screen.getByTestId("launch-price-retry")).toBeTruthy();
    // The actions are still there.
    expect(screen.getByTestId("launch-go-to-market").getAttribute("href")).toBe(`/trade/${SLAB}`);
  });

  it("connected: 'Ready to trade' and the connected line", () => {
    render(<LaunchSuccess {...base({ keeperDelegated: true, keeperPhase: "ready", keeperMessage: KEEPER_REGISTER_COPY.ready })} />);
    expect(screen.getByText("Ready to trade")).toBeTruthy();
    expect(screen.getByTestId("launch-price-status").getAttribute("data-status")).toBe("ready");
    expect(screen.queryByTestId("launch-price-retry")).toBeNull();
  });
});

/** The real registration loop driving the real screen, with keeper-register answering 502. */
const REG_REQ = { slabAddress: SLAB, dexPoolAddress: "P", proofTx: "sig" };
function Harness({ fetchImpl, onRetry }: { fetchImpl: typeof fetch; onRetry?: () => void }) {
  const [phase, setPhase] = useState<KeeperRegisterPhase>("connecting");
  const [message, setMessage] = useState<string>(KEEPER_REGISTER_COPY.connecting);
  useEffect(() => {
    const ac = new AbortController();
    void runKeeperRegistration({
      attempt: () => postKeeperRegistration(REG_REQ, fetchImpl),
      signal: ac.signal,
      onStatus: (s) => {
        setPhase(s.phase);
        setMessage(s.message);
      },
    });
    return () => ac.abort();
  }, [fetchImpl]);
  return (
    <LaunchSuccess
      {...base({
        keeperPhase: phase,
        keeperMessage: message,
        keeperDelegated: phase === "ready",
        // Default Retry = the same POST the wizard's retry makes.
        onRetryKeeperRegistration: onRetry ?? (() => void postKeeperRegistration(REG_REQ, fetchImpl)),
      })}
    />
  );
}

describe("keeper-register 5xx: retried with backoff, then Retry", () => {
  it("a 502 is retried a few times, then a calm line with Retry (no status code shown)", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: "Bad Gateway" }) }) as unknown as Response);
    render(<Harness fetchImpl={fetchImpl as unknown as typeof fetch} />);

    // Still well inside the 90 s bound: the backoff (5 + 10 + 20 s) runs out first.
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("launch-price-status").getAttribute("data-status")).toBe("failed");
    const line = screen.getByTestId("launch-price-status-line").textContent ?? "";
    expect(line).toBe(KEEPER_REGISTER_COPY.serverTrouble);
    expect(line).not.toMatch(/502|HTTP|Bad Gateway/);
    // The loop stopped: no further attempts on its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // Retry really POSTs to keeper-register.
    await act(async () => {
      fireEvent.click(screen.getByTestId("launch-price-retry"));
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const [url, init] = fetchImpl.mock.calls[4] as unknown as [string, RequestInit];
    expect(url).toBe("/api/playground/keeper-register");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).slabAddress).toBe(SLAB);
    expect(screen.getByTestId("launch-go-to-market").getAttribute("href")).toBe(`/trade/${SLAB}`);
  });
});

describe("a final refusal shows only reasons written for creators", () => {
  const refuse = (status: number, error: string) =>
    vi.fn(async () => ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response);

  it.each([
    "Slab account does not exist on-chain",
    "Slab account is not a market of this deployment's program",
    "Registration proof refused: memo signer is not the market creator",
    "Invalid dexType",
  ])("jargon 400 %j -> the generic calm line", async (jargon) => {
    const fetchImpl = refuse(400, jargon);
    render(<Harness fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await act(async () => {
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(screen.getByTestId("launch-price-status").getAttribute("data-status")).toBe("failed"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("launch-price-status-line").textContent).toBe(
      "Live price couldn't connect for this market. Your market is live; try again in a moment.",
    );
    expect(screen.getByTestId("launch-success").textContent).not.toContain(jargon);
    expect(screen.getByTestId("launch-price-retry")).toBeTruthy();
  });

  it("an allow-listed reason (422 price source locked) passes through", async () => {
    const fetchImpl = refuse(422, PRICE_SOURCE_LOCKED);
    render(<Harness fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await vi.waitFor(() => expect(screen.getByTestId("launch-price-status").getAttribute("data-status")).toBe("failed"));
    expect(screen.getByTestId("launch-price-status-line").textContent).toBe(PRICE_SOURCE_LOCKED);
  });

  it("no creation tx on this device: the reason, and no Retry that could only repeat it", () => {
    render(<LaunchSuccess {...base({ keeperPhase: "failed", keeperMessage: KEEPER_REGISTER_COPY.noProof })} />);
    expect(screen.getByTestId("launch-price-status-line").textContent).toBe(KEEPER_REGISTER_COPY.noProof);
    expect(screen.queryByTestId("launch-price-retry")).toBeNull();
  });
});

describe("launch success: the creator wallet is close-only on its own market", () => {
  it("says so next to the Trade buttons, in the same words the trade ticket uses", () => {
    render(<LaunchSuccess {...base({ keeperPhase: "ready", keeperMessage: KEEPER_REGISTER_COPY.ready })} />);
    expect(screen.getByTestId("launch-go-to-market")).toBeTruthy();
    expect(screen.getByTestId("launch-close-only-note").textContent).toContain(TICKET_COPY.sameOwner.body);
    expect(screen.getByTestId("launch-close-only-note").textContent).toContain(TICKET_COPY.sameOwner.title);
    expect(TICKET_COPY.sameOwner.body).toMatch(/can only close positions here/);
  });
});
