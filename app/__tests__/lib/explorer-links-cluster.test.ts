/**
 * The create flow (progress, success, stuck-slab recovery) and the insurance top-up modal built
 * explorer links with a literal "?cluster=devnet", so on a mainnet build every one of them would
 * open the devnet explorer. They now use lib/config's explorerTxUrl / explorerAccountUrl, which
 * follow getConfig().network. Devnet-only pages (token factory, faucet) keep their literals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/config";

const SHARED = [
  "components/create/LaunchProgress.tsx",
  "components/create/LaunchSuccess.tsx",
  "components/create/RecoverSolBanner.tsx",
  "components/market/InsuranceTopUpModal.tsx",
];

describe("explorer links follow the configured network", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it("the shared flows hard-code no devnet cluster and use the helpers", () => {
    for (const f of SHARED) {
      const src = readFileSync(join(__dirname, "..", "..", f), "utf8");
      expect(src, f).not.toMatch(/cluster=devnet/);
      expect(src, f).toMatch(/explorer(Tx|Account)Url\(/);
    }
  });

  it("devnet build: devnet cluster", () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    expect(explorerTxUrl("SIG")).toBe("https://explorer.solana.com/tx/SIG?cluster=devnet");
    expect(explorerAccountUrl("ADDR")).toBe("https://explorer.solana.com/account/ADDR?cluster=devnet");
  });

  it("mainnet build: mainnet explorer, no devnet cluster", () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "mainnet");
    expect(explorerTxUrl("SIG")).not.toMatch(/cluster=devnet/);
    expect(explorerAccountUrl("ADDR")).not.toMatch(/cluster=devnet/);
  });
});
