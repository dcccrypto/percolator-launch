/**
 * Header wallet menus (Privy and wallet-adapter): Escape didn't close them, the trigger didn't say
 * whether the menu was open, and "Copy address" closed the menu with no sign the copy worked (its
 * promise was neither awaited nor caught). Escape now closes the menu and puts focus back on the
 * trigger, the trigger carries aria-expanded, and Copy shows "Address copied" (or an error toast).
 */
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/hooks/useToast";
import { ToastContainer } from "@/components/ui/Toast";

const ADDR = "9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa";
const flags = vi.hoisted(() => ({ privy: true }));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet" }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyAvailable: () => flags.privy, usePrivyLogin: () => vi.fn() }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@privy-io/react-auth", () => ({
  useLogin: () => ({ login: vi.fn() }),
  useConnectWallet: () => ({ connectWallet: vi.fn() }),
  useIdentityToken: () => ({ identityToken: null }),
  usePrivy: () => ({ ready: true, authenticated: true, user: { linkedAccounts: [] }, logout: vi.fn(), exportWallet: vi.fn() }),
}));
vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ ready: true, wallets: [{ address: ADDR, standardWallet: { name: "Phantom" } }] }),
  useFundWallet: () => ({ fundWallet: vi.fn() }),
}));
vi.mock("@/hooks/usePreferredWallet", () => ({
  usePreferredWallet: () => ({ preferredAddress: ADDR, setPreferredAddress: vi.fn() }),
  resolveActiveWallet: (ws: Array<{ address: string }>) => ws[0] ?? null,
}));
vi.mock("@/hooks/useWalletNeedsReconnect", () => ({ useWalletNeedsReconnect: () => false, isReconnectFallbackEligible: () => false }));
vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    wallets: [], wallet: null, select: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
    connected: true, connecting: false, publicKey: { toBase58: () => ADDR },
  }),
}));

import { ConnectButtonPrivyInner } from "@/components/wallet/ConnectButtonPrivyInner";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { PrivyStateProvider } from "../helpers/privyBridge";

const menus = [
  { name: "Privy menu", privy: true, ui: () => <PrivyStateProvider><ConnectButtonPrivyInner /></PrivyStateProvider> },
  { name: "wallet-adapter menu", privy: false, ui: () => <ConnectButton /> },
];

function renderMenu(ui: () => React.ReactElement) {
  render(<ToastProvider>{ui()}<ToastContainer /></ToastProvider>);
  return screen.getByTestId("wallet-connect");
}

describe.each(menus)("header wallet $name", ({ privy, ui }) => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    flags.privy = privy;
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(cleanup);

  it("the trigger reports whether the menu is open", () => {
    const trigger = renderMenu(ui);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("Escape closes the menu and returns focus to the trigger", () => {
    const trigger = renderMenu(ui);
    fireEvent.click(trigger);
    const copy = screen.getByRole("button", { name: "Copy address" });
    copy.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("Copy address says it copied", async () => {
    fireEvent.click(renderMenu(ui));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy address" })); });
    expect(writeText).toHaveBeenCalledWith(ADDR);
    await waitFor(() => expect(screen.getByText("Address copied")).toBeInTheDocument());
  });

  it("Copy address says when the copy failed, instead of nothing", async () => {
    writeText.mockRejectedValueOnce(new Error("NotAllowedError"));
    fireEvent.click(renderMenu(ui));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy address" })); });
    await waitFor(() => expect(screen.getByText("Couldn't copy the address")).toBeInTheDocument());
  });
});
