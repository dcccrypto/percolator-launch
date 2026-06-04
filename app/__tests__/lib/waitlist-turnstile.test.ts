/**
 * Cloudflare Turnstile server-side verification posture.
 *
 * The wire format to siteverify is fixed by Cloudflare's docs and pinned
 * here so a future refactor can't switch to JSON, drop the remoteip
 * hint, or change the secret-handling. The prod / non-prod fail-mode
 * inversion is the load-bearing security property: missing secret in
 * prod rejects, missing secret in dev accepts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyTurnstile } from "../../lib/waitlist/turnstile";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.TURNSTILE_SECRET;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("verifyTurnstile", () => {
  it("fails CLOSED in production when TURNSTILE_SECRET is missing", async () => {
    process.env.NODE_ENV = "production";
    const v = await verifyTurnstile("any-token", "203.0.113.10");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("not_configured");
  });

  it("fails OPEN in non-production when TURNSTILE_SECRET is missing", async () => {
    process.env.NODE_ENV = "development";
    const v = await verifyTurnstile("any-token", "203.0.113.10");
    expect(v.ok).toBe(true);
  });

  it("rejects empty / missing tokens even with a secret configured", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    const a = await verifyTurnstile(null, "203.0.113.10");
    const b = await verifyTurnstile(undefined, "203.0.113.10");
    const c = await verifyTurnstile("", "203.0.113.10");
    for (const v of [a, b, c]) {
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("missing_token");
    }
  });

  it("returns ok:true when Cloudflare reports success:true", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );
    const v = await verifyTurnstile("good-token", "203.0.113.10");
    expect(v.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns ok:false with verification_failed when success:false", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 200 }),
    );
    const v = await verifyTurnstile("bad-token", "203.0.113.10");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("verification_failed");
  });

  it("returns ok:false with verification_error on Cloudflare 5xx", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("Bad Gateway", { status: 502 }),
    );
    const v = await verifyTurnstile("any-token", "203.0.113.10");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("verification_error");
  });

  it("returns ok:false with verification_error on network throw (fail-CLOSED)", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    const v = await verifyTurnstile("any-token", "203.0.113.10");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("verification_error");
  });

  it("forwards secret + response + remoteip in URL-encoded body", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    let capturedBody = "";
    vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    await verifyTurnstile("the-token", "203.0.113.10");
    const params = new URLSearchParams(capturedBody);
    expect(params.get("secret")).toBe("test-secret");
    expect(params.get("response")).toBe("the-token");
    expect(params.get("remoteip")).toBe("203.0.113.10");
  });

  it("omits remoteip when no client IP was extracted", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    let capturedBody = "";
    vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    await verifyTurnstile("the-token", null);
    const params = new URLSearchParams(capturedBody);
    expect(params.has("remoteip")).toBe(false);
  });

  it("POSTs to Cloudflare's canonical siteverify URL", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    let capturedUrl = "";
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    await verifyTurnstile("the-token", null);
    expect(capturedUrl).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
  });
});
