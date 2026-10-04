/**
 * #61: /portfolio and /earn read their tab from the URL hash only on mount, so a hash change
 * (hash link, Back / Forward) or a Next <Link> to the bare hub path from inside the hub changed
 * the URL but not the tab. useHashTab follows the URL on hashchange, popstate and the Navigation
 * API's currententrychange.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import fs from "fs";
import path from "path";
import { useHashTab } from "@/hooks/useHashTab";

const KEYS = ["overview", "wallet", "markets"] as const;
type Key = (typeof KEYS)[number];
const isKey = (v: string): v is Key => (KEYS as readonly string[]).includes(v);

function Hub() {
  const [tab, selectTab] = useHashTab(isKey, "overview");
  return (
    <div>
      <span data-testid="tab">{tab}</span>
      <button onClick={() => selectTab("wallet")}>wallet</button>
    </div>
  );
}
const shown = () => screen.getByTestId("tab").textContent;

let nav: EventTarget;
beforeEach(() => {
  nav = new EventTarget();
  (window as Window & { navigation?: EventTarget }).navigation = nav;
  history.replaceState(null, "", "/portfolio");
});
afterEach(() => {
  cleanup();
  delete (window as Window & { navigation?: EventTarget }).navigation;
});

describe("#61: useHashTab", () => {
  it("opens on the hash's tab, and on the fallback for a missing or unknown hash", () => {
    history.replaceState(null, "", "/portfolio#markets");
    render(<Hub />);
    expect(shown()).toBe("markets");
    cleanup();
    history.replaceState(null, "", "/portfolio#nope");
    render(<Hub />);
    expect(shown()).toBe("overview");
  });

  it("follows a hash change (hash link)", () => {
    render(<Hub />);
    act(() => {
      history.replaceState(null, "", "/portfolio#wallet");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(shown()).toBe("wallet");
  });

  it("follows Back / Forward (popstate)", () => {
    history.replaceState(null, "", "/portfolio#wallet");
    render(<Hub />);
    act(() => {
      history.replaceState(null, "", "/portfolio#markets");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(shown()).toBe("markets");
  });

  it("follows a same-page pushState with no hash events (Next <Link> to the bare hub path)", () => {
    history.replaceState(null, "", "/portfolio#wallet");
    render(<Hub />);
    expect(shown()).toBe("wallet");
    act(() => {
      history.pushState(null, "", "/portfolio");
      nav.dispatchEvent(new Event("currententrychange"));
    });
    expect(shown()).toBe("overview");
  });

  it("selecting a tab shows it and writes the hash", () => {
    render(<Hub />);
    act(() => screen.getByRole("button", { name: "wallet" }).click());
    expect(shown()).toBe("wallet");
    expect(location.hash).toBe("#wallet");
  });

  it("works without the Navigation API (hash events only)", () => {
    delete (window as Window & { navigation?: EventTarget }).navigation;
    render(<Hub />);
    act(() => {
      history.replaceState(null, "", "/portfolio#markets");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(shown()).toBe("markets");
  });

  it("removes its listeners on unmount", () => {
    const winOff = vi.spyOn(window, "removeEventListener");
    const navOff = vi.spyOn(nav, "removeEventListener");
    const { unmount } = render(<Hub />);
    unmount();
    const removed = (spy: typeof winOff) => spy.mock.calls.map((c) => c[0]);
    expect(removed(winOff)).toEqual(expect.arrayContaining(["hashchange", "popstate"]));
    expect(removed(navOff)).toContain("currententrychange");
    winOff.mockRestore();
    navOff.mockRestore();
  });

  it("both hub pages use it", () => {
    for (const f of ["app/portfolio/page.tsx", "app/earn/page.tsx"]) {
      const src = fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");
      expect(src, f).toMatch(/useHashTab\(/);
    }
  });
});
