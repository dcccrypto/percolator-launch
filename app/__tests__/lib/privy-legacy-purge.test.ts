// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { purgeLegacyPrivyState, PRIVY_LEGACY_TOKEN_KEYS } from "@/lib/privy-legacy-purge";

const seed = (refresh: string) => {
  localStorage.setItem("privy:token", JSON.stringify("tok"));
  localStorage.setItem("privy:refresh_token", refresh);
  localStorage.setItem("privy:pat", JSON.stringify("pat"));
  localStorage.setItem("privy:id_token", JSON.stringify("idt"));
  localStorage.setItem("percolator:preferred-wallet", "Wallet111");
  localStorage.setItem("wc@2:client:0.3//session", "{}");
  localStorage.setItem("privy:connections", "[]");
};

beforeEach(() => {
  localStorage.clear();
  document.cookie = "privy-session=t";
});

describe("purgeLegacyPrivyState", () => {
  it("removes the four token keys when the refresh token is a real (legacy) value", () => {
    seed(JSON.stringify("real-legacy-refresh-token"));
    expect(purgeLegacyPrivyState()).toBe(true);
    for (const k of PRIVY_LEGACY_TOKEN_KEYS) expect(localStorage.getItem(k)).toBeNull();
  });

  it("leaves preferred-wallet, WalletConnect, other privy keys and cookies alone", () => {
    seed(JSON.stringify("real-legacy-refresh-token"));
    purgeLegacyPrivyState();
    expect(localStorage.getItem("percolator:preferred-wallet")).toBe("Wallet111");
    expect(localStorage.getItem("wc@2:client:0.3//session")).toBe("{}");
    expect(localStorage.getItem("privy:connections")).toBe("[]");
    expect(document.cookie).toContain("privy-session=t");
  });

  it("is a no-op for the cookie-mode placeholder (JSON \"deprecated\")", () => {
    seed(JSON.stringify("deprecated"));
    expect(purgeLegacyPrivyState()).toBe(false);
    expect(localStorage.getItem("privy:token")).toBe(JSON.stringify("tok"));
    expect(localStorage.getItem("privy:refresh_token")).toBe('"deprecated"');
  });

  it("is a no-op when no refresh token exists", () => {
    localStorage.setItem("privy:token", JSON.stringify("tok"));
    expect(purgeLegacyPrivyState()).toBe(false);
    expect(localStorage.getItem("privy:token")).toBe(JSON.stringify("tok"));
  });

  it("treats non-JSON refresh values as legacy", () => {
    seed("not-json{");
    expect(purgeLegacyPrivyState()).toBe(true);
    expect(localStorage.getItem("privy:refresh_token")).toBeNull();
  });

  it("ignores non-string JSON values (SDK ignores them too)", () => {
    seed("null");
    expect(purgeLegacyPrivyState()).toBe(false);
  });

  it("is idempotent", () => {
    seed(JSON.stringify("real"));
    expect(purgeLegacyPrivyState()).toBe(true);
    expect(purgeLegacyPrivyState()).toBe(false);
  });

  it("never throws when localStorage access throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => purgeLegacyPrivyState()).not.toThrow();
    expect(purgeLegacyPrivyState()).toBe(false);
    spy.mockRestore();
  });
});
