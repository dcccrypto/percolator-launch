import { afterEach, describe, expect, it } from "vitest";
import { STAKE_CONSENT_TEXT_V2, V22_COPY } from "@/lib/v22/copy";
import { __setDevnetV22ForTest, isDevnetV22Enabled } from "@/lib/v22/flag";
import { CONSENT_VERSION_FIRST_LOSS_V5 } from "@/lib/v22/sdk";

/**
 * The doc comment on `CONSENT_VERSION_FIRST_LOSS` in percolator-stake feat/v22-stake-v5 @ 480fe29 src/state.rs, lines
 * 307-319, copied byte for byte (the Rust `///` markers included). The program enforces version 2; the app shows this.
 */
const STATE_RS_CONSENT_DOC = `/// * Up to \`deploy_target_bps\` of the pool (the target signed in the consent, including a
///   pending raise) is deployed into the market's insurance fund and absorbs trading losses pro
///   rata with every other insurance unit (stake and creator class alike).
/// * The insurance backstop (wrapper tag 111, G9) can lend insurance to the market's vault LP
///   once its Earn seniors are exhausted, **up to the seniors' own loss that is still
///   outstanding**, and never more than 50% of the fund (at most 20% per ~day). It is announced on
///   chain at least 9,000 slots (~1 hour) before it can execute. On mainnet builds it runs only
///   on a market priced by an external oracle (an authenticated Hybrid whose legs are Chainlink
///   or allowlisted Switchboard feeds); on devnet any market can use it for testing. The loan is
///   repaid first from any vault-LP recovery, but repayment is not guaranteed.
/// * Withdrawals are paid only from the liquid part of the pool, first come first served; the
///   deployed part returns over successive syncs while the market is healthy.`;

const paragraphs = (doc: string): string[] =>
  doc
    .split(/\n(?=\/\/\/ \* )/)
    .map((p) => p.replace(/^\/\/\/ \* /, "").replace(/\n\/\/\/\s*/g, " ").replace(/\*\*/g, "").trim());

describe("consent text v2", () => {
  it("is the stake program's text verbatim, paragraph by paragraph", () => {
    expect([...STAKE_CONSENT_TEXT_V2]).toEqual(paragraphs(STATE_RS_CONSENT_DOC));
  });
  it("is version 2, the version the app must send", () => {
    expect(CONSENT_VERSION_FIRST_LOSS_V5).toBe(2);
  });
  it("carries the v2 changes (seniors' own loss, mainnet oracle restriction), not the v1 wording", () => {
    const all = STAKE_CONSENT_TEXT_V2.join(" ");
    expect(all).toContain("up to the seniors' own loss that is still outstanding");
    expect(all).toContain("On mainnet builds it runs only on a market priced by an external oracle");
    expect(all).not.toContain("up to 50% of the deployed share can be lost to it");
  });
});

describe("flag", () => {
  afterEach(() => __setDevnetV22ForTest(null));
  it("is OFF by default and only '1' / 'true' turn it on", () => {
    expect(isDevnetV22Enabled()).toBe(false);
    __setDevnetV22ForTest(true);
    expect(isDevnetV22Enabled()).toBe(true);
    __setDevnetV22ForTest(null);
    expect(isDevnetV22Enabled()).toBe(false);
  });
});

describe("product copy is calm, one line, and has no protocol mechanics", () => {
  const flat = (o: unknown): string[] =>
    typeof o === "string" ? [o] : typeof o === "function" ? [] : o && typeof o === "object" ? Object.values(o).flatMap(flat) : [];
  it("no lot_exp / band_bps / tag numbers anywhere in the surface copy", () => {
    for (const line of flat(V22_COPY)) {
      expect(line).not.toMatch(/lot_exp|band_bps|\btag \d|Custom\(|h-lock|kink/i);
      expect(line).not.toMatch(/\n/);
    }
  });
  it("the founder's band line is exact", () => {
    expect(V22_COPY.band.catchingUp).toBe("Price is catching up; closing reopens shortly.");
  });
  it("bond copy is honest about order, coupon and exit", () => {
    expect(V22_COPY.bond.absorbs).toMatch(/after .*first-loss.* before Earn/i);
    expect(V22_COPY.bond.coupon).toMatch(/fees/);
    expect(V22_COPY.bond.coupon).toMatch(/capped/);
    expect(V22_COPY.bond.exit).toMatch(/flat/);
  });
});
