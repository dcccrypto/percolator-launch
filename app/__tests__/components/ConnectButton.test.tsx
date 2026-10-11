import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const cfg = vi.hoisted(() => ({ network: "devnet" as "devnet" | "mainnet" }));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    network: cfg.network,
    rpcUrl: "https://api.devnet.solana.com",
    programId: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    matcherProgramId: "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k",
    crankWallet: "2JaSzRYrf44fPpQBtRJfnCEgThwCmvpFd3FCXi45VXxm",
    explorerUrl: "https://explorer.solana.com",
    slabSize: 992560,
    matcherCtxSize: 320,
    priorityFee: 50000,
  }),
  getRpcEndpoint: () => "https://api.devnet.solana.com",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/hooks/usePrivySafe", () => ({
  usePrivyAvailable: () => true,
  // ConnectButtonPrivyInner reads the bridge action for its Reconnect state.
  usePrivyLogin: () => vi.fn(),
}));

const mockLogout = vi.fn();
const mockLogin = vi.fn();
const mockExportWallet = vi.fn();

let privyState = {
  ready: true,
  authenticated: true,
  user: { linkedAccounts: [] },
  logout: mockLogout,
  login: mockLogin,
  exportWallet: mockExportWallet,
};

vi.mock("@privy-io/react-auth", () => ({
  useLogin: () => ({
    login: mockLogin,
  }),
  usePrivy: () => privyState,
  useLinkAccount: () => ({ linkTwitter: vi.fn() }),
  useUnlinkOAuth: () => ({ unlink: vi.fn() }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ wallets: [{ address: "1111", standardWallet: { name: "Phantom" } }] }),
  useFundWallet: () => ({ fundWallet: vi.fn() }),
}));

/**
 * The Privy-backed behaviour lives in ConnectButtonPrivyInner — ConnectButton
 * itself is only a `dynamic(ssr:false)` shell that keeps @privy-io/react-auth
 * out of the shared bundle. Rendering the shell in jsdom yields its "Loading
 * wallet" placeholder forever (the dynamic import never resolves), so these
 * assert against the inner component, where the behaviour actually is.
 */
import { ConnectButtonPrivyInner as ConnectButton } from "@/components/wallet/ConnectButtonPrivyInner";

describe("ConnectButton", () => {
  beforeEach(() => {
    mockLogin.mockClear();
    mockSearchParams = new URLSearchParams();
    cfg.network = "devnet";
    privyState = {
      ready: true,
      authenticated: true,
      user: { linkedAccounts: [] },
      logout: mockLogout,
      login: mockLogin,
      exportWallet: mockExportWallet,
    };
  });

  it("shows manage actions when authenticated", () => {
    const { getByRole, getByText } = render(<ConnectButton />);
    fireEvent.click(getByRole("button", { name: /wallet:/i }));
    expect(getByText("Manage Wallet")).toBeTruthy();
    expect(getByText("Disconnect")).toBeTruthy();
  });

  it("Account and Security opens its window and closes the menu", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ref: null }))));
    const { getByRole, getByText, queryByText } = render(<ConnectButton />);
    fireEvent.click(getByRole("button", { name: /wallet:/i }));
    fireEvent.click(getByText("Account and Security"));
    expect(getByRole("dialog", { name: "Account and Security" })).toBeTruthy();
    expect(queryByText("Manage Wallet")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("a sign-out closes the window; signing back in doesn't reopen it", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ref: null }))));
    const { getByRole, getByText, queryByRole, rerender } = render(<ConnectButton />);
    fireEvent.click(getByRole("button", { name: /wallet:/i }));
    fireEvent.click(getByText("Account and Security"));
    privyState = { ...privyState, authenticated: false };
    rerender(<ConnectButton />);
    privyState = { ...privyState, authenticated: true };
    rerender(<ConnectButton />);
    expect(queryByRole("dialog")).toBeNull();
    vi.unstubAllGlobals();
  });

  // Privy funding is mainnet-only, so on devnet "Add funds" was always disabled and the Privy menu
  // had no route to test funds (the wallet-adapter menu links /faucet).
  it("devnet: the menu links Get test funds to /faucet instead of a dead Add funds", () => {
    const { getByRole, queryByText } = render(<ConnectButton />);
    fireEvent.click(getByRole("button", { name: /wallet:/i }));
    expect(getByRole("link", { name: "Get test funds" }).getAttribute("href")).toBe("/faucet");
    expect(queryByText("Add funds")).toBeNull();
  });

  it("CONTROL: mainnet keeps Add funds and shows no faucet link", () => {
    cfg.network = "mainnet";
    const { getByRole, getByText, queryByText } = render(<ConnectButton />);
    fireEvent.click(getByRole("button", { name: /wallet:/i }));
    expect(getByText("Add funds")).toBeTruthy();
    expect(queryByText("Get test funds")).toBeNull();
  });

  it("uses Privy login for unauthenticated users", () => {
    privyState = { ...privyState, authenticated: false };
    const { getByRole } = render(<ConnectButton />);
    fireEvent.click(getByRole("button", { name: /connect wallet/i }));
    expect(mockLogin).toHaveBeenCalledWith({
      loginMethods: ["wallet", "email"],
      walletChainType: "solana-only",
    });
  });

  it("shows a Solflare deep-link in debug mode when unauthenticated", () => {
    privyState = { ...privyState, authenticated: false };
    mockSearchParams = new URLSearchParams("walletDebug=1");
    const { getByRole } = render(<ConnectButton />);
    const link = getByRole("link", { name: /Open in Solflare/i });
    expect(link.getAttribute("href")).toContain("solflare.com/ul/v1/browse/");
  });
});
