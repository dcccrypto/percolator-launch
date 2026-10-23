/**
 * ?mock=1 swaps in fabricated data (e.g. a $24.7M Earn TVL) with no marker. On the live site that
 * was reachable by anyone with the link; it now works only in a non-production build. The build-time
 * NEXT_PUBLIC_MOCK_MODE flag still turns it on anywhere.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMockMode } from "@/lib/mock-mode";

const at = (search: string) => window.history.replaceState(null, "", `/earn${search}`);

afterEach(() => {
  vi.unstubAllEnvs();
  at("");
});

describe("isMockMode", () => {
  it("production build: ?mock=1 is ignored", () => {
    vi.stubEnv("NODE_ENV", "production");
    at("?mock=1");
    expect(isMockMode()).toBe(false);
  });

  it("development build: ?mock=1 still turns it on", () => {
    vi.stubEnv("NODE_ENV", "development");
    at("?mock=1");
    expect(isMockMode()).toBe(true);
  });

  it("the build-time flag works in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_MOCK_MODE", "true");
    expect(isMockMode()).toBe(true);
  });

  it("CONTROL: production, no flag, no param: off", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isMockMode()).toBe(false);
  });
});
