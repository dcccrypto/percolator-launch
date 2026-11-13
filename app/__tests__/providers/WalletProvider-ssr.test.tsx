/**
 * SEO P1: WalletProvider wraps every page (app/providers.tsx → root layout).
 * It used to load the Privy wrapper with next/dynamic({ ssr: false }), which
 * made the server bail out of rendering the WHOLE page tree — crawlers saw
 * ~7 words on /guide. This test server-renders WalletProvider with a Privy app
 * ID set and asserts the page content is in the HTML.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("@/components/providers/PrivyProviderClient", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/providers/AutoFundProvider", () => ({
  AutoFundProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/devnet/DevnetFaucetModal", () => ({
  DevnetFaucetModal: () => null,
}));

describe("WalletProvider server render", () => {
  const prev = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app-id";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
    else process.env.NEXT_PUBLIC_PRIVY_APP_ID = prev;
  });

  it("renders page content into the server HTML when Privy is configured", async () => {
    const { WalletProvider } = await import("@/components/providers/WalletProvider");
    const html = renderToString(
      <WalletProvider>
        <h1>Percolator Guide</h1>
      </WalletProvider>,
    );
    expect(html).toContain("Percolator Guide");
    expect(html).not.toContain("BAILOUT_TO_CLIENT_SIDE_RENDERING");
  });
});
