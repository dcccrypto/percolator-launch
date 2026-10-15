// @vitest-environment jsdom
/** #2826: <Analytics /> (whose script 404s unless Web Analytics is enabled on the Vercel project) is opt-in. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/analytics/next", () => ({ Analytics: () => <div data-testid="vercel-analytics" /> }));
const trackSpy = vi.fn();
vi.mock("@vercel/analytics", () => ({ track: (...a: unknown[]) => trackSpy(...a) }));

import { VercelAnalytics } from "@/components/analytics/VercelAnalytics";
import { track } from "@/lib/analytics";

afterEach(() => {
  vi.unstubAllEnvs();
  trackSpy.mockReset();
});

describe("VercelAnalytics", () => {
  it("flag unset: renders nothing", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ANALYTICS", "");
    const { queryByTestId } = render(<VercelAnalytics />);
    expect(queryByTestId("vercel-analytics")).toBeNull();
  });
  it.each(["0", "true", "yes"])("flag %s: still off (only \"1\" enables)", (v) => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ANALYTICS", v);
    expect(render(<VercelAnalytics />).queryByTestId("vercel-analytics")).toBeNull();
  });
  it("flag=1: renders <Analytics />", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ANALYTICS", "1");
    expect(render(<VercelAnalytics />).queryByTestId("vercel-analytics")).not.toBeNull();
  });
});

describe("track()", () => {
  it("flag unset: does not call Vercel track and never throws; GA path still fires", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ANALYTICS", "");
    const gtag = vi.fn();
    (window as unknown as { gtag: unknown }).gtag = gtag;
    expect(() => track("wallet_connected", { a: 1 })).not.toThrow();
    expect(trackSpy).not.toHaveBeenCalled();
    expect(gtag).toHaveBeenCalledWith("event", "wallet_connected", { a: 1 });
  });
  it("flag=1: forwards to Vercel track", () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ANALYTICS", "1");
    track("wallet_connected");
    expect(trackSpy).toHaveBeenCalledWith("wallet_connected", {});
  });
});

describe("layout wiring", () => {
  it("app/layout.tsx mounts the flag-gated wrapper, never the raw <Analytics />", () => {
    const src = readFileSync(path.join(__dirname, "../../app/layout.tsx"), "utf8");
    expect(src).toContain("<VercelAnalytics />");
    expect(src).not.toMatch(/<Analytics\s*\/>/);
    expect(src).not.toContain('from "@vercel/analytics/next"');
  });
});
