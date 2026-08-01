import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
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
  // Desktop nav is FLAT since d6156f5c: Trade / Earn / Create a Market are
  // plain links, Portfolio sits on the right next to the wallet, and Community
  // is the ONLY remaining dropdown (it absorbed the former Build utilities,
  // Developers + Faucet). The Trade and Build dropdowns no longer exist, so the
  // dropdown behaviour below is exercised against Community — the same
  // NavDropdown component, just the group that survived.
  it("renders the flat top-level links", () => {
    render(<Header />);
    expect(screen.getByRole("link", { name: /Trade terminal/i })).toHaveAttribute("href", "/trade");
    expect(screen.getByRole("link", { name: /^Earn$/i })).toHaveAttribute("href", "/earn");
    expect(screen.getByRole("link", { name: /Create a Market/i })).toHaveAttribute("href", "/create");
    expect(screen.getByRole("link", { name: /^Portfolio$/i })).toHaveAttribute("href", "/portfolio");
  });

  it("renders Community as the only dropdown trigger", () => {
    render(<Header />);
    expect(screen.getByRole("button", { name: /Community/i })).toBeDefined();
    // The former Trade/Build groups are flat links now, not dropdown buttons.
    expect(screen.queryByRole("button", { name: /^Build$/i })).toBeNull();
  });

  it("shows Leaderboard link inside Community dropdown", () => {
    render(<Header />);
    const trigger = screen.getByRole("button", { name: /Community/i });
    // Click to open (fireEvent avoids mouseenter/leave side-effects)
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // menuitem should be accessible when open
    const leaderboard = screen.getByRole("menuitem", { name: /Leaderboard/i });
    expect(leaderboard).toHaveAttribute("href", "/leaderboard");
  });

  it("dismisses Community dropdown on Escape", () => {
    render(<Header />);
    const trigger = screen.getByRole("button", { name: /Community/i });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: /Leaderboard/i })).toBeDefined();

    fireEvent.keyDown(document, { key: "Escape" });
    // After Escape, dropdown closed — menuitem hidden from accessibility tree
    expect(screen.queryByRole("menuitem", { name: /Leaderboard/i })).toBeNull();
  });

  it("dismisses Community dropdown on outside click", () => {
    render(<Header />);
    const trigger = screen.getByRole("button", { name: /Community/i });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: /Leaderboard/i })).toBeDefined();

    // Click outside the dropdown
    fireEvent.mouseDown(document.body);
    // After outside click, dropdown closed — menuitem hidden from accessibility tree
    expect(screen.queryByRole("menuitem", { name: /Leaderboard/i })).toBeNull();
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
