import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UnsupportedLayoutNotice } from "@/components/v22/UnsupportedLayoutNotice";
import { V22_COPY } from "@/lib/v22/copy";

describe("UnsupportedLayoutNotice", () => {
  it("renders the calm fallback, with no numbers, offsets or codes", () => {
    render(<UnsupportedLayoutNotice />);
    expect(screen.getByTestId("unsupported-layout")).toBeTruthy();
    expect(screen.getByText(V22_COPY.layout.title)).toBeTruthy();
    expect(screen.getByTestId("status-line-body").textContent).toBe(V22_COPY.layout.body);
    expect(screen.getByTestId("status-line").getAttribute("data-variant")).toBe("paused");
    expect(screen.getByTestId("unsupported-layout").textContent).not.toMatch(/\d|version 1|offset|Custom/i);
    // nothing expandable: no "Why?" / code details
    expect(screen.queryByTestId("status-line-why")).toBeNull();
  });
  it("NEGATIVE CONTROL: the copy test would catch a leaked number", () => {
    expect("This market uses version 20".match(/\d/)).not.toBeNull();
  });
});
