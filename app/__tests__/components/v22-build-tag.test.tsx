import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { BuildTag } from "@/components/v22/BuildTag";

describe("v2.2 build tag", () => {
  afterEach(() => { cleanup(); __setDevnetV22ForTest(null); vi.unstubAllEnvs(); });
  it("flag on: footer line with the short SHA and deployment id, and window.__v22Build", () => {
    __setDevnetV22ForTest(true);
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "b2e0a42af");
    vi.stubEnv("NEXT_PUBLIC_BUILD_DEPLOYMENT", "dpl_TEST");
    const { getByTestId } = render(<BuildTag />);
    expect(getByTestId("v22-build-tag").textContent).toBe("build b2e0a42af · dpl_TEST");
    expect((window as unknown as { __v22Build: unknown }).__v22Build).toEqual({ sha: "b2e0a42af", deployment: "dpl_TEST" });
  });
  it("NEGATIVE: flag off renders nothing (other builds never show it)", () => {
    __setDevnetV22ForTest(false);
    const { queryByTestId } = render(<BuildTag />);
    expect(queryByTestId("v22-build-tag")).toBeNull();
  });
});
