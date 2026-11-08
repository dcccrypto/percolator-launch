import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock @/lib/config — avoids localStorage.getItem issues in jsdom
vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    network: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    programId: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    matcherProgramId: "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k",
    crankWallet: "2JaSzRYrf44fPpQBtRJfnCEgThwCmvpFd3FCXi45VXxm",
    explorerUrl: "https://explorer.solana.com",
    slabSize: 992560,
    matcherCtxSize: 320,
    priorityFee: 50000,
  }),
  setNetwork: vi.fn(),
  explorerTxUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  explorerAccountUrl: (addr: string) => `https://explorer.solana.com/account/${addr}?cluster=devnet`,
  getRpcEndpoint: () => "https://api.devnet.solana.com",
}));
let privyAvailable = true;
let privyState = {
  ready: true,
  authenticated: true,
  user: {
    linkedAccounts: [
      {
        type: "wallet",
        walletClientType: "privy",
        chainType: "solana",
        address: "Embedded1111",
      },
    ],
  },
  logout: vi.fn(),
  login: vi.fn(),
  connectWallet: vi.fn(),
  exportWallet: vi.fn(),
};

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/usePrivySafe", () => ({
  usePrivyAvailable: () => privyAvailable,
  // PR#2620 (GH#2618): WalletPageInner now also calls usePrivyLogin() as the
  // fallback login trigger when useConnectWallet() is unavailable.
  usePrivyLogin: () => vi.fn(),
}));

vi.mock("@privy-io/react-auth", () => ({
  useIdentityToken: () => ({ identityToken: null }),
  useLogin: () => ({ login: vi.fn() }),
  usePrivy: () => privyState,
  // PR#2620 (GH#2618): WalletPageInner now also calls useConnectWallet() so
  // "Connect another wallet" can promote the newly connected wallet to active.
  useConnectWallet: () => ({ connectWallet: vi.fn() }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({
    wallets: [{ address: "Wallet1111", standardWallet: { name: "Phantom" } }],
  }),
  useFundWallet: () => ({ fundWallet: vi.fn() }),
}));

vi.mock("@/components/ui/ScrollReveal", () => ({
  ScrollReveal: ({ children }: any) => <div>{children}</div>,
}));
import WalletPage from "../../app/wallet/page";
import { PrivyStateProvider } from "../helpers/privyBridge";

describe("WalletPage", () => {
  beforeEach(() => {
    privyAvailable = true;
    privyState = {
      ...privyState,
      ready: true,
      authenticated: true,
    };
  });

  it("shows wallet actions when authenticated", () => {
    render(<WalletPage />, { wrapper: PrivyStateProvider });
    expect(screen.getAllByRole("button", { name: /Add funds/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Export key/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Disconnect/i })).toBeTruthy();
  });

  // "Open faucet" went to the Devnet Token Factory (/devnet-mint), which has no Sim-USDC claim; the
  // playground faucet that funds trading is /faucet.
  it("devnet: Open faucet goes to the Sim-USDC faucet, not the token factory", () => {
    render(<WalletPage />, { wrapper: PrivyStateProvider });
    // One link (GlowButton href), not a button inside a link (#64).
    const link = screen.getByRole("link", { name: /Open faucet/i });
    expect(link.getAttribute("href")).toBe("/faucet");
    expect(link.querySelector("button")).toBeNull();
    expect(screen.getByText("On devnet, use the faucet to get test USDC and a little test SOL.")).toBeTruthy();
  });

  it("shows connect prompt when unauthenticated", () => {
    privyState = { ...privyState, authenticated: false };
    render(<WalletPage />, { wrapper: PrivyStateProvider });
    expect(screen.getByText(/Connect a wallet/i)).toBeTruthy();
    // #2663: the Privy-only branch advertises email sign-in (loginMethods
    // includes "email", createOnLogin "users-without-wallets").
    expect(screen.getByText(/sign in with email/i)).toBeTruthy();
  });

  // #3740 (Council GO1106-UX nit) replaced the "Wallet features unavailable" / "Set NEXT_PUBLIC_PRIVY_APP_ID" wording, which
  // leaked a deploy setting to every user, with a plain notice that points at a browser wallet.
  it("without Privy: says embedded wallets aren't available, points at a browser wallet, offers no embedded-wallet actions", () => {
    privyAvailable = false;
    render(<WalletPage />, { wrapper: PrivyStateProvider });
    expect(screen.getByText(/Email and embedded wallets aren.t available on this site/i)).toBeTruthy();
    expect(screen.getByTestId("wallet-no-embedded").textContent).toMatch(/Phantom or Solflare/);
    expect(screen.queryByText(/NEXT_PUBLIC_PRIVY_APP_ID/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Export key/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add funds/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect/i })).toBeNull();
    // ...and the copy's "connect it with the button below" has a connect control to point at (#3740 renders <ConnectButton />).
    // (in this test env neither Privy nor wallet-adapter is mounted: the disabled fallback, accessible name "Wallet unavailable")
    expect(screen.getByRole("button", { name: /connect|wallet unavailable/i })).toBeTruthy();
  });
});
