/**
 * Waitlist signup — bot user-agent gate.
 *
 * Complements the Turnstile + rate-limit defenses: a cheap pre-filter that
 * rejects scripted clients (python/curl/aiohttp/etc. + the wave's hardcoded
 * Chrome/120 spoof + missing/stub UAs) before the network Turnstile verify.
 * Real browsers and wallet in-app browsers never match.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROUTE = path.resolve(__dirname, "../../app/api/waitlist/signup/route.ts");

describe("/api/waitlist/signup bot user-agent gate", () => {
  const source = fs.readFileSync(ROUTE, "utf8");

  it("defines a bot user-agent matcher covering scripted clients", () => {
    expect(source).toContain("isBotUserAgent");
    expect(source).toMatch(/python|aiohttp|requests|urllib|curl/i);
  });

  it("blocks the hardcoded Chrome/120 spoof (escape hatch via env)", () => {
    expect(source).toMatch(/Chrome\\\/120\\\.0\\\.0\\\.0 Safari/);
    expect(source).toContain("WAITLIST_ALLOW_CHROME120");
  });

  it("invokes the gate in the handler and rejects with 403", () => {
    expect(source).toMatch(/if \(isBotUserAgent\(userAgent\)\)/);
    const idx = source.indexOf("if (isBotUserAgent(userAgent))");
    expect(source.slice(idx, idx + 200)).toMatch(/status:\s*403/);
  });
});
