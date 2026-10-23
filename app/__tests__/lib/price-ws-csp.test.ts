import { describe, it, expect } from "vitest";
import { priceWsConnectSrc } from "../../lib/price-ws-csp";

describe("priceWsConnectSrc (CSP connect-src for NEXT_PUBLIC_WS_URL)", () => {
  it("allows exactly the configured wss origin and its https twin", () => {
    expect(priceWsConnectSrc("wss://unnecessary-lime-whom-negotiations.trycloudflare.com")).toBe(
      "wss://unnecessary-lime-whom-negotiations.trycloudflare.com https://unnecessary-lime-whom-negotiations.trycloudflare.com ",
    );
    expect(priceWsConnectSrc("wss://price.example.com:8443/feed?x=1")).toBe("wss://price.example.com:8443 https://price.example.com:8443 ");
  });
  it("adds nothing for unset, insecure, malformed or credentialed URLs", () => {
    for (const v of [undefined, "", "ws://example.com", "https://example.com", "not a url", "wss://user:pw@example.com"]) {
      expect(priceWsConnectSrc(v)).toBe("");
    }
  });
});
