/**
 * #3320: the bridge exposes the Privy session headers (access + identity token) to code outside the
 * Privy tree, so a server route that verifies the Privy session can be called with no wallet prompt.
 * Signed out => null (the caller then asks nothing and fails open).
 */
import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn() }));

const h = vi.hoisted(() => ({
  privy: { ready: true, authenticated: true, getAccessToken: async () => "ACCESS" as string | null, user: null as unknown },
  idToken: "IDTOK" as string | null,
}));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: any) => <>{children}</>,
  usePrivy: () => h.privy,
  useIdentityToken: () => ({ identityToken: h.idToken }),
  useLogin: () => ({ login: vi.fn() }),
  useConnectWallet: () => ({ connectWallet: vi.fn() }),
}));
vi.mock("@privy-io/react-auth/solana", () => ({
  toSolanaWalletConnectors: () => [],
  useWallets: () => ({ ready: true, wallets: [] }),
  useSignTransaction: () => ({ signTransaction: vi.fn() }),
  useSignAndSendTransaction: () => ({ signAndSendTransaction: vi.fn() }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
}));

import PrivyProviderClient from "@/components/providers/PrivyProviderClient";
import { usePrivySessionHeaders, type PrivySessionHeaders } from "@/hooks/usePrivySafe";

function Probe({ out }: { out: { get?: PrivySessionHeaders | null } }) {
  const get = usePrivySessionHeaders();
  useEffect(() => { out.get = get; });
  return null;
}
const read = async () => {
  const out: { get?: PrivySessionHeaders | null } = {};
  render(<PrivyProviderClient appId="test"><Probe out={out} /></PrivyProviderClient>);
  await waitFor(() => expect(out.get).toBeTruthy());
  return out.get!;
};

describe("Privy session headers", () => {
  beforeEach(() => {
    h.privy = { ready: true, authenticated: true, getAccessToken: async () => "ACCESS", user: null };
    h.idToken = "IDTOK";
  });

  it("signed in: Bearer access token and the identity token", async () => {
    expect(await (await read())()).toEqual({ Authorization: "Bearer ACCESS", "x-privy-id-token": "IDTOK" });
  });

  it("no identity token yet: only the access token (the server then links no wallet and refuses)", async () => {
    h.idToken = null;
    expect(await (await read())()).toEqual({ Authorization: "Bearer ACCESS" });
  });

  it("signed out, or no access token: null", async () => {
    h.privy = { ...h.privy, authenticated: false };
    expect(await (await read())()).toBeNull();
    h.privy = { ...h.privy, authenticated: true, getAccessToken: async () => null };
    expect(await (await read())()).toBeNull();
  });
});

describe("without Privy mounted", () => {
  it("the hook is null (plain wallet adapter)", () => {
    const out: { get?: PrivySessionHeaders | null } = { get: undefined };
    render(<Probe out={out} />);
    expect(out.get).toBeNull();
  });
});
