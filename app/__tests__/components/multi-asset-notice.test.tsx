/**
 * Copy QA item 1 / browser E2E 2026-10-16: a multi-asset market's trade page carries a notice; a single-asset one
 * carries none. The ticket trades such a market (asset 0, through the multi-asset order path), so the notice must not
 * say trading it here is unsupported: it says the app trades the first asset and only the others need the SDK.
 */
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MultiAssetNotice, MULTI_ASSET_NOTICE } from "@/components/trade/MultiAssetNotice";

describe("MultiAssetNotice", () => {
  it("labels the market and says the app trades its first asset here", () => {
    render(<MultiAssetNotice show />);
    const n = screen.getByTestId("multi-asset-notice");
    expect(n).toHaveTextContent("Multi-asset market");
    expect(n).toHaveTextContent(MULTI_ASSET_NOTICE.body);
    expect(n.textContent).toMatch(/trades its first asset only/);
    expect(n.textContent).toMatch(/other assets are SDK-only/);
    expect(n.textContent).not.toMatch(/another asset/i);
  });
  it("never claims trading the market here is unsupported (the ticket trades it)", () => {
    render(<MultiAssetNotice show />);
    const t = screen.getByTestId("multi-asset-notice").textContent ?? "";
    expect(t).not.toMatch(/not supported|isn.t supported|unsupported/i);
    expect(t).not.toMatch(/SDK only\)|Use the SDK for this market/);
  });
  it("negative control: shows nothing for a single-asset market", () => {
    render(<MultiAssetNotice show={false} />);
    expect(screen.queryByTestId("multi-asset-notice")).toBeNull();
  });
});
