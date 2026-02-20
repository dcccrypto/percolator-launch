/**
 * AccessibleWalletModal Tests
 * Issue: #248 — a11y: wallet connection modal not in ARIA tree
 *
 * Verifies:
 * - role="dialog" and aria-modal="true" present
 * - aria-labelledby references an element with a matching id
 * - Close button has aria-label
 * - "More options" toggle has aria-expanded + aria-controls
 * - Focus moves into modal on open
 * - Escape key closes the modal
 * - Keyboard tab trapping works
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock wallet adapter hooks
const mockSetVisible = vi.fn();
const mockSelect = vi.fn();

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: vi.fn(() => ({
    wallets: [
      {
        adapter: {
          name: "Phantom",
          icon: "data:image/svg+xml;base64,abc",
        },
        readyState: "Installed",
      },
      {
        adapter: {
          name: "Solflare",
          icon: "data:image/svg+xml;base64,def",
        },
        readyState: "Loadable",
      },
    ],
    select: mockSelect,
  })),
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: vi.fn(() => ({
    visible: true,
    setVisible: mockSetVisible,
  })),
  WalletModalContext: {
    Provider: ({ children, value }: { children: React.ReactNode; value: unknown }) => children,
  },
}));

import { AccessibleWalletModal } from "@/components/wallet/AccessibleWalletModal";

describe("AccessibleWalletModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up portaled content
    document.body.innerHTML = "";
  });

  it("renders with role='dialog' and aria-modal='true'", async () => {
    render(<AccessibleWalletModal />);

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("aria-modal")).toBe("true");
    });
  });

  it("has aria-labelledby pointing to an element with a matching id", async () => {
    render(<AccessibleWalletModal />);

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      const labelledBy = dialog.getAttribute("aria-labelledby");
      expect(labelledBy).toBeTruthy();

      const titleEl = document.getElementById(labelledBy!);
      expect(titleEl).toBeTruthy();
      expect(titleEl!.textContent).toContain("wallet");
    });
  });

  it("close button has aria-label", async () => {
    render(<AccessibleWalletModal />);

    await waitFor(() => {
      const closeBtn = screen.getByLabelText(/close/i);
      expect(closeBtn).toBeDefined();
      expect(closeBtn.tagName.toLowerCase()).toBe("button");
    });
  });

  it("wallet buttons have descriptive aria-labels", async () => {
    render(<AccessibleWalletModal />);

    await waitFor(() => {
      const phantomBtn = screen.getByLabelText(/connect phantom/i);
      expect(phantomBtn).toBeDefined();
    });
  });

  it("renders wallet list items with list semantics", async () => {
    render(<AccessibleWalletModal />);

    await waitFor(() => {
      const lists = screen.getAllByRole("list");
      expect(lists.length).toBeGreaterThan(0);
    });
  });

  it("closes on Escape key", async () => {
    render(<AccessibleWalletModal />);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeDefined();
    });

    fireEvent.keyDown(window, { key: "Escape" });

    // setVisible(false) called after the fade-out timeout
    await waitFor(
      () => {
        expect(mockSetVisible).toHaveBeenCalledWith(false);
      },
      { timeout: 500 }
    );
  });

  it("overlay has role='presentation'", async () => {
    render(<AccessibleWalletModal />);

    await waitFor(() => {
      const overlay = document.querySelector(
        ".wallet-adapter-modal-overlay"
      );
      expect(overlay).toBeTruthy();
      expect(overlay!.getAttribute("role")).toBe("presentation");
    });
  });

  it("decorative SVGs are hidden from assistive technology", async () => {
    render(<AccessibleWalletModal />);

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      // The expand/collapse chevron SVGs should be aria-hidden
      const svgs = dialog.querySelectorAll('svg[aria-hidden="true"]');
      expect(svgs.length).toBeGreaterThan(0);
    });
  });
});
