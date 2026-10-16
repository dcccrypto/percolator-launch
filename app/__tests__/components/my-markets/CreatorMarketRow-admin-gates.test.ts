/**
 * The creator row gates the two destructive actions on the authority each one
 * actually needs, instead of letting the user click into a doomed tx:
 *  • "burn admin key" — enabled only when the wallet holds asset_admin
 *    (== creator_fee_authority), which the creator does.
 *  • "close market" — enabled only when the wallet holds marketauth, which
 *    StakeInitPool rotated to the keyless stake-pool PDA, so it's disabled on a
 *    completed (autonomous) market, with an explanation.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { ZERO_PUBKEY } from "@/lib/update-asset-authority-keys";

const ZERO_B58 = ZERO_PUBKEY.toBase58();

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/my-markets/CreatorMarketRow.tsx"),
  "utf8",
);

describe("CreatorMarketRow admin-action gates", () => {
  it("derives isAssetAdmin from creator_fee_authority and isMarketAuth from marketauth", () => {
    expect(SRC).toMatch(/const isAssetAdmin =[\s\S]*creator_fee_authority === walletB58AdminGate/);
    expect(SRC).toMatch(/const marketAuthB58 = market\.configV17\?\.marketauth\?\.toBase58\(\)/);
    expect(SRC).toMatch(/const isMarketAuth =[\s\S]*marketAuthB58 === walletB58AdminGate/);
  });

  it("disables burn on !isAssetAdmin and close on !isMarketAuth", () => {
    expect(SRC).toMatch(/disabled=\{actions\.loading === "renounceAdmin" \|\| !isAssetAdmin \|\| adminBurned\}/);
    // Merged with WP-9's close checklist: the blocker AND the marketauth gate.
    expect(SRC).toMatch(/disabled=\{closeMarket\.loading \|\| closeBlocker !== null \|\| !isMarketAuth\}/);
    expect(SRC).toContain("<CloseMarketChecklistView checks={closeChecks} />");
  });

  it("explains the autonomous-market state instead of a doomed close", () => {
    expect(SRC).toContain("{!isMarketAuth && (");
    expect(SRC).toMatch(/This market is autonomous/);
  });

  // After a burn asset_admin is the zero key, but the market stays in Your Markets (useCreatedMarkets
  // lists markets whose LP portfolio the wallet owns). The toast said it would disappear, and the
  // drawer asked the creator to "connect the creator wallet" and offered a burn they can't do.
  describe("after the admin key is burned", () => {
    it("detects the burn from the zero key the burn writes", () => {
      expect(SRC).toMatch(/const adminBurned = burnedHere \|\| detail\?\.creator_fee_authority === ZERO_PUBKEY\.toBase58\(\);/);
      expect(ZERO_B58).toBe("11111111111111111111111111111111");
    });

    it("the toast no longer says the market leaves Your Markets", () => {
      expect(SRC).not.toMatch(/no longer appear in Your Markets/);
      expect(SRC).toContain("The market stays in Your Markets because your wallet still owns its liquidity position.");
    });

    it("the burn button says it is burned instead of asking to connect the creator wallet", () => {
      expect(SRC).toMatch(/adminBurned\s*\?\s*"The admin key is already burned\."/);
      expect(SRC).toContain('{adminBurned ? "admin key burned" : "burn admin key"}');
    });

    it("flips to burned as soon as this drawer's burn succeeds, before the detail refetch", () => {
      expect(SRC).toMatch(/await actions\.renounceAdmin\(market\);\s*setBurnedHere\(true\);/);
    });

    it("only offers the remaining burn to a wallet that still holds the admin key", () => {
      expect(SRC).toContain('{isAssetAdmin && !adminBurned && " You can still burn your remaining admin key."}');
      expect(SRC).not.toMatch(/so it can’t be closed\. You can still burn/);
    });
  });

  it("the burn confirm says it forfeits creator fees, and warns to claim first when fees are unclaimed", () => {
    expect(SRC).toContain('data-testid="burn-forfeits-fees"');
    expect(SRC).toMatch(/give up this market&apos;s creator fees for good/);
    expect(SRC).toMatch(/\{hasClaimableFees && \(\s*<p data-testid="burn-claim-first"/);
  });
});
