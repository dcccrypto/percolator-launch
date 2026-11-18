import { describe, it, expect } from "vitest";
import { createUploadCooldown } from "@/lib/upload-cooldown";

describe("createUploadCooldown", () => {
  it("limits within the window and releases after it", () => {
    let now = 1_000_000;
    const c = createUploadCooldown(30_000, () => now);
    expect(c.isLimited("a")).toBe(false);
    c.record("a");
    now += 29_999;
    expect(c.isLimited("a")).toBe(true);
    now += 1;
    expect(c.isLimited("a")).toBe(false);
  });

  it("does not block after the clock steps backwards (future stamp)", () => {
    let now = 1_000_000;
    const c = createUploadCooldown(30_000, () => now);
    c.record("a");
    now -= 10 * 60_000; // NTP step back 10 min
    expect(c.isLimited("a")).toBe(false);
  });

  it("treats a non-finite stored stamp as limited-not-skipped (fail closed)", () => {
    const now = 1_000_000;
    const c = createUploadCooldown(30_000, () => now);
    c.recordAt("a", Number.NaN);
    expect(c.isLimited("a")).toBe(true);
  });

  it("prunes expired entries so the map stays bounded", () => {
    let now = 1_000_000;
    const c = createUploadCooldown(30_000, () => now, 10);
    for (let i = 0; i < 50; i++) c.record(`k${i}`);
    now += 31_000;
    c.record("fresh");
    expect(c.size()).toBe(1);
  });

  it("hard-caps size even when nothing has expired", () => {
    const now = 1_000_000;
    const c = createUploadCooldown(30_000, () => now, 10);
    for (let i = 0; i < 100; i++) c.record(`k${i}`);
    expect(c.size()).toBeLessThanOrEqual(10);
  });
});
