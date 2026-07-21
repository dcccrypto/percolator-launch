/**
 * PrivyProviderClient — config + the WalletApi bridge.
 *
 * `PrivyWalletApiBridge` is where the Privy → WalletApi derivation lives after
 * the bundle-split refactor (it was ported out of useWalletCompat.ts). It is
 * the code that decides which wallet is active and produces the signing
 * functions every transaction in the app goes through, so it is tested here
 * against the same cases useWallet.test.ts used to assert on the hook.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useContext } from "react";
import { PublicKey } from "@solana/web3.js";

const mockUsePrivy = vi.fn();
const mockUseWallets = vi.fn();
const mockUseSignTransaction = vi.fn();
const mockUseSignAndSendTransaction = vi.fn();
const mockUseSignMessage = vi.fn();
const mockUsePreferredWallet = vi.fn();

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
  usePrivy: () => mockUsePrivy(),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  toSolanaWalletConnectors: () => [],
  useWallets: () => mockUseWallets(),
  useSignTransaction: () => mockUseSignTransaction(),
  useSignAndSendTransaction: () => mockUseSignAndSendTransaction(),
  useSignMessage: () => mockUseSignMessage(),
}));

// @solana/kit builds real RPC transports; stub them so the provider mounts.
vi.mock("@solana/kit", () => ({
  createSolanaRpc: (url: string) => ({ url }),
  createSolanaRpcSubscriptions: (url: string) => ({ url }),
}));

vi.mock("@/hooks/usePreferredWallet", async () => {
  // resolveActiveWallet is pure selection logic — keep the real one so the
  // external-over-embedded preference is genuinely exercised here.
  const actual = await vi.importActual<
    typeof import("@/hooks/usePreferredWallet")
  >("@/hooks/usePreferredWallet");
  return {
    ...actual,
    usePreferredWallet: () => mockUsePreferredWallet(),
  };
});

vi.mock("@/components/providers/SentryUserContext", () => ({
  SentryUserContext: () => null,
}));

import PrivyProviderClient from "@/components/providers/PrivyProviderClient";
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";

const EXTERNAL_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const EMBEDDED_ADDR = "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

/** Captures the WalletApi the bridge injects so tests can assert on it. */
let captured: WalletApi;

function Probe() {
  captured = useContext(WalletApiContext);
  return <div data-testid="probe">{String(captured.connected)}</div>;
}

function renderBridge() {
  return render(
    <PrivyProviderClient appId="test">
      <Probe />
    </PrivyProviderClient>,
  );
}

const embeddedWallet = { address: EMBEDDED_ADDR, standardWallet: { name: "Privy" } };
const externalWallet = { address: EXTERNAL_ADDR, standardWallet: { name: "Phantom" } };

/** Privy state for "logged in and holding `wallets`". */
function authenticated(logout = vi.fn()) {
  return {
    ready: true,
    authenticated: true,
    user: { id: "1" },
    login: vi.fn(),
    logout,
  };
}

