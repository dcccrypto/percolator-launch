/**
 * The playground side of the devnet v2 lock, as a visitor sees it:
 *   - /locked shows the calm copy + the two ways forward, and nothing else;
 *   - global chrome (nav, footer, data bars) is not mounted on /locked;
 *   - a 401 from the gate never permanently "refuses" a pending keeper registration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let pathname = "/locked";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import LockedPage from "@/app/locked/page";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ChromeGate } from "@/components/layout/ChromeGate";
import { postKeeperRegistration, resumePendingRegistrations, type KeyStore } from "@/lib/keeper-register-client";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("/locked", () => {
  // The playground copy (flag off). The v2.2 preview copy: locked-preview-copy.test.tsx.
  beforeEach(() => __setDevnetV22ForTest(false));
  afterEach(() => __setDevnetV22ForTest(null));
  it("says who it is open to and links to the gate + waitlist only", () => {
    const { container } = render(<LockedPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Devnet v2 is open to the first 1,000 on the waitlist.");
    const links = Array.from(container.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Check my spot", "https://percolator.trade/playground"],
      ["Join the waitlist", "https://percolator.trade/waitlist"],
    ]);
  });

  it("follows PLAYGROUND_COHORT_CUTOFF", () => {
    vi.stubEnv("PLAYGROUND_COHORT_CUTOFF", "2500");
    render(<LockedPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("first 2,500 on");
  });
});

describe("ChromeGate on /locked", () => {
  it("hides chrome wrapped with hideOn=['/locked'] and the default banners", () => {
    pathname = "/locked";
    render(
      <>
        <ChromeGate hideOn={["/locked"]}>
          <nav>header</nav>
        </ChromeGate>
        <ChromeGate>
          <div>ticker</div>
        </ChromeGate>
      </>,
    );
    expect(screen.queryByText("header")).toBeNull();
    expect(screen.queryByText("ticker")).toBeNull();
  });

  it("shows the same chrome everywhere else", () => {
    pathname = "/trade/abc";
    render(
      <ChromeGate hideOn={["/locked"]}>
        <nav>header</nav>
      </ChromeGate>,
    );
    expect(screen.getByText("header")).toBeTruthy();
  });
});

describe("keeper registration vs the gate's 401", () => {
  const proof = "2U4TFzSboHomgWAo1REiwVMC6jA8BZR77VdeNBChnE4NvSDsghA1Bg59oJ3fP6Gzk4FTv6THAJANRoYwV5Q1PRbY";
  const res = (status: number, body: unknown) => ({ ok: false, status, json: async () => body }) as Response;

  it("a 401 is retryable", async () => {
    const a = await postKeeperRegistration(
      { slabAddress: "S", dexPoolAddress: "P", proofTx: proof },
      vi.fn().mockResolvedValue(res(401, { error: "Playground access required" })) as unknown as typeof fetch,
    );
    expect(a.retryable).toBe(true);
  });

  it("a resume that hits 401 keeps the launch pending instead of marking it refused", async () => {
    const m = new Map<string, string>([
      ["perc.keeperProofTx.SLAB1", proof],
      ["perc.keeperRequest.SLAB1", JSON.stringify({ slabAddress: "SLAB1", dexPoolAddress: "POOL", dexType: "pumpswap" })],
    ]);
    const store: KeyStore = {
      get length() {
        return m.size;
      },
      key: (i) => Array.from(m.keys())[i] ?? null,
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
    };
    const fetchImpl = vi.fn().mockResolvedValue(res(401, { error: "Playground access required" }));
    const r = await resumePendingRegistrations({
      store,
      post: (req) => postKeeperRegistration(req, fetchImpl as unknown as typeof fetch),
    });
    expect(r.retryLater).toEqual(["SLAB1"]);
    expect(m.get("perc.keeperRegistered.SLAB1")).toBeUndefined();
  });
});
