/** v2.2 QA-0: on the preview origin /locked must not promise the waitlist round trip (its cookie never reaches it). */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import LockedPage from "@/app/locked/page";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { lockedCopy } from "@/lib/locked-copy";

describe("QA-0: /locked", () => {
  afterEach(() => __setDevnetV22ForTest(null));
  it("v2.2 preview: tester-link copy, no waitlist links, no 'come straight back'", () => {
    __setDevnetV22ForTest(true);
    render(<LockedPage />);
    expect(screen.getByRole("heading").textContent).toBe("This is a private test build.");
    expect(document.body.textContent).not.toMatch(/straight back/);
    expect(screen.queryByText("Check my spot")).toBeNull();
    expect(screen.queryByText("Join the waitlist")).toBeNull();
  });
  // Council 2026-11-06-go1106-ux, First-timer (low): "The locked page names percolator.trade without a link and offers
  // no way to ask for access." Clerk: "The 'waitlist' half of 'waitlist/enter' is not a working flow on this preview."
  it("v2.2 preview: offers a request-access path (the team's Discord), opened safely in a new tab", () => {
    __setDevnetV22ForTest(true);
    render(<LockedPage />);
    const link = screen.getByRole("link", { name: /request access/i });
    expect(link.getAttribute("href")).toBe("https://discord.gg/fJa4BDBxPN");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    expect(document.body.textContent).toMatch(/ask the team for a tester link/i);
    const copy = lockedCopy(true, "1,000");
    expect(copy.requestAccess?.href).toBe("https://discord.gg/fJa4BDBxPN");
  });
  it("v2.2 preview: the playground it points to is a link, not bare text", () => {
    __setDevnetV22ForTest(true);
    render(<LockedPage />);
    const link = screen.getByRole("link", { name: /devnet v2 playground/i });
    expect(link.getAttribute("href")).toBe("https://percolator.trade/playground");
  });
  it("playground (flag off): no request-access link (the waitlist links are the path there)", () => {
    __setDevnetV22ForTest(false);
    render(<LockedPage />);
    expect(screen.queryByRole("link", { name: /request access/i })).toBeNull();
    expect(lockedCopy(false, "1,000").requestAccess).toBeNull();
  });
  it("playground (flag off): unchanged waitlist copy and links", () => {
    __setDevnetV22ForTest(false);
    render(<LockedPage />);
    expect(screen.getByText("Check my spot")).toBeTruthy();
    expect(document.body.textContent).toMatch(/come straight back here/);
    expect(lockedCopy(false, "1,000").title).toBe("Devnet v2 is open to the first 1,000 on the waitlist.");
  });
});
