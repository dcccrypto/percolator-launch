/**
 * UX WP-10 AC2 (audit FA-2): the devnet faucet modal is mounted in BOTH wallet-provider branches
 * (wallet-adapter and Privy), and "Start Trading" goes to a market instead of only closing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

describe("faucet modal mounting", () => {
  it("both provider branches render <DevnetFaucetModal />", () => {
    const s = src("components/providers/WalletProvider.tsx");
    const adapter = s.slice(s.indexOf("if (!appId) {"), s.indexOf("// Privy: the app is server-rendered here"));
    const privy = s.slice(s.indexOf("// Privy: the app is server-rendered here"));
    expect(adapter).toContain("<WalletAdapterProviderClient>");
    expect(adapter).toContain("<DevnetFaucetModal />");
    expect(privy).toContain("<DevnetFaucetModal />");
  });
  it("Start Trading navigates to /markets off the trade page", () => {
    const s = src("components/devnet/DevnetFaucetModal.tsx");
    expect(s).toMatch(/data-testid="faucet-start-trading"[\s\S]*faucet\.dismiss\(\);[\s\S]*router\.push\("\/markets"\)/);
    expect(s).not.toContain("per 24h");
  });
});
