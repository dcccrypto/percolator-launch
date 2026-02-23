import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    network: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    programId: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    matcherProgramId: "4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy",
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

vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyAvailable: () => true }));

vi.mock("@/lib/wallets", () => ({
  defaultWalletDetector: () => ({ phantom: true, solflare: true, backpack: false }),
  getInstalledWalletIds: () => ["phantom", "solflare"],
  getPrivyWalletList: () => ["detected_solana_wallets", "phantom", "solflare", "wallet_connect"],
}));

const mockLogout = vi.fn();

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({
    ready: true,
    authenticated: true,
    user: { linkedAccounts: [] },
    logout: mockLogout,
    login: vi.fn(),
    connectWallet: vi.fn(),
    exportWallet: vi.fn(),
  }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ wallets: [{ address: "1111", standardWallet: { name: "Phantom" } }] }),
  useFundWallet: () => ({ fundWallet: vi.fn() }),
}));

import { ConnectButton } from "@/components/wallet/ConnectButton";

describe("ConnectButton", () => {
  it("shows manage actions when authenticated", () => {
    const { getByRole, getByText } = render(<ConnectButton />);
    fireEvent.click(getByRole("button", { name: /wallet:/i }));
    expect(getByText("Manage Wallet")).toBeTruthy();
    expect(getByText("Disconnect")).toBeTruthy();
  });
});
