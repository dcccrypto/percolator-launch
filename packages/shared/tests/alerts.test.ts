import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the logger before importing the module under test
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  sendAlert,
  sendCriticalAlert,
  sendWarningAlert,
  sendInfoAlert,
} from "../src/alerts.js";

// ============================================================================
// Setup
// ============================================================================

describe("alerts", () => {
  let originalEnv: string | undefined;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = process.env.DISCORD_ALERT_WEBHOOK;
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DISCORD_ALERT_WEBHOOK = originalEnv;
    } else {
      delete process.env.DISCORD_ALERT_WEBHOOK;
    }
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // No webhook configured
  // ==========================================================================

  describe("when DISCORD_ALERT_WEBHOOK is not set", () => {
    beforeEach(() => {
      delete process.env.DISCORD_ALERT_WEBHOOK;
    });

    it("sendAlert does not call fetch", async () => {
      await sendAlert("test message", "critical");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("sendCriticalAlert does not call fetch", async () => {
      await sendCriticalAlert("test");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("sendWarningAlert does not call fetch", async () => {
      await sendWarningAlert("test");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("sendInfoAlert does not call fetch", async () => {
      await sendInfoAlert("test");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Webhook configured
  // ==========================================================================

  describe("when DISCORD_ALERT_WEBHOOK is set", () => {
    const webhookUrl = "https://discord.com/api/webhooks/12345/abcdef";

    beforeEach(() => {
      process.env.DISCORD_ALERT_WEBHOOK = webhookUrl;
    });

    it("sendAlert calls fetch with correct URL", async () => {
      await sendAlert("test message", "info");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe(webhookUrl);
    });

    it("sends POST request with JSON content type", async () => {
      await sendAlert("test", "info");
      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends correct embed structure for critical alert", async () => {
      await sendAlert("Server down!", "critical", [
        { name: "Service", value: "API", inline: true },
      ]);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.embeds).toHaveLength(1);
      const embed = body.embeds[0];
      expect(embed.title).toContain("CRITICAL");
      expect(embed.title).toContain("🚨");
      expect(embed.description).toBe("Server down!");
      expect(embed.color).toBe(0xdc2626); // Red
      expect(embed.timestamp).toBeTruthy();
      expect(embed.fields).toHaveLength(1);
      expect(embed.fields[0]).toEqual({
        name: "Service",
        value: "API",
        inline: true,
      });
    });

    it("sends correct embed for warning alert", async () => {
      await sendAlert("High CPU", "warning");

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const embed = body.embeds[0];
      expect(embed.title).toContain("WARNING");
      expect(embed.title).toContain("⚠️");
      expect(embed.color).toBe(0xf59e0b); // Amber
    });

    it("sends correct embed for info alert", async () => {
      await sendAlert("Deploy complete", "info");

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const embed = body.embeds[0];
      expect(embed.title).toContain("INFO");
      expect(embed.title).toContain("ℹ️");
      expect(embed.color).toBe(0x3b82f6); // Blue
    });

    it("embed timestamp is valid ISO string", async () => {
      await sendAlert("test", "info");

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const ts = body.embeds[0].timestamp;
      expect(() => new Date(ts).toISOString()).not.toThrow();
    });

    it("fields are optional (undefined when not provided)", async () => {
      await sendAlert("simple message", "info");

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      // fields should be undefined since we didn't pass any
      expect(body.embeds[0].fields).toBeUndefined();
    });
  });

  // ==========================================================================
  // Convenience wrappers
  // ==========================================================================

  describe("convenience wrappers", () => {
    beforeEach(() => {
      process.env.DISCORD_ALERT_WEBHOOK = "https://hooks.example.com/test";
    });

    it("sendCriticalAlert sends with critical severity", async () => {
      await sendCriticalAlert("DB connection lost");
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.embeds[0].title).toContain("CRITICAL");
    });

    it("sendWarningAlert sends with warning severity", async () => {
      await sendWarningAlert("Slow response times");
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.embeds[0].title).toContain("WARNING");
    });

    it("sendInfoAlert sends with info severity", async () => {
      await sendInfoAlert("Market added");
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.embeds[0].title).toContain("INFO");
    });

    it("sendCriticalAlert passes fields through", async () => {
      const fields = [{ name: "Error", value: "Timeout" }];
      await sendCriticalAlert("Failure", fields);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.embeds[0].fields).toEqual(fields);
    });
  });

  // ==========================================================================
  // Error handling
  // ==========================================================================

  describe("error handling", () => {
    beforeEach(() => {
      process.env.DISCORD_ALERT_WEBHOOK = "https://hooks.example.com/test";
    });

    it("does not throw when fetch returns non-ok response", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "rate limited",
      });

      // Should not throw
      await expect(sendAlert("test", "info")).resolves.toBeUndefined();
    });

    it("does not throw when fetch rejects", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network error"));

      // Should not throw
      await expect(sendAlert("test", "critical")).resolves.toBeUndefined();
    });

    it("does not throw for non-Error rejection", async () => {
      fetchSpy.mockRejectedValueOnce("string error");

      await expect(sendAlert("test", "warning")).resolves.toBeUndefined();
    });
  });
});
