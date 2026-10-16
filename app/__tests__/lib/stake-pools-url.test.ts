// @vitest-environment node
import { describe, expect, it } from "vitest";
import { stakePoolsUrl } from "@/lib/stake-pools-url";

describe("stakePoolsUrl: a post-transaction pool refresh is never served the cached pre-tx snapshot", () => {
  it("the first load shares the cached URL", () => {
    expect(stakePoolsUrl(0)).toBe("/api/stake/pools");
  });
  it("every refresh after a tx gets its own cache key (both the immediate and the 2 s follow-up)", () => {
    const a = stakePoolsUrl(1);
    const b = stakePoolsUrl(2);
    expect(a).toMatch(/^\/api\/stake\/pools\?r=1-\d+$/);
    expect(b).toMatch(/^\/api\/stake\/pools\?r=2-\d+$/);
    expect(a).not.toBe(b);
  });
});
