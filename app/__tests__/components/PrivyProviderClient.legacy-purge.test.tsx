// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

// Records what localStorage looked like the moment PrivyProvider first renders
// (the SDK's earliest possible storage read).
const { seen } = vi.hoisted(() => ({ seen: { refreshAtProviderRender: "unset" as string | null } }));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn() }));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => {
    seen.refreshAtProviderRender = localStorage.getItem("privy:refresh_token");
    return <>{children}</>;
  },
  usePrivy: () => ({ ready: true, authenticated: false, logout: vi.fn() }),
  useIdentityToken: () => ({ identityToken: null }),
  useLogin: () => ({ login: vi.fn() }),
  useConnectWallet: () => ({ connectWallet: vi.fn() }),
}));
vi.mock("@privy-io/react-auth/solana", () => ({
  toSolanaWalletConnectors: () => [],
  useWallets: () => ({ wallets: [] }),
  useSignTransaction: () => ({ signTransaction: vi.fn() }),
  useSignAndSendTransaction: () => ({ signAndSendTransaction: vi.fn() }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
}));

describe("PrivyProviderClient boot purge", () => {
  it("legacy tokens are gone before PrivyProvider renders", async () => {
    localStorage.setItem("privy:token", JSON.stringify("tok"));
    localStorage.setItem("privy:refresh_token", JSON.stringify("legacy-real-token"));
    const { default: PrivyProviderClient } = await import("@/components/providers/PrivyProviderClient");
    render(<PrivyProviderClient appId="test-app">{null}</PrivyProviderClient>);
    expect(seen.refreshAtProviderRender).toBeNull();
    expect(localStorage.getItem("privy:token")).toBeNull();
  });
});
