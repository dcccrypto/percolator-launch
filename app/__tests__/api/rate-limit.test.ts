import { NextRequest } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// No UPSTASH env vars → always in-memory fallback

function makeReq(ip: string): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    method: "POST",
    headers: { "x-real-ip": ip },
  });
}

describe("rate-limit", () => {
  describe("getClientIp", () => {
    it("prefers x-real-ip over x-forwarded-for", () => {
      const req = new NextRequest("http://localhost/api/test", {
        method: "GET",
        headers: {
          "x-real-ip": "1.2.3.4",
          "x-forwarded-for": "5.6.7.8, 9.10.11.12",
        },
      });
      expect(getClientIp(req)).toBe("1.2.3.4");
    });

    it("falls back to x-forwarded-for first entry", () => {
      const req = new NextRequest("http://localhost/api/test", {
        method: "GET",
        headers: { "x-forwarded-for": "5.6.7.8, 9.10.11.12" },
      });
      expect(getClientIp(req)).toBe("5.6.7.8");
    });

    it("returns unknown when no headers", () => {
      const req = new NextRequest("http://localhost/api/test", {
        method: "GET",
      });
      expect(getClientIp(req)).toBe("unknown");
    });
  });

  describe("checkRateLimit (in-memory fallback)", () => {
    const config = { prefix: "test-rl-" + Date.now(), maxRequests: 3, windowSec: 60 };

    it("allows requests under the limit", async () => {
      const ip = "10.0.0." + Math.floor(Math.random() * 255);
      for (let i = 0; i < 3; i++) {
        const res = await checkRateLimit(makeReq(ip), config);
        expect(res).toBeNull();
      }
    });

    it("returns 429 when limit is exceeded", async () => {
      const ip = "10.1.0." + Math.floor(Math.random() * 255);
      for (let i = 0; i < 3; i++) {
        await checkRateLimit(makeReq(ip), config);
      }
      const res = await checkRateLimit(makeReq(ip), config);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(429);
      const body = await res!.json();
      expect(body.error).toMatch(/rate limit/i);
    });

    it("does not cross-contaminate different IPs", async () => {
      const ipA = "10.2.0." + Math.floor(Math.random() * 255);
      const ipB = "10.3.0." + Math.floor(Math.random() * 255);
      for (let i = 0; i < 3; i++) {
        await checkRateLimit(makeReq(ipA), config);
      }
      // ipA exhausted, but ipB should be fine
      const res = await checkRateLimit(makeReq(ipB), config);
      expect(res).toBeNull();
    });

    it("includes Retry-After header in 429 response", async () => {
      const ip = "10.4.0." + Math.floor(Math.random() * 255);
      for (let i = 0; i < 3; i++) {
        await checkRateLimit(makeReq(ip), config);
      }
      const res = await checkRateLimit(makeReq(ip), config);
      expect(res!.headers.get("Retry-After")).toBeTruthy();
      expect(Number(res!.headers.get("X-RateLimit-Remaining"))).toBe(0);
    });
  });
});
