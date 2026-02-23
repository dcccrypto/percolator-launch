import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

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

vi.mock("@/lib/wallets", () => ({
  defaultWalletDetector: () => ({ phantom: true, solflare: false, backpack: false }),
  getInstalledWalletIds: () => ["phantom"],
  getPrivyWalletList: () => ["detected_solana_wallets", "phantom", "wallet_connect"],
}));

vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children, config }: any) => (
    <div data-walletlist={JSON.stringify(config.appearance.walletList)}>
      {children}
    </div>
  ),
  usePrivy: () => ({ login: vi.fn() }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  toSolanaWalletConnectors: () => [],
  useWallets: () => ({ wallets: [] }),
}));

import PrivyProviderClient from "@/components/providers/PrivyProviderClient";

describe("PrivyProviderClient", () => {
  it("passes ordered walletList into PrivyProvider", () => {
    const { container } = render(
      <PrivyProviderClient appId="test">child</PrivyProviderClient>
    );

    const attr = container.querySelector("div")?.getAttribute("data-walletlist");
    expect(attr).toContain("detected_solana_wallets");
  });
});
