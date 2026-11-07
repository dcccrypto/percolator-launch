// @vitest-environment node
/**
 * Council 2026-11-06-go1106-ux, First-timer (low): "Jargon and naming drift. The same token is called 'USDC' (modal,
 * ticket) and 'Sim-USDC' (faucet, stake). The Stake page has three names for itself ('INSURANCE STAKE', 'Fee staking',
 * 'First-loss staking'). It also ... uses 'creator's seed', 'tranche, bonds', 'Target / Liquid buffer / Rebalance
 * band'". Creator (low): "The stake page also shows internal jargon ('wrapper tag 111, G9', 'the target signed in the
 * consent')." Verdict LOW item: "Jargon: USDC vs Sim-USDC, three names for staking, 'wrapper tag 111, G9'."
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STAKE_CONSENT_TEXT_V2, V22_COPY, consentDisplay } from "@/lib/v22/copy";
import { STAKE_COPY_V22 } from "@/lib/stake-copy";
import { EARN_TABS } from "@/components/earn/earnTabs";

const code = (f: string) =>
  readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").replace(/\/\/.*$/gm, "");

describe("the consent text as SHOWN carries no program internals", () => {
  const shown = STAKE_CONSENT_TEXT_V2.map(consentDisplay).join(" ");
  it("no wrapper tag numbers, finding ids, or field names", () => {
    expect(shown).not.toMatch(/wrapper tag|tag 111|\bG9\b|`/);
  });
  it("no 'the target signed in the consent'", () => {
    expect(shown).not.toMatch(/signed in the consent/);
    expect(shown).toContain("the target you agree to here");
  });
  it("the verbatim source of truth is untouched (the program enforces version 2 of exactly this text)", () => {
    expect(STAKE_CONSENT_TEXT_V2[1]).toContain("(wrapper tag 111, G9)");
    expect(STAKE_CONSENT_TEXT_V2[0]).toContain("the target signed in the consent");
  });
});

describe("stake copy says it in plain words", () => {
  const lines = [
    V22_COPY.stake.consentSummary,
    V22_COPY.stake.closeOut.feeOnly,
    V22_COPY.stake.closeOut.firstLoss,
    V22_COPY.stake.feeOnlyStakersRow,
    STAKE_COPY_V22.sidebar,
  ];
  it("no 'seed', 'tranche' or 'bonds'", () => {
    for (const l of lines) expect(l, l).not.toMatch(/\bseed\b|tranche|\bbonds?\b/i);
  });
  it("the deposit's pool settings have plain labels", () => {
    expect(V22_COPY.stake.paramLabels).toEqual({ target: "Backs insurance", buffer: "Kept for withdrawals", hysteresis: "Rebalance margin" });
  });
});

describe("one name for staking", () => {
  it("the first-loss deposit is 'Insurance staking', the same name as the page", () => {
    expect(V22_COPY.stake.title).toBe("Insurance staking");
    expect(V22_COPY.stake.title).toBe(V22_COPY.stake.insuranceStaking);
  });
  it("the nav tab and page metadata use the umbrella name 'Staking'", () => {
    expect(EARN_TABS.find((t) => t.key === "stake")?.label).toBe("Staking");
    expect(code("app/stake/layout.tsx")).toMatch(/title: "Staking"/);
  });
  it("the page eyebrow no longer says 'insurance stake' over a 'Fee staking' title", () => {
    // RAW source: the eyebrow is JSX text that starts with "//", which the comment stripper would delete.
    const raw = readFileSync(join(process.cwd(), "app/stake/page.tsx"), "utf8");
    expect(raw).not.toMatch(/^\s*\/\/ insurance stake\s*$/m);
    expect(raw).toMatch(/^\s*\/\/ staking\s*$/m);
  });
});

describe("one name for the collateral: USDC", () => {
  const USER_FACING = [
    "app/faucet/page.tsx",
    "app/faucet/layout.tsx",
    "app/stake/page.tsx",
    "app/wallet/page.tsx",
    "app/page.tsx",
    "components/playground/SimUsdcBalance.tsx",
    "components/earn/EarnVaultView.tsx",
    "components/create/CreateMarketWizard.tsx",
    "components/create/MarketPreview.tsx",
    "components/create/CostEstimate.tsx",
    "components/create/StepTokenSelect.tsx",
    "components/create/LaunchSuccess.tsx",
    "lib/wizard-copy.ts",
  ];
  it("no user-facing 'Sim-USDC' / 'sim-USDC' left in these surfaces", () => {
    for (const f of USER_FACING) expect(code(f), f).not.toMatch(/[Ss]im[- ]USDC/);
  });
});
