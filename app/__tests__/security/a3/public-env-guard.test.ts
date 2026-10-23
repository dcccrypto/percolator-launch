/**
 * S3-C10 (fix-all 2026-10-18): a NEXT_PUBLIC_* RPC key must never be inlined into the browser
 * bundle. next.config.ts strips any such variable before the build compiles.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { findPublicRpcKeyLeaks, stripPublicRpcKeys, urlEmbeddedKey } from "@/lib/public-env-guard";

describe("S3-C10 public env guard", () => {
  it("flags an api-key in any NEXT_PUBLIC_* RPC URL and a raw NEXT_PUBLIC_HELIUS_API_KEY", () => {
    const env = {
      NEXT_PUBLIC_HELIUS_RPC_URL: "https://devnet.helius-rpc.com/?api-key=SECRET1",
      NEXT_PUBLIC_SOLANA_RPC_URL: "https://rpc.example/?apiKey=SECRET2",
      NEXT_PUBLIC_SOLANA_WS_URL: "wss://devnet.helius-rpc.com/?api_key=SECRET3",
      NEXT_PUBLIC_HELIUS_API_KEY: "SECRET4",
      NEXT_PUBLIC_OTHER_RPC: "https://user:pw@rpc.example/",
      HELIUS_DEVNET_API_KEY: "server-only-is-fine",
      DEVNET_RPC_URL: "https://devnet.helius-rpc.com/?api-key=server-only",
      NEXT_PUBLIC_DEFAULT_NETWORK: "devnet",
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    };
    expect(findPublicRpcKeyLeaks(env).map((l) => l.name)).toEqual([
      "NEXT_PUBLIC_HELIUS_API_KEY",
      "NEXT_PUBLIC_HELIUS_RPC_URL",
      "NEXT_PUBLIC_OTHER_RPC",
      "NEXT_PUBLIC_SOLANA_RPC_URL",
      "NEXT_PUBLIC_SOLANA_WS_URL",
    ]);
  });

  it("the WS-only key is public by design (as a var and inside a URL)", () => {
    const env = {
      NEXT_PUBLIC_HELIUS_WS_API_KEY: "WSKEY",
      NEXT_PUBLIC_SOLANA_WS_URL: "wss://devnet.helius-rpc.com/?api-key=WSKEY",
    };
    expect(findPublicRpcKeyLeaks(env)).toEqual([]);
  });

  it("strip removes the leaking vars and logs names only, never values", () => {
    const env: Record<string, string | undefined> = {
      NEXT_PUBLIC_HELIUS_RPC_URL: "https://devnet.helius-rpc.com/?api-key=SECRETVALUE",
      NEXT_PUBLIC_DEFAULT_NETWORK: "devnet",
    };
    const logs: string[] = [];
    expect(stripPublicRpcKeys(env, (m) => logs.push(m))).toEqual(["NEXT_PUBLIC_HELIUS_RPC_URL"]);
    expect(env.NEXT_PUBLIC_HELIUS_RPC_URL).toBeUndefined();
    expect(env.NEXT_PUBLIC_DEFAULT_NETWORK).toBe("devnet");
    expect(logs.join("\n")).toContain("NEXT_PUBLIC_HELIUS_RPC_URL");
    expect(logs.join("\n")).not.toContain("SECRETVALUE");
  });

  it("urlEmbeddedKey ignores non-URLs and keyless URLs", () => {
    expect(urlEmbeddedKey("devnet")).toBeNull();
    expect(urlEmbeddedKey("https://api.devnet.solana.com")).toBeNull();
    expect(urlEmbeddedKey("https://a.example/?api-key=K")).toBe("K");
  });
});

describe("S3-C10 next.config.ts runs the guard before the build", () => {
  const saved = process.env.NEXT_PUBLIC_HELIUS_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_HELIUS_API_KEY;
    else process.env.NEXT_PUBLIC_HELIUS_API_KEY = saved;
  });
  it("loading next.config.ts removes a NEXT_PUBLIC_HELIUS_API_KEY from the build env", async () => {
    process.env.NEXT_PUBLIC_HELIUS_API_KEY = "LEAK";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    await import("../../../next.config");
    err.mockRestore();
    expect(process.env.NEXT_PUBLIC_HELIUS_API_KEY).toBeUndefined();
  });
});
