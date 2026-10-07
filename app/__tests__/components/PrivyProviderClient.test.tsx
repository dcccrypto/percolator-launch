import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useContext } from "react";
import { Keypair } from "@solana/web3.js";
import * as Sentry from "@sentry/nextjs";

// Mock Sentry so the GH#2594 diagnosability path can be asserted on.
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(), // used by the sibling SentryUserContext this tree also mounts
}));

/**
 * These tests exercise `signAllTransactions`' ATTEMPT-1/2/3 branching and the
 * GH#2594 diagnosability report, not real wire-format transaction
 * serialization (that's covered elsewhere) — a real `Transaction.serialize()`
 * round-trip in a happy-dom test environment hits an unrelated
 * @solana/buffer-layout Uint8Array/Buffer realm mismatch. `FakeTransaction`
 * gives `.serialize()` / `Transaction.from()` just enough shape for the code
 * under test (which only ever passes the bytes through, never inspects them)
 * while everything else — `PublicKey`, `Keypair` — is the real module.
 */
// vi.mock factories are hoisted above the whole file, so FakeTransaction must
// be created inside vi.hoisted() — a plain top-level `class` binding is in the
// TDZ at the point the (hoisted) factory below would reference it.
const { FakeTransaction } = vi.hoisted(() => {
  class FakeTransaction {
    tag: string;
    constructor(tag: string) {
      this.tag = tag;
    }
    serialize(): Uint8Array {
      return new TextEncoder().encode(this.tag);
    }
    static from(buf: Uint8Array): FakeTransaction {
      return new FakeTransaction(new TextDecoder().decode(buf));
    }
  }
  return { FakeTransaction };
});

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return { ...actual, Transaction: FakeTransaction };
});

const mockUsePrivy = vi.fn();
const mockUseWallets = vi.fn();
const mockUseLogin = vi.fn();
const mockLogin = vi.fn();
const mockUseConnectWallet = vi.fn();
const mockConnectWallet = vi.fn();
// The variadic Privy signer (`useSignTransaction().signTransaction`) — this is
// the ATTEMPT 3 fallback `signAllTransactions` reaches when the wallet has no
// wallet-standard batch-signing feature. It still resolves with N signed
// transactions, which is exactly why the degradation needs its own report.
const mockPrivySignTransaction = vi.fn();

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
  useLogin: (callbacks: any) => {
    mockUseLogin(callbacks);
    return { login: mockLogin };
  },
  useConnectWallet: (callbacks: any) => {
    mockUseConnectWallet(callbacks);
    return { connectWallet: mockConnectWallet };
  },
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  toSolanaWalletConnectors: () => [],
  useWallets: () => mockUseWallets(),
  // A vi.mock factory REPLACES the module, so every hook the provider imports
  // must be listed here or the import throws before any test runs. These four
  // are what PrivyProviderClient builds its WalletApi from.
  useSignTransaction: () => ({ signTransaction: mockPrivySignTransaction }),
  useSignAndSendTransaction: () => ({ signAndSendTransaction: vi.fn() }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
}));

import PrivyProviderClient from "@/components/providers/PrivyProviderClient";
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { PreferredWalletContext } from "@/hooks/usePreferredWallet";

/** Reads the WalletApi injected by PrivyProviderClient's inner bridge and
 *  reports it back to the test via a plain callback (no state needed —
 *  the test awaits `waitFor` until the captured value has the shape it wants). */
function ApiCapture({ onApi }: { onApi: (api: WalletApi) => void }) {
  const api = useContext(WalletApiContext);
  onApi(api);
  return null;
}

function makeTx(tag: string) {
  return new FakeTransaction(tag) as unknown as import("@solana/web3.js").Transaction;
}

