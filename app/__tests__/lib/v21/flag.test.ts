// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV21ForTest, isDevnetV21Enabled } from "@/lib/v21/flag";

afterEach(() => {
  __setDevnetV21ForTest(null);
  vi.unstubAllEnvs();
});

describe("NEXT_PUBLIC_DEVNET_V21", () => {
  it("is OFF by default and for anything but 1/true", () => {
    expect(isDevnetV21Enabled()).toBe(false);
    for (const v of ["0", "false", "", "yes", "on"]) {
      vi.stubEnv("NEXT_PUBLIC_DEVNET_V21", v);
      expect(isDevnetV21Enabled()).toBe(false);
    }
  });
  it("is ON for 1 and true; the test seam overrides the environment", () => {
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V21", "1");
    expect(isDevnetV21Enabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V21", "true");
    expect(isDevnetV21Enabled()).toBe(true);
    __setDevnetV21ForTest(false);
    expect(isDevnetV21Enabled()).toBe(false);
  });
});
