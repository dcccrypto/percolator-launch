import { describe, it, expect, vi, afterEach } from "vitest";

describe("isMockMode", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  async function loadMockMode() {
    // Dynamic import to re-evaluate the module with new env
    const mod = await import("../../lib/mock-mode");
    return mod.isMockMode;
  }

  it('returns true when NEXT_PUBLIC_MOCK_MODE is "true"', async () => {
    process.env.NEXT_PUBLIC_MOCK_MODE = "true";
    const isMockMode = await loadMockMode();
    expect(isMockMode()).toBe(true);
  });

  it('returns true when NEXT_PUBLIC_MOCK_MODE is "1"', async () => {
    process.env.NEXT_PUBLIC_MOCK_MODE = "1";
    const isMockMode = await loadMockMode();
    expect(isMockMode()).toBe(true);
  });

  it("returns false when NEXT_PUBLIC_MOCK_MODE is not set", async () => {
    delete process.env.NEXT_PUBLIC_MOCK_MODE;
    const isMockMode = await loadMockMode();
    expect(isMockMode()).toBe(false);
  });

  it('returns false when NEXT_PUBLIC_MOCK_MODE is "false"', async () => {
    process.env.NEXT_PUBLIC_MOCK_MODE = "false";
    const isMockMode = await loadMockMode();
    expect(isMockMode()).toBe(false);
  });

  it("returns false when NEXT_PUBLIC_MOCK_MODE is empty string", async () => {
    process.env.NEXT_PUBLIC_MOCK_MODE = "";
    const isMockMode = await loadMockMode();
    expect(isMockMode()).toBe(false);
  });
});
