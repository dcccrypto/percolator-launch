import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockConnectWallet,
  mockSetPreferredAddress,
  mockPrivyLogin,
  connectWalletCallbacks,
} = vi.hoisted(() => ({
  mockConnectWallet: vi.fn(),
  mockSetPreferredAddress: vi.fn(),
  mockPrivyLogin: vi.fn(),
  connectWalletCallbacks: {
    current: null as any,
  },
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    network: "devnet",
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/usePrivySafe", () => ({
  usePrivyAvailable: () => true,
  usePrivyLogin: () => mockPrivyLogin,
}));

vi.mock("@/hooks/usePreferredWallet", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/usePreferredWallet")>();

  return {
    ...actual,
    usePreferredWallet: () => ({
      preferredAddress: "PHANTOM_OLD_ADDRESS",
      setPreferredAddress: mockSetPreferredAddress,
    }),
  };
});

vi.mock("@privy-io/react-auth", () => ({
  useIdentityToken: () => ({ identityToken: null }),
  useLogin: () => ({ login: vi.fn() }),
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    logout: vi.fn(),
    exportWallet: vi.fn(),
    user: {
      linkedAccounts: [],
    },
  }),

  useConnectWallet: (callbacks: any) => {
    connectWalletCallbacks.current = callbacks;
    return {
      connectWallet: mockConnectWallet,
    };
  },
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({
    wallets: [
      {
        address: "PHANTOM_OLD_ADDRESS",
        standardWallet: { name: "Phantom" },
      },
      {
        address: "SOLFLARE_CONNECTED_ADDRESS",
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

describe("Wallet Command connect-wallet regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectWalletCallbacks.current = null;
  });

  it("makes the newly connected Solflare wallet active", () => {
    const { getByRole } = render(<WalletPage />, { wrapper: PrivyStateProvider });

    fireEvent.click(
      getByRole("button", {
        name: "Connect another wallet",
      }),
    );

    // Positive control: the intended Solana-only connection flow ran.
    expect(mockConnectWallet).toHaveBeenCalledTimes(1);
    expect(mockConnectWallet).toHaveBeenCalledWith({
      walletChainType: "solana-only",
    });

    expect(connectWalletCallbacks.current?.onSuccess).toBeTypeOf("function");

    act(() => {
      connectWalletCallbacks.current.onSuccess({
        wallet: {
          type: "solana",
          address: "SOLFLARE_CONNECTED_ADDRESS",
        },
      });
    });

    expect(mockSetPreferredAddress).toHaveBeenCalledTimes(1);
    expect(mockSetPreferredAddress).toHaveBeenCalledWith(
      "SOLFLARE_CONNECTED_ADDRESS",
    );

    // connectWallet exists, so the fallback login path must not run.
    expect(mockPrivyLogin).not.toHaveBeenCalled();
  });
});
