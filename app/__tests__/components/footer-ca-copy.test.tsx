/**
 * #81: the footer showed the token CA with no label, and said "copied" even when the clipboard
 * write was refused or unavailable (writeText was neither awaited nor caught).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/image", () => ({ default: () => null }));

import { Footer } from "@/components/layout/Footer";

const setClipboard = (clipboard: unknown) =>
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
// Found by its address text, which the button had before the fix too.
const button = () => screen.getByText("8PzFWy...pump").closest("button")!;

afterEach(() => setClipboard(undefined));

describe("footer CA", () => {
  it("is labelled, visibly and for screen readers", () => {
    render(<Footer />);
    expect(button().textContent).toContain("Percolator CA");
    // The computed name contains the visible label (WCAG 2.5.3), so "click Percolator CA" works.
    expect(screen.getByRole("button", { name: /^Percolator CA/ })).toBe(button());
  });

  it("says copied once the write succeeds", async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    render(<Footer />);
    await act(async () => { fireEvent.click(button()); });
    expect(button().textContent).toContain("copied");
    expect(button().textContent).not.toContain("copy failed");
  });

  it("says copy failed when the browser refuses the write", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
    render(<Footer />);
    await act(async () => { fireEvent.click(button()); });
    expect(button().textContent).toContain("copy failed");
    expect(screen.getByText("Copy failed").getAttribute("aria-live")).toBe("polite"); // announced, outside the button
    expect(button().contains(screen.getByText("Copy failed"))).toBe(false);
  });

  it("says copy failed when there is no clipboard (insecure context)", async () => {
    setClipboard(undefined);
    render(<Footer />);
    await act(async () => { fireEvent.click(button()); });
    expect(button().textContent).toContain("copy failed");
  });
});
