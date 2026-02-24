import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    network: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    programId: "4dvCZrrPHmimQLDUBLme5CRqa81nGVLzGMwKUAPfXKih",
    matcherProgramId: "93BiJ7abUKwJmSvqqPJa7X7YqVCCt2Ai9u3wTxZJYevm",
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

vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyAvailable: () => true }));

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
  usePrivy: () => privyState,
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ wallets: [{ address: "1111", standardWallet: { name: "Phantom" } }] }),
  useFundWallet: () => ({ fundWallet: vi.fn() }),
}));

import { ConnectButton } from "@/components/wallet/ConnectButton";

describe("ConnectButton", () => {
  beforeEach(() => {
    mockLogin.mockClear();
    mockSearchParams = new URLSearchParams();
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
