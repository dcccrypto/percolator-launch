import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

  it("shows Wallet link inside Trade dropdown", async () => {
    render(<Header />);
    const tradeTrigger = screen.getByRole("button", { name: /Trade/i });
    await userEvent.click(tradeTrigger);
    const walletLink = screen.getByRole("menuitem", { name: /Wallet/i });
    expect(walletLink).toHaveAttribute("href", "/wallet");
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
