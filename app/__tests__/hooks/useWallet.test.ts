/**
 * useWalletCompat / useConnectionCompat Hook Tests
 *
 * `useWalletCompat()` used to own the Privy integration. It no longer does:
 * the derivation moved into `PrivyWalletApiBridge` (PrivyProviderClient.tsx)
 * so that the 60+ call sites stop dragging @privy-io/react-auth into the
 * shared client bundle, and the hook became a pure `WalletApiContext` read.
 *
 * These tests therefore cover what the hook IS — a context read with a safe
 * read-only default. The Privy → WalletApi derivation they used to assert is
 * covered against the bridge itself, in
 * __tests__/components/PrivyProviderClient.test.tsx.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    rpcUrl: "https://example.com/api/rpc",
    network: "devnet",
    programId: "test",
  }),
  getWsEndpoint: () => "wss://api.devnet.solana.com",
  getRpcEndpoint: () => "https://example.com/api/rpc",
}));

import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  WalletApiContext,
  READ_ONLY_WALLET_API,
  type WalletApi,
} from "@/hooks/walletApiContext";

describe("useWalletCompat", () => {
  it("falls back to the read-only API when no wallet provider is mounted", () => {
    const { result } = renderHook(() => useWalletCompat());

    // Server-rendered pages and any tree outside a provider must degrade to
    // read-only rather than throwing — every call site reads this unguarded.
    expect(result.current).toBe(READ_ONLY_WALLET_API);
    expect(result.current.connected).toBe(false);
    expect(result.current.publicKey).toBeNull();
    expect(result.current.signTransaction).toBeUndefined();
    expect(result.current.signMessage).toBeUndefined();
  });

  it("returns the read-only disconnect as a no-op promise", async () => {
    const { result } = renderHook(() => useWalletCompat());
    await expect(result.current.disconnect()).resolves.toBeUndefined();
  });

  it("returns whatever WalletApi the mounted provider injected", () => {
    const publicKey = new PublicKey(
      "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    );
    const disconnect = vi.fn(async () => {});
    const signMessage = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const injected: WalletApi = {
      ...READ_ONLY_WALLET_API,
      publicKey,
      connected: true,
      signMessage,
      disconnect,
    };

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(WalletApiContext.Provider, { value: injected }, children);

    const { result } = renderHook(() => useWalletCompat(), { wrapper });

    expect(result.current).toBe(injected);
    expect(result.current.connected).toBe(true);
    expect(result.current.publicKey?.toBase58()).toBe(publicKey.toBase58());
    expect(result.current.signMessage).toBe(signMessage);
    expect(result.current.disconnect).toBe(disconnect);
  });

  it("imports no wallet SDK — the bundle-split invariant the refactor exists for", async () => {
    // If this ever fails, @privy-io/react-auth (and its WalletConnect /
    // Coinbase / viem graph) is back in the shared client bundle.
    const [fs, path] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await fs.readFile(
      path.join(process.cwd(), "hooks/useWalletCompat.ts"),
      "utf8",
    );

    // Match real import statements only — the file names both packages in
    // prose comments explaining why it must not import them.
    const imported = [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );

    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((s) => s.startsWith("@privy-io/"))).toEqual([]);
    expect(imported.filter((s) => s.startsWith("@solana/wallet-adapter"))).toEqual([]);
  });
});

describe("useConnectionCompat", () => {
  it("uses the configured RPC endpoint", () => {
    const { result } = renderHook(() => useConnectionCompat());
    expect((result.current.connection as any)._rpcEndpoint).toBe(
      "https://example.com/api/rpc",
    );
  });

  it("returns the same Connection instance across consumers", () => {
    // The singleton is the point: every consumer used to build its own
    // Connection, each a potential extra WS channel.
    const a = renderHook(() => useConnectionCompat());
    const b = renderHook(() => useConnectionCompat());
    expect(a.result.current.connection).toBe(b.result.current.connection);
  });
});
