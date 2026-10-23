import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const {
  mockLogout,
  mockLogin,
  mockSetPreferredAddress,
} = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockLogin: vi.fn(),
  mockSetPreferredAddress: vi.fn(),
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

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
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
  useConnectWallet: () => ({ connectWallet: vi.fn() }),
  useIdentityToken: () => ({ identityToken: null }),
  useLogin: () => ({
    login: mockLogin,
  }),
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    login: mockLogin,
    logout: mockLogout,
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

import { ConnectButtonPrivyInner as PrivyInnerBase } from "@/components/wallet/ConnectButtonPrivyInner";
import { PrivyStateProvider } from "../helpers/privyBridge";

// Privy reaches the button through the bridge (the real bridge hook over the mocked SDK above).
const ConnectButton = () => (
  <PrivyStateProvider>
    <PrivyInnerBase />
  </PrivyStateProvider>
);

describe("wallet active-selection regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the persisted preferred wallet when disconnecting", () => {
    const { getByRole, getByText } = render(<ConnectButton />);

    fireEvent.click(
      getByRole("button", {
        name: /wallet:/i,
      }),
    );

    fireEvent.click(getByText("Disconnect"));

    // Positive control: the existing disconnect path really executed.
    expect(mockLogout).toHaveBeenCalledTimes(1);

    // Regression assertion:
    // A stale active wallet must not survive logout and override
    // a different wallet selected during the next authentication.
    expect(mockSetPreferredAddress).toHaveBeenCalledWith(null);
  });
});
