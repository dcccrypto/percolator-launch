/**
 * Regression (GH#2862 sibling, Squid 2026-10-02): signed-out header loops on Connect. Privy's modal
 * says "Successfully connected with Solflare — Wallet was already linked", closes, and the header is
 * still "Connect". In Privy 3.41.0 that is: the login commits `authenticated: true`, then the SDK
 * tears the session down (`onDeleteCustomerAccessToken`) a moment later, and the modal closes with
 * login `onError`, not `onComplete` (see hooks/useSignInLoopRecovery.ts). The header must (a) offer an
 * in-app "Reset wallet connection" after a dropped session the user just signed in with, (b) never
 * offer it for a healthy signed-out load, a cancelled modal, repeated cancels, a signed-in session,
 * a session restored on load, or a Disconnect the user asked for, and (c) the reset must log out,
 * clear only Privy's browser state, and not prompt a wallet.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUsePrivy, mockUseWallets, mockLogout, mockSetPreferred, mockLogin, loginOpts, mockReset } =
  vi.hoisted(() => ({
    mockUsePrivy: vi.fn(),
    mockUseWallets: vi.fn(),
    mockLogout: vi.fn(async () => {}),
    mockSetPreferred: vi.fn(),
    mockLogin: vi.fn(),
    loginOpts: { current: null as null | { onComplete?: (a: unknown) => void } },
    mockReset: vi.fn(),
  }));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/usePreferredWallet", async (orig) => ({
  ...(await orig<typeof import("@/hooks/usePreferredWallet")>()),
  usePreferredWallet: () => ({ preferredAddress: null, setPreferredAddress: mockSetPreferred }),
}));
vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => mockUsePrivy(),
  useLogin: (o: { onComplete?: (a: unknown) => void }) => {
    loginOpts.current = o;
    return { login: mockLogin };
  },
}));
vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => mockUseWallets(),
  useFundWallet: () => ({ fundWallet: vi.fn() }),
}));
vi.mock("@/lib/privy-reset", () => ({ resetPrivyConnection: (...a: unknown[]) => mockReset(...a) }));

import { ConnectButtonPrivyInner } from "@/components/wallet/ConnectButtonPrivyInner";
import { SESSION_DROP_WINDOW_MS } from "@/hooks/useSignInLoopRecovery";

const SIGNED_OUT = { ready: true, authenticated: false, logout: mockLogout, exportWallet: vi.fn(), user: null };
const SIGNED_IN = {
  ...SIGNED_OUT,
  authenticated: true,
  user: { wallet: { address: "SOLFLARE" }, linkedAccounts: [] },
};
const resetBtn = () => screen.queryByTestId("wallet-reset");
const clickConnect = () => fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));

type R = ReturnType<typeof render>["rerender"];
/** The SDK's sequence in the loop: authenticated true is committed, then dropped. */
function sessionAppears(rerender: R) {
  mockUsePrivy.mockReturnValue(SIGNED_IN);
  rerender(<ConnectButtonPrivyInner />);
}
function sessionDropped(rerender: R) {
  mockUsePrivy.mockReturnValue(SIGNED_OUT);
  rerender(<ConnectButtonPrivyInner />);
}

describe("signed-out Connect loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockUsePrivy.mockReturnValue(SIGNED_OUT);
    mockUseWallets.mockReturnValue({ ready: true, wallets: [] });
  });
  afterEach(() => vi.useRealTimers());

  it("Connect → session appears → SDK drops it: offers Reset", () => {
    const { rerender } = render(<ConnectButtonPrivyInner />);
    clickConnect();
    sessionAppears(rerender);
    expect(resetBtn()).toBeNull();
    sessionDropped(rerender);
    expect(resetBtn()).not.toBeNull();
  });

  it("the loop again after Reset is hidden by a good login: a later drop still re-offers it", () => {
    const { rerender } = render(<ConnectButtonPrivyInner />);
    clickConnect();
    sessionAppears(rerender);
    sessionDropped(rerender);
    expect(resetBtn()).not.toBeNull();
    clickConnect();
    sessionAppears(rerender);
    expect(resetBtn()).toBeNull();
    sessionDropped(rerender);
    expect(resetBtn()).not.toBeNull();
  });

  it("CONTROL: a session that lasts past the drop window and then ends is not a loop", () => {
    const { rerender } = render(<ConnectButtonPrivyInner />);
    clickConnect();
    sessionAppears(rerender);
    act(() => void vi.advanceTimersByTime(SESSION_DROP_WINDOW_MS + 1));
    sessionDropped(rerender);
    expect(resetBtn()).toBeNull();
  });

  it("CONTROL: the user cancels the modal (no session ever appears), even repeatedly: no Reset", () => {
    render(<ConnectButtonPrivyInner />);
    clickConnect();
    clickConnect();
    clickConnect();
    act(() => void vi.advanceTimersByTime(SESSION_DROP_WINDOW_MS * 2));
    expect(resetBtn()).toBeNull();
  });

  it("CONTROL: the user clicks Disconnect right after signing in: no Reset", () => {
    const { rerender } = render(<ConnectButtonPrivyInner />);
    clickConnect();
    sessionAppears(rerender);
    fireEvent.click(screen.getByRole("button", { name: /^Wallet:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(mockLogout).toHaveBeenCalledTimes(1);
    sessionDropped(rerender);
    expect(resetBtn()).toBeNull();
  });

  it("CONTROL: a session restored on page load that later ends (no Connect click) is not a loop", () => {
    mockUsePrivy.mockReturnValue(SIGNED_IN);
    const { rerender } = render(<ConnectButtonPrivyInner />);
    sessionDropped(rerender);
    expect(resetBtn()).toBeNull();
  });

  it("CONTROL: a healthy signed-out page never shows Reset", () => {
    render(<ConnectButtonPrivyInner />);
    act(() => void vi.advanceTimersByTime(SESSION_DROP_WINDOW_MS * 5));
    expect(resetBtn()).toBeNull();
  });

  it("CONTROL: a signed-in session never shows Reset", () => {
    mockUsePrivy.mockReturnValue(SIGNED_IN);
    mockUseWallets.mockReturnValue({ ready: true, wallets: [{ address: "SOLFLARE" }] });
    render(<ConnectButtonPrivyInner />);
    act(() => void vi.advanceTimersByTime(SESSION_DROP_WINDOW_MS * 2));
    expect(resetBtn()).toBeNull();
  });

  it("CONTROL: Connect opens Privy login exactly once per click (no auto-prompt after a drop)", () => {
    const { rerender } = render(<ConnectButtonPrivyInner />);
    clickConnect();
    sessionAppears(rerender);
    sessionDropped(rerender);
    act(() => void vi.advanceTimersByTime(SESSION_DROP_WINDOW_MS * 2));
    expect(mockLogin).toHaveBeenCalledTimes(1);
    clickConnect();
    expect(mockLogin).toHaveBeenCalledTimes(2);
  });

  it("clicking Reset clears the preferred wallet and runs the reset with Privy logout; no login prompt", () => {
    const { rerender } = render(<ConnectButtonPrivyInner />);
    clickConnect();
    sessionAppears(rerender);
    sessionDropped(rerender);
    mockLogin.mockClear();
    fireEvent.click(screen.getByTestId("wallet-reset"));
    expect(mockSetPreferred).toHaveBeenCalledWith(null);
    expect(mockReset).toHaveBeenCalledWith(mockLogout);
    expect(mockLogin).not.toHaveBeenCalled();
  });
});
