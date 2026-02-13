/**
 * HeliusWebhookManager Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Config mock ─────────────────────────────────────────────────────────────

const { mockConfig } = vi.hoisted(() => {
  const mockConfig: Record<string, any> = {};
  return { mockConfig };
});

vi.mock("../../src/config.js", () => ({
  config: mockConfig,
}));

import { HeliusWebhookManager } from "../../src/services/HeliusWebhookManager.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HeliusWebhookManager", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Reset config for each test
    Object.assign(mockConfig, {
      heliusApiKey: "test-api-key",
      webhookUrl: "https://my-server.com",
      webhookSecret: "my-secret",
      allProgramIds: ["FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD"],
      rpcUrl: "https://api.devnet.solana.com",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("skips registration when no API key", async () => {
    mockConfig.heliusApiKey = "";
    const mgr = new HeliusWebhookManager();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    await mgr.start();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips registration when no webhook URL", async () => {
    mockConfig.webhookUrl = "";
    const mgr = new HeliusWebhookManager();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    await mgr.start();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates new webhook when none exists", async () => {
    const mgr = new HeliusWebhookManager();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [], // no existing webhooks
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ webhookID: "new-webhook-123" }),
      }) as any;

    await mgr.start();

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    // Second call is POST to create
    const createCall = (globalThis.fetch as any).mock.calls[1];
    expect(createCall[1].method).toBe("POST");
    const body = JSON.parse(createCall[1].body);
    expect(body.webhookURL).toBe("https://my-server.com/webhook/trades");
    expect(body.webhookType).toBe("enhancedDevnet");
  });

  it("updates existing webhook when URL matches", async () => {
    const mgr = new HeliusWebhookManager();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { webhookID: "existing-456", webhookURL: "https://my-server.com/webhook/trades" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      }) as any;

    await mgr.start();

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const updateCall = (globalThis.fetch as any).mock.calls[1];
    expect(updateCall[1].method).toBe("PUT");
    expect(updateCall[0]).toContain("existing-456");
  });

  it("sets network=devnet when RPC URL contains devnet", async () => {
    mockConfig.rpcUrl = "https://devnet.helius-rpc.com/?api-key=abc";
    const mgr = new HeliusWebhookManager();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ webhookID: "dev-hook" }) }) as any;

    await mgr.start();

    const body = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);
    expect(body.webhookType).toBe("enhancedDevnet");
  });

  it("does not set network field for mainnet RPC", async () => {
    mockConfig.rpcUrl = "https://mainnet.helius-rpc.com/?api-key=abc";
    const mgr = new HeliusWebhookManager();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ webhookID: "main-hook" }) }) as any;

    await mgr.start();

    const body = JSON.parse((globalThis.fetch as any).mock.calls[1][1].body);
    expect(body.webhookType).toBe("enhanced");
  });

  it("handles API errors gracefully (falls back to polling)", async () => {
    const mgr = new HeliusWebhookManager();
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("Network error")) as any;

    // Should not throw
    await expect(mgr.start()).resolves.toBeUndefined();
  });
});