describe("PrivyProviderClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePrivy.mockReturnValue({ ready: true, authenticated: true, login: vi.fn(), logout: vi.fn() });
    mockUseWallets.mockReturnValue({ wallets: [] });
  });

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

  it("binds the Solana account actually used by the central Privy login bridge", () => {
    const setPreferredAddress = vi.fn();

    render(
      <PreferredWalletContext.Provider
        value={{
          preferredAddress: "PHANTOM_OLD_ADDRESS",
          setPreferredAddress,
        }}
      >
        <PrivyProviderClient appId="test">
          child
        </PrivyProviderClient>
      </PreferredWalletContext.Provider>,
    );

    const callbacks = mockUseLogin.mock.calls[0]?.[0];
    expect(callbacks?.onComplete).toBeTypeOf("function");

    act(() => {
      callbacks.onComplete({
        user: {},
        isNewUser: false,
        wasAlreadyAuthenticated: false,
        loginMethod: "wallet",
        loginAccount: {
          type: "wallet",
          address: "SOLFLARE_BRIDGE_LOGIN_ADDRESS",
          chainType: "solana",
          walletClientType: "solflare",
        },
      });
    });

    expect(setPreferredAddress).toHaveBeenCalledTimes(1);
    expect(setPreferredAddress).toHaveBeenCalledWith(
      "SOLFLARE_BRIDGE_LOGIN_ADDRESS",
    );
  });

  describe("signAllTransactions diagnosability (GH#2594)", () => {
    /** A connected wallet with no `standardWallet` batch-signing feature and
     *  no top-level variadic `signTransaction` — both of signAllTransactions'
     *  wallet-standard attempts structurally miss, so it always falls to the
     *  ATTEMPT 3 Privy-signer fallback. */
    function mockNonBatchingWallet() {
      mockUseWallets.mockReturnValue({
        wallets: [{ address: Keypair.generate().publicKey.toBase58() }],
      });
    }

    async function getApi(): Promise<WalletApi> {
      let captured: WalletApi | undefined;
      render(
        <PrivyProviderClient appId="test">
          <ApiCapture onApi={(api) => { captured = api; }} />
        </PrivyProviderClient>
      );
      await waitFor(() => expect(typeof captured?.signAllTransactions).toBe("function"));
      return captured!;
    }

    it("reports to Sentry when a multi-tx batch degrades to Privy's per-tx signer", async () => {
      mockNonBatchingWallet();
      mockPrivySignTransaction.mockImplementation(async (...inputs: Array<{ transaction: Uint8Array }>) =>
        inputs.map((i) => ({ signedTransaction: i.transaction }))
      );

      const api = await getApi();
      const signed = await api.signAllTransactions!([makeTx("a"), makeTx("b"), makeTx("c")]);

      expect(signed).toHaveLength(3);
      expect(mockPrivySignTransaction).toHaveBeenCalledTimes(1); // one variadic call, not 3 separate ones
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining("degraded to Privy's per-tx signer"),
        "warning",
      );
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining("3-tx batch"),
        "warning",
      );
    });

    it("does NOT report to Sentry for a single-transaction sign (nothing to degrade)", async () => {
      mockNonBatchingWallet();
      mockPrivySignTransaction.mockImplementation(async (...inputs: Array<{ transaction: Uint8Array }>) =>
        inputs.map((i) => ({ signedTransaction: i.transaction }))
      );

      const api = await getApi();
      await api.signAllTransactions!([makeTx("only")]);

      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  describe("embedded-wallet batch = one approval", () => {
    /** A connected wallet whose standardWallet answers `solana:signTransaction`.
     *  `privy: true` builds Privy's embedded wallet (isPrivyWallet + "privy:"
     *  feature); otherwise an external wallet like Phantom. */
    function mockStandardWallet(privy: boolean) {
      const address = Keypair.generate().publicKey.toBase58();
      const featureSign = vi.fn(async (...inputs: Array<{ transaction: Uint8Array }>) =>
        inputs.map((i) => ({ signedTransaction: i.transaction })),
      );
      const features: Record<string, unknown> = { "solana:signTransaction": { signTransaction: featureSign } };
      if (privy) features["privy:"] = { privy: {} };
      mockUseWallets.mockReturnValue({
        wallets: [{
          address,
          standardWallet: { isPrivyWallet: privy || undefined, features, accounts: [{ address }] },
        }],
      });
      return featureSign;
    }

    async function getApi(): Promise<WalletApi> {
      let captured: WalletApi | undefined;
      render(
        <PrivyProviderClient appId="test">
          <ApiCapture onApi={(api) => { captured = api; }} />
        </PrivyProviderClient>
      );
      await waitFor(() => expect(typeof captured?.signAllTransactions).toBe("function"));
      return captured!;
    }

    it("shows Privy's modal on the first tx only and signs the rest without one", async () => {
      const featureSign = mockStandardWallet(true);
      const api = await getApi();
      const signed = await api.signAllTransactions!([makeTx("a"), makeTx("b"), makeTx("c")]);

      expect(signed).toHaveLength(3);
      expect(featureSign).toHaveBeenCalledTimes(1);
      const inputs = featureSign.mock.calls[0] as Array<{ options?: { uiOptions?: { showWalletUIs?: boolean; buttonText?: string } } }>;
      expect(inputs[0].options?.uiOptions?.showWalletUIs).not.toBe(false);
      expect(inputs[0].options?.uiOptions?.buttonText).toBe("Approve all 3");
      expect(inputs[1].options?.uiOptions?.showWalletUIs).toBe(false);
      expect(inputs[2].options?.uiOptions?.showWalletUIs).toBe(false);
      expect(mockPrivySignTransaction).not.toHaveBeenCalled();
    });

    it("passes no UI options to an external wallet (it already approves the batch once)", async () => {
      const featureSign = mockStandardWallet(false);
      const api = await getApi();
      await api.signAllTransactions!([makeTx("a"), makeTx("b")]);

      const inputs = featureSign.mock.calls[0] as Array<{ options?: unknown }>;
      expect(inputs.every((i) => i.options === undefined)).toBe(true);
    });
  });
});
