import { describe, expect, it, vi } from "vitest";
import { copyAddress } from "@/lib/copy-address";

describe("copyAddress", () => {
  it("doesn't report a copy of an empty address (the Privy menu opens before its wallet loads)", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const toast = vi.fn();
    await copyAddress("", toast);
    expect(writeText).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Couldn't copy the address", "error");
  });

  it("reports a failure when the clipboard API is missing (insecure context)", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const toast = vi.fn();
    await copyAddress("9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa", toast);
    expect(toast).toHaveBeenCalledWith("Couldn't copy the address", "error");
  });
});
