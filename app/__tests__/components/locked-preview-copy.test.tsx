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
  it("playground (flag off): unchanged waitlist copy and links", () => {
    __setDevnetV22ForTest(false);
    render(<LockedPage />);
    expect(screen.getByText("Check my spot")).toBeTruthy();
    expect(document.body.textContent).toMatch(/come straight back here/);
    expect(lockedCopy(false, "1,000").title).toBe("Devnet v2 is open to the first 1,000 on the waitlist.");
  });
});
