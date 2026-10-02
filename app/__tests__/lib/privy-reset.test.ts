import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPrivyBrowserState, resetPrivyConnection } from "@/lib/privy-reset";

describe("privy-reset", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("removes only Privy's own storage keys", () => {
    localStorage.setItem("privy:token", "t");
    localStorage.setItem("privy:refresh_token", "r");
    localStorage.setItem("privy:app-id:recent-login-wallet-client", "solflare");
    localStorage.setItem("percolator:preferred-wallet", "keep");
    localStorage.setItem("wc@2:core:0.3//keychain", "keep");
    sessionStorage.setItem("privy:caid", "c");
    expect(clearPrivyBrowserState()).toBe(4);
    expect(localStorage.getItem("privy:token")).toBeNull();
    expect(localStorage.getItem("privy:app-id:recent-login-wallet-client")).toBeNull();
    expect(sessionStorage.getItem("privy:caid")).toBeNull();
    // NEGATIVE CONTROL: unrelated keys survive
    expect(localStorage.getItem("percolator:preferred-wallet")).toBe("keep");
    expect(localStorage.getItem("wc@2:core:0.3//keychain")).toBe("keep");
  });

  it("NEVER touches cookies: the shared Domain=percolator.trade privy-* session is Privy's to clear", () => {
    document.cookie = "privy-session=t; path=/";
    document.cookie = "privy-token=abc; path=/";
    document.cookie = "other=keep; path=/";
    clearPrivyBrowserState();
    expect(document.cookie).toContain("privy-session=t");
    expect(document.cookie).toContain("privy-token=abc");
    expect(document.cookie).toContain("other=keep");
  });

  it("is compatible with the #2950 legacy purge: token keys are gone, so the purge is a no-op after reload", () => {
    localStorage.setItem("privy:refresh_token", JSON.stringify("legacy-real-refresh-token"));
    localStorage.setItem("privy:token", JSON.stringify("t"));
    clearPrivyBrowserState();
    for (const k of ["privy:token", "privy:refresh_token", "privy:pat", "privy:id_token"]) {
      expect(localStorage.getItem(k)).toBeNull();
    }
  });

  it("logs out first, sweeps, then reloads", async () => {
    const order: string[] = [];
    localStorage.setItem("privy:token", "t");
    await resetPrivyConnection(
      async () => {
        order.push(`logout:${localStorage.getItem("privy:token")}`);
      },
      () => order.push(`reload:${localStorage.getItem("privy:token")}`),
    );
    expect(order).toEqual(["logout:t", "reload:null"]);
  });

  it("still sweeps and reloads when logout throws (no session to log out of)", async () => {
    localStorage.setItem("privy:token", "t");
    const reload = vi.fn();
    await resetPrivyConnection(() => Promise.reject(new Error("no session")), reload);
    expect(localStorage.getItem("privy:token")).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
