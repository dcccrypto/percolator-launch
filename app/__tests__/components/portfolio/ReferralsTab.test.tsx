/**
 * Portfolio > Referrals tab: the link copies on one tap (with fallbacks for browsers that refuse the
 * clipboard), the joined count shows and keeps up as people join, rewards read as locked, and every
 * non-ok state renders its own message instead of an empty card.
 */
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fs from "fs";
import path from "path";
import { ReferralsTab } from "@/components/portfolio/ReferralsTab";

const bridge = vi.hoisted(() => ({
  value: { ready: true, authenticated: true, getAccessToken: async () => "tok", login: vi.fn() } as Record<string, unknown>,
}));
vi.mock("@/hooks/usePrivyBridge", () => ({ usePrivyBridge: () => bridge.value }));
const privy = vi.hoisted(() => ({ available: true }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyAvailable: () => privy.available }));

const body = vi.hoisted(() => ({ value: {} as unknown, status: 200 }));
const LINK = "https://percolator.trade/r/AB23XYZ9";
const ok = (joined: number | null) => ({ status: "ok", code: "AB23XYZ9", link: LINK, joined });
const fetchCalls = () => (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

beforeEach(() => {
  body.status = 200;
  privy.available = true;
  bridge.value = { ready: true, authenticated: true, getAccessToken: async () => "tok", login: vi.fn() };
  Object.assign(document, { execCommand: undefined });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body.value), { status: body.status })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderTab() {
  await act(async () => {
    render(<ReferralsTab />);
  });
}
const linkButton = () => screen.findByRole("button", { name: /copy your referral link/i });

describe("ReferralsTab", () => {
  it("shows the link without the scheme (the code stays visible on phones), the code, and the count", async () => {
    body.value = ok(7);
    await renderTab();
    await linkButton();
    expect(screen.getByText("percolator.trade/r/AB23XYZ9")).toBeTruthy();
    expect(screen.getByText("AB23XYZ9")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("sends the Privy access token with the request", async () => {
    body.value = ok(0);
    await renderTab();
    expect(fetch).toHaveBeenCalledWith(
      "/api/playground/referrals",
      expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
    );
  });

  it("rewards read as locked, with no amount", async () => {
    body.value = ok(3);
    await renderTab();
    expect(await screen.findByText("Rewards")).toBeTruthy();
    expect(screen.getByText("Locked")).toBeTruthy();
    expect(screen.queryByText(/\$\s?\d/)).toBeNull();
  });

  it("an unreadable count shows a dash, not zero", async () => {
    body.value = ok(null);
    await renderTab();
    expect(await screen.findByText("—")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("not linked offers to enter again from the gate, in the same tab", async () => {
    body.value = { status: "unavailable", enterUrl: "https://percolator.trade/playground" };
    await renderTab();
    const a = await screen.findByRole("link", { name: /enter from percolator\.trade/i });
    expect(a.getAttribute("href")).toBe("https://percolator.trade/playground");
    expect(a.getAttribute("target")).toBeNull();
  });

  it("signed out offers sign-in and never calls the API", async () => {
    bridge.value = { ...bridge.value, authenticated: false };
    await renderTab();
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("without Privy on the page it offers to enter again instead of loading forever", async () => {
    privy.available = false;
    await renderTab();
    expect(await screen.findByRole("link", { name: /enter from percolator\.trade/i })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a failed first request offers a retry, and the retry loads", async () => {
    body.status = 500;
    body.value = {};
    await renderTab();
    const retry = await screen.findByRole("button", { name: /try again/i });
    body.status = 200;
    body.value = ok(2);
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(await screen.findByText("2")).toBeTruthy();
  });
});

describe("one tap copies the full link", () => {
  it("copies synchronously inside the tap (execCommand) and says Copied", async () => {
    body.value = ok(1);
    const exec = vi.fn(() => true);
    Object.assign(document, { execCommand: exec });
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    await renderTab();
    await act(async () => {
      fireEvent.click(await linkButton());
    });
    expect(exec).toHaveBeenCalledWith("copy");
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("uses the async clipboard when execCommand cannot copy", async () => {
    body.value = ok(1);
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    await renderTab();
    await act(async () => {
      fireEvent.click(await linkButton());
    });
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("when nothing can copy, says so and shows the full link in a selectable field", async () => {
    body.value = ok(1);
    Object.assign(document, { execCommand: vi.fn(() => false) });
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
    await renderTab();
    await act(async () => {
      fireEvent.click(await linkButton());
    });
    expect(screen.getByText("Copy failed")).toBeTruthy();
    const field = screen.getByDisplayValue(LINK) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
  });

  it("shows Copied under React StrictMode (the development double-mount)", async () => {
    body.value = ok(1);
    Object.assign(document, { execCommand: vi.fn(() => true) });
    await act(async () => {
      render(
        <StrictMode>
          <ReferralsTab />
        </StrictMode>,
      );
    });
    await act(async () => {
      fireEvent.click(await linkButton());
    });
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("hands focus back to the button after copying", async () => {
    body.value = ok(1);
    Object.assign(document, { execCommand: vi.fn(() => true) });
    await renderTab();
    const btn = await linkButton();
    btn.focus();
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(document.activeElement).toBe(btn);
  });
});

describe("the joined count keeps up as people join", () => {
  it("re-reads every two minutes while visible and shows the new count", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    body.value = ok(3);
    await renderTab();
    expect(await screen.findByText("3")).toBeTruthy();
    body.value = ok(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(await screen.findByText("4")).toBeTruthy();
  });

  it("does not poll while the page is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    body.value = ok(3);
    await renderTab();
    await screen.findByText("3");
    const before = fetchCalls();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(fetchCalls()).toBe(before);
  });

  it("re-reads when the page becomes visible again, keeping the link on screen while it loads", async () => {
    body.value = ok(3);
    await renderTab();
    expect(await screen.findByText("3")).toBeTruthy();

    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    (fetch as unknown as { mockImplementationOnce: (f: () => Promise<Response>) => void }).mockImplementationOnce(async () => {
      await gate;
      return new Response(JSON.stringify(ok(9)), { status: 200 });
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Mid-request: still the loaded link and count, no skeleton.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByText("3")).toBeTruthy();
    await act(async () => {
      release();
    });
    expect(await screen.findByText("9")).toBeTruthy();
  });

  it("a background read that fails, or cannot count, keeps the link and last count", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    body.value = ok(5);
    await renderTab();
    expect(await screen.findByText("5")).toBeTruthy();

    body.value = ok(null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.getByText("5")).toBeTruthy();

    body.status = 500;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.getByText("5")).toBeTruthy();
    expect(await linkButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("one odd background answer keeps the link; two in a row are believed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    body.value = ok(5);
    await renderTab();
    await screen.findByText("5");

    body.value = { status: "unavailable", enterUrl: "https://percolator.trade/playground" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.getByText("5")).toBeTruthy(); // one hiccup: still the link

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(await screen.findByRole("link", { name: /enter from percolator\.trade/i })).toBeTruthy();
  });

  it("stops re-reading after the tab unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    body.value = ok(1);
    await renderTab();
    await screen.findByText("1");
    cleanup();
    const calls = fetchCalls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(fetchCalls()).toBe(calls);
  });
});

describe("Portfolio page", () => {
  it("has a Referrals tab that renders ReferralsTab, and keeps the active tab scrolled into view", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../app/portfolio/page.tsx"), "utf8");
    expect(src).toMatch(/\{ key: "referrals", label: "Referrals" \}/);
    expect(src).toMatch(/tab === "referrals" && <ReferralsTab \/>/);
    expect(src).toMatch(/data-portfolio-tab=\{t\.key\}/);
    expect(src).toMatch(/\[data-portfolio-tab="\$\{tab\}"\][\s\S]{0,40}\?\.scrollIntoView/);
  });
});
