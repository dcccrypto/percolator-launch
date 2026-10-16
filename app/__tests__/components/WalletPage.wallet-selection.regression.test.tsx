import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const {
  mockLogout,
  mockSetPreferredAddress,
} = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockSetPreferredAddress: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    network: "devnet",
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/hooks/usePrivySafe", () => ({
  usePrivyAvailable: () => true,
  usePrivyLogin: () => vi.fn(),
}));

vi.mock("@/hooks/usePreferredWallet", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/usePreferredWallet")>();

  return {
    ...actual,
    usePreferredWallet: () => ({
      preferredAddress: "PHANTOM_STALE_ADDRESS",
      setPreferredAddress: mockSetPreferredAddress,
    }),
  };
});

vi.mock("@privy-io/react-auth", () => ({
  useIdentityToken: () => ({ identityToken: null }),
  useLogin: () => ({ login: vi.fn() }),
  useConnectWallet: () => ({
    connectWallet: vi.fn(),
  }),
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    login: vi.fn(),
    logout: mockLogout,
    connectWallet: vi.fn(),
    exportWallet: vi.fn(),
    user: {
      linkedAccounts: [],
    },
  }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({
    wallets: [
      {
        address: "PHANTOM_STALE_ADDRESS",
        standardWallet: { name: "Phantom" },
      },
      {
        address: "SOLFLARE_NEW_LOGIN_ADDRESS",
        standardWallet: { name: "Solflare" },
      },
    ],
  }),
  useFundWallet: () => ({
    fundWallet: vi.fn(),
  }),
}));

vi.mock("@/components/wallet/WalletDebugPanel", () => ({
  WalletDebugPanel: () => null,
}));

vi.mock("@/components/wallet/ConnectButton", () => ({
  ConnectButton: () => null,
}));

vi.mock("@/components/ui/ScrollReveal", () => ({
  ScrollReveal: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/components/ui/GlassCard", () => ({
  GlassCard: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/CopyableAddress", () => ({
  CopyableAddress: ({ address }: any) => <span>{address}</span>,
}));

vi.mock("@/components/ui/InfoBanner", () => ({
  InfoBanner: ({ children }: any) => <div>{children}</div>,
}));

import WalletPage from "@/app/wallet/page";
import { PrivyStateProvider } from "../helpers/privyBridge";

describe("wallet page active-selection regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the persisted preferred wallet when disconnecting from Wallet Command", () => {
    const { getByRole } = render(<WalletPage />, { wrapper: PrivyStateProvider });

    fireEvent.click(
      getByRole("button", {
        name: "Disconnect",
      }),
    );

    // Positive control: logout really executed.
    expect(mockLogout).toHaveBeenCalledTimes(1);

    // Regression assertion:
    // stale active-wallet preference must not survive logout.
    expect(mockSetPreferredAddress).toHaveBeenCalledWith(null);
  });
});
