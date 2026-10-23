/**
 * v2.2 QA 2026-10-16: the preview (no NEXT_PUBLIC_PRIVY_APP_ID, so the wallet-adapter fallback)
 * showed one "Connect Solflare" button and nothing else. With no extension installed the only
 * "ready" wallet is the always-Loadable Solflare adapter, and a single ready wallet rendered as a
 * lone direct-connect button: Phantom and Backpack could not be reached at all.
 *
 * The fallback now always opens a picker: every ready wallet connects, and each supported wallet
 * that is not in this browser (Phantom, Solflare, Backpack) is listed as an install link.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { WalletReadyState } from "@solana/wallet-adapter-base";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/wallet/ConnectButtonPrivyInner", () => ({ ConnectButtonPrivyInner: () => null }));

type W = { adapter: { name: string; icon: string }; readyState: WalletReadyState };
const wallet = (name: string, readyState: WalletReadyState): W => ({ adapter: { name, icon: "" }, readyState });

const select = vi.fn();
const connect = vi.fn(async () => {});
let wallets: W[] = [];

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    wallets,
    wallet: null,
    select,
    connect,
    disconnect: vi.fn(),
    connected: false,
    publicKey: null,
    connecting: false,
  }),
}));

import { ConnectButton } from "@/components/wallet/ConnectButton";

function openPicker() {
  render(<ConnectButton />);
  const button = screen.getByTestId("wallet-connect");
  expect(button.textContent).toBe("Connect Wallet");
  fireEvent.click(button);
}

describe("wallet-adapter fallback: always a picker", () => {
  beforeEach(() => {
    select.mockClear();
    connect.mockClear();
  });

  it("no extension (only the Loadable Solflare adapter): picker, not a lone 'Connect Solflare'", () => {
    wallets = [wallet("Solflare", WalletReadyState.Loadable)];
    openPicker();
    expect(screen.queryByText("Connect Solflare")).toBeNull();
    expect(screen.getByRole("button", { name: "Solflare" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Install Phantom/ }).getAttribute("href")).toMatch(/phantom/);
    expect(screen.getByRole("link", { name: /Install Backpack/ }).getAttribute("href")).toMatch(/backpack/);
    expect(screen.queryByRole("link", { name: /Install Solflare/ })).toBeNull();
  });

  it("Phantom and Backpack installed: both connect from the picker, no install links for them", async () => {
    wallets = [
      wallet("Solflare", WalletReadyState.Loadable),
      wallet("Phantom", WalletReadyState.Installed),
      wallet("Backpack", WalletReadyState.Installed),
    ];
    openPicker();
    expect(screen.queryByRole("link", { name: /Install/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Backpack" }));
    });
    expect(select).toHaveBeenCalledWith("Backpack");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("a single other Wallet Standard wallet still gets the picker (and the missing ones as installs)", () => {
    wallets = [wallet("Phantom", WalletReadyState.Installed)];
    openPicker();
    expect(screen.getByRole("button", { name: "Phantom" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Install Solflare/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Install Backpack/ })).toBeTruthy();
  });

  it("nothing ready at all: the picker lists all three as install links", () => {
    wallets = [wallet("Solflare", WalletReadyState.NotDetected)];
    openPicker();
    for (const n of ["Phantom", "Solflare", "Backpack"]) {
      expect(screen.getByRole("link", { name: new RegExp(`Install ${n}`) })).toBeTruthy();
    }
  });
});
