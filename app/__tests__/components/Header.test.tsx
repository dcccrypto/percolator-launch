import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/markets",
}));

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="connect-button" />,
}));

vi.mock("gsap", () => ({
  default: {
    fromTo: vi.fn(),
    to: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("@/hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => true,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet" }),
  setNetwork: vi.fn(),
}));

import { Header } from "@/components/layout/Header";

describe("Header", () => {
  it("renders dropdown group triggers", () => {
    render(<Header />);
    expect(screen.getByRole("button", { name: /Trade/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Build/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Community/i })).toBeDefined();
  });

  it("shows Wallet link inside Trade dropdown", () => {
    render(<Header />);
    const tradeTrigger = screen.getByRole("button", { name: /Trade/i });
    // Click to open (fireEvent avoids mouseenter/leave side-effects)
    fireEvent.click(tradeTrigger);
    expect(tradeTrigger.getAttribute("aria-expanded")).toBe("true");
    // menuitem should be accessible when open
    const walletLink = screen.getByRole("menuitem", { name: /Wallet/i });
    expect(walletLink).toHaveAttribute("href", "/wallet");
  });

  it("dismisses Trade dropdown on Escape", () => {
    render(<Header />);
    const tradeTrigger = screen.getByRole("button", { name: /Trade/i });
    fireEvent.click(tradeTrigger);
    expect(screen.getByRole("menuitem", { name: /Wallet/i })).toBeDefined();

    fireEvent.keyDown(document, { key: "Escape" });
    // After Escape, dropdown closed — menuitem hidden from accessibility tree
    expect(screen.queryByRole("menuitem", { name: /Wallet/i })).toBeNull();
  });

  it("dismisses Trade dropdown on outside click", () => {
    render(<Header />);
    const tradeTrigger = screen.getByRole("button", { name: /Trade/i });
    fireEvent.click(tradeTrigger);
    expect(screen.getByRole("menuitem", { name: /Wallet/i })).toBeDefined();

    // Click outside the dropdown
    fireEvent.mouseDown(document.body);
    // After outside click, dropdown closed — menuitem hidden from accessibility tree
    expect(screen.queryByRole("menuitem", { name: /Wallet/i })).toBeNull();
  });

  it("renders DEVNET badge as non-interactive", () => {
    render(<Header />);
    const badge = screen.getByTitle(/devnet/i);
    expect(badge.tagName).not.toBe("BUTTON");
    expect(badge.className).toContain("pointer-events-none");
  });

  it("renders connect button", () => {
    render(<Header />);
    expect(screen.getByTestId("connect-button")).toBeDefined();
  });
});