describe("PrivyProviderClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePrivy.mockReturnValue({
      ready: true,
      authenticated: false,
      user: null,
      login: vi.fn(),
      logout: vi.fn(),
    });
    mockUseWallets.mockReturnValue({ wallets: [] });
    mockUseSignTransaction.mockReturnValue({ signTransaction: vi.fn() });
    mockUseSignAndSendTransaction.mockReturnValue({ signAndSendTransaction: vi.fn() });
    mockUseSignMessage.mockReturnValue({ signMessage: vi.fn() });
    mockUsePreferredWallet.mockReturnValue({ preferredAddress: null });
  });

  it("configures solana-first wallet login", () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "walletconnect-test";
    const { container } = renderBridge();

    const wrapper = container.querySelector("div");
    expect(wrapper?.getAttribute("data-wallet-chain-type")).toBe("solana-only");
    expect(wrapper?.getAttribute("data-show-wallet-first")).toBe("true");
    expect(wrapper?.getAttribute("data-walletconnect")).toBe("walletconnect-test");
    expect(wrapper?.getAttribute("data-walletlist")).toContain("phantom");
    expect(wrapper?.getAttribute("data-walletlist")).toContain("solflare");
  });

  describe("WalletApi bridge — connection state", () => {
    it("reports disconnected when not authenticated", () => {
      renderBridge();

      expect(captured.connected).toBe(false);
      expect(captured.publicKey).toBeNull();
    });

    it("reports connected with a publicKey when authenticated with a wallet", () => {
      mockUsePrivy.mockReturnValue(authenticated());
      mockUseWallets.mockReturnValue({ wallets: [externalWallet] });

      renderBridge();

      expect(captured.connected).toBe(true);
      expect(captured.publicKey).toEqual(new PublicKey(EXTERNAL_ADDR));
    });

    it("stays disconnected when authenticated but holding no wallet", () => {
      mockUsePrivy.mockReturnValue(authenticated());
      mockUseWallets.mockReturnValue({ wallets: [] });

      renderBridge();

      expect(captured.connected).toBe(false);
      expect(captured.publicKey).toBeNull();
    });

    it("reports connecting until Privy is ready", () => {
      mockUsePrivy.mockReturnValue({
        ready: false,
        authenticated: false,
        user: null,
        login: vi.fn(),
        logout: vi.fn(),
      });

      renderBridge();

      expect(captured.connecting).toBe(true);
    });
  });

  describe("WalletApi bridge — active wallet selection", () => {
    it("prefers an external wallet over the Privy embedded one", () => {
      mockUsePrivy.mockReturnValue(authenticated());
      mockUseWallets.mockReturnValue({ wallets: [embeddedWallet, externalWallet] });

      renderBridge();

      expect(captured.publicKey?.toBase58()).toBe(EXTERNAL_ADDR);
    });

    it("falls back to the embedded wallet when there is no external one", () => {
      mockUsePrivy.mockReturnValue(authenticated());
      mockUseWallets.mockReturnValue({ wallets: [embeddedWallet] });

      renderBridge();

      expect(captured.publicKey?.toBase58()).toBe(EMBEDDED_ADDR);
    });

    it("honours an explicitly preferred wallet over the default heuristic", () => {
      mockUsePrivy.mockReturnValue(authenticated());
      mockUseWallets.mockReturnValue({ wallets: [embeddedWallet, externalWallet] });
      mockUsePreferredWallet.mockReturnValue({ preferredAddress: EMBEDDED_ADDR });

      renderBridge();

      expect(captured.publicKey?.toBase58()).toBe(EMBEDDED_ADDR);
    });
  });

  describe("WalletApi bridge — signing and disconnect", () => {
    it("exposes signMessage backed by Privy, bound to the active wallet", async () => {
      const signature = new Uint8Array([1, 2, 3]);
      const privySignMessage = vi.fn().mockResolvedValue({ signature });
      mockUsePrivy.mockReturnValue(authenticated());
      mockUseWallets.mockReturnValue({ wallets: [externalWallet] });
      mockUseSignMessage.mockReturnValue({ signMessage: privySignMessage });

      renderBridge();

      expect(captured.signMessage).toBeInstanceOf(Function);

      const message = new TextEncoder().encode("keeper-register:Slab111:12345");
      const sig = await captured.signMessage!(message);

      expect(privySignMessage).toHaveBeenCalledWith({ message, wallet: externalWallet });
      expect(sig).toBe(signature);
    });

    it("leaves the signing functions undefined when no wallet is connected", () => {
      renderBridge();

      // Callers gate on these being defined; a stub here would let the app
      // build transactions it cannot sign.
      expect(captured.signMessage).toBeUndefined();
      expect(captured.signTransaction).toBeUndefined();
      expect(captured.signAndSendTransaction).toBeUndefined();
      expect(captured.signAllTransactions).toBeUndefined();
    });

    it("exposes Privy's logout as disconnect", () => {
      const logout = vi.fn();
      mockUsePrivy.mockReturnValue(authenticated(logout));
      mockUseWallets.mockReturnValue({ wallets: [externalWallet] });

      renderBridge();

      expect(captured.disconnect).toBe(logout);
    });

    it("keeps the injected WalletApi referentially stable across re-renders", async () => {
      mockUsePrivy.mockReturnValue(authenticated());
      mockUseWallets.mockReturnValue({ wallets: [externalWallet] });

      const { rerender } = renderBridge();
      const first = captured;

      rerender(
        <PrivyProviderClient appId="test">
          <Probe />
        </PrivyProviderClient>,
      );
      await waitFor(() => expect(screen.getByTestId("probe")).toBeTruthy());

      // Consumers list the wallet in dep arrays; an unstable object here
      // re-fires every one of them on each render.
      expect(captured).toBe(first);
    });
  });
});
