/**
 * Source-pattern guards for the waitlist signup route's IP capture +
 * per-IP rate limit. Mirrors the existing waitlist-signup-shape style
 * — greps the route source so a future refactor can't silently drop
 * the IP write, lose the rate-limit gate, or move the limit so it
 * fires before the idempotent-refresh fast-path (which would block
 * honest users from reloading their own waitlist row).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROUTE_PATH = path.resolve(
  __dirname,
  "../../app/api/waitlist/signup/route.ts",
);

describe("/api/waitlist/signup IP capture + rate limit", () => {
  it("imports getClientIp + hashIp from the dedicated helper module", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    expect(source).toContain(
      `import { getClientIp, hashIp } from "@/lib/waitlist/client-ip"`,
    );
  });

  it("extracts the client IP from the request headers", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    expect(source).toMatch(/const\s+clientIp\s*=\s*getClientIp\(req\.headers\)/);
  });

  it("derives the IP hash with the WAITLIST_IP_SALT env var", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    expect(source).toContain(
      "hashIp(clientIp, process.env.WAITLIST_IP_SALT)",
    );
  });

  it("writes ip_address and ip_hash onto the inserted row", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    expect(source).toMatch(/baseRow\.ip_address\s*=\s*clientIp/);
    expect(source).toMatch(/baseRow\.ip_hash\s*=\s*clientIpHash/);
  });

  it("rate-limits per IP and returns 429 when the cap is exceeded", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    expect(source).toContain("getIpLimiter()");
    expect(source).toMatch(
      /too many signups from this network — try again later/,
    );
    expect(source).toMatch(/status:\s*429/);
  });

  it("places the per-IP rate limit AFTER the sign-in fast-path", () => {
    // The fast-path returns idempotently for existing wallet signups
    // before the rate limit runs; otherwise honest users refreshing
    // their row would consume the per-IP budget and eventually get
    // 429'd from their own waitlist page.
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    const fastPathIdx = source.indexOf("Sign-in fast path for existing");
    const ipLimitIdx = source.indexOf("Per-IP rate limit");
    expect(fastPathIdx).toBeGreaterThan(0);
    expect(ipLimitIdx).toBeGreaterThan(0);
    expect(ipLimitIdx).toBeGreaterThan(fastPathIdx);
  });

  it("uses sha256 of the raw IP as the Redis key, never the cleartext", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    // The ipRateKey helper hashes the IP before it becomes the Redis
    // key. The route must call that helper, not pass the raw IP.
    expect(source).toContain("ipRateKey(clientIp)");
    expect(source).toMatch(
      /createHash\("sha256"\)\.update\(ip\)\.digest\("hex"\)/,
    );
  });
});
