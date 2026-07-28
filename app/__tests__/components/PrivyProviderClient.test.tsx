import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children, config }: any) => (
    <div
      data-wallet-chain-type={config.appearance.walletChainType}
      data-show-wallet-first={String(config.appearance.showWalletLoginFirst)}
      data-walletconnect={config.walletConnectCloudProjectId ?? ""}
      data-walletlist={JSON.stringify(config.appearance.walletList ?? [])}
    >
      {children}
    </div>
  ),
  usePrivy: () => ({ login: vi.fn() }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  toSolanaWalletConnectors: () => [],
  useWallets: () => ({ wallets: [] }),
  // A vi.mock factory REPLACES the module, so every hook the provider imports
  // must be listed here or the import throws before any test runs. These four
  // are what PrivyProviderClient builds its WalletApi from.
  useSignTransaction: () => ({ signTransaction: vi.fn() }),
  useSignAndSendTransaction: () => ({ signAndSendTransaction: vi.fn() }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
}));

import PrivyProviderClient from "@/components/providers/PrivyProviderClient";

describe("PrivyProviderClient", () => {
  it("configures solana-first wallet login", () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "walletconnect-test";
    const { container } = render(
      <PrivyProviderClient appId="test">child</PrivyProviderClient>
    );

    const wrapper = container.querySelector("div");
    expect(wrapper?.getAttribute("data-wallet-chain-type")).toBe("solana-only");
    expect(wrapper?.getAttribute("data-show-wallet-first")).toBe("true");
    expect(wrapper?.getAttribute("data-walletconnect")).toBe("walletconnect-test");
    expect(wrapper?.getAttribute("data-walletlist")).toContain("phantom");
    expect(wrapper?.getAttribute("data-walletlist")).toContain("solflare");
  });
});
