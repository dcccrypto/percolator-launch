import { describe, it, expect } from "vitest";
import { sanitizeLogoUrl } from "@/lib/token-metadata-validators";

/**
 * sanitizeLogoUrl gates the attacker-suppliable market `logo_url` (POST
 * /api/markets body) to the same allowlist external-API metadata already
 * gets. It renders as an <img src>, so the danger is tracking-pixel /
 * phishing-image loads from an arbitrary host — bounded (an <img> can't run
 * javascript:), but real. Reject → null (fallback avatar), never throw.
 */
describe("sanitizeLogoUrl", () => {
  it("accepts a normal https CDN URL unchanged", () => {
    const u = "https://assets.coingecko.com/coins/images/4128/standard/solana.png";
    expect(sanitizeLogoUrl(u)).toBe(u);
  });

  it("accepts ipfs:// (app policy — browsers can't resolve it to a network hit anyway)", () => {
    const u = "ipfs://bafybeigdyrexample";
    expect(sanitizeLogoUrl(u)).toBe(u);
  });

  it("rejects javascript: scheme", () => {
    expect(sanitizeLogoUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: URIs (stored-blob / oversized-row vector)", () => {
    expect(sanitizeLogoUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBeNull();
  });

  it("rejects plain http (tracking beacon over cleartext)", () => {
    expect(sanitizeLogoUrl("http://attacker.example/px.gif")).toBeNull();
  });

  it("rejects a URL longer than the 500-char cap", () => {
    expect(sanitizeLogoUrl("https://a.example/" + "x".repeat(600))).toBeNull();
  });

  it("returns null for empty / non-string / nullish input without throwing", () => {
    expect(sanitizeLogoUrl(null)).toBeNull();
    expect(sanitizeLogoUrl(undefined)).toBeNull();
    expect(sanitizeLogoUrl("")).toBeNull();
    expect(sanitizeLogoUrl(123)).toBeNull();
    expect(sanitizeLogoUrl("not a url")).toBeNull();
  });
});
