/**
 * My Markets is reachable from the Earn hub as well as its own route, because
 * collecting creator fees is a way of earning on the platform.
 *
 * Tab ORDER is load-bearing here — the hub opens on the first tab — so these
 * cover the one thing that can silently regress when a tab is added.
 *
 * See components/earn/earnTabs.ts.
 */

import { describe, expect, it } from "vitest";
import {
  EARN_TABS,
  DEFAULT_EARN_TAB,
  isEarnTabKey,
} from "@/components/earn/earnTabs";

describe("the Earn hub lists every way to earn", () => {
  it("includes My Markets", () => {
    expect(EARN_TABS.map((t) => t.key)).toContain("markets");
  });

  it("CONTROL: still lists the surfaces that were already there", () => {
    // Guards against "added a tab" turning into "replaced a tab".
    const keys = EARN_TABS.map((t) => t.key);
    expect(keys).toContain("vault");
    expect(keys).toContain("stake");
  });

  it("gives every tab a distinct key", () => {
    // Two tabs sharing a key make the hash deep-link ambiguous and render both.
    const keys = EARN_TABS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("calls the staking tab \"Fee staking\" (it pays a share of trading fees)", () => {
    expect(EARN_TABS.find((t) => t.key === "stake")?.label).toBe("Fee staking");
  });

  it("labels every tab", () => {
    for (const t of EARN_TABS) expect(t.label.trim().length).toBeGreaterThan(0);
  });
});

describe("adding a tab must not move the landing surface", () => {
  it("still opens on LP Vault", () => {
    // The hub defaults to TABS[0]. My Markets was APPENDED for this reason —
    // inserting it would have silently changed which surface a visitor lands on,
    // with nothing else in the diff to show it.
    expect(DEFAULT_EARN_TAB).toBe("vault");
    expect(EARN_TABS[0].key).toBe("vault");
  });
});

describe("hash deep-linking", () => {
  it("accepts every tab's own key", () => {
    for (const t of EARN_TABS) expect(isEarnTabKey(t.key)).toBe(true);
  });

  it("rejects anything else, so a junk hash falls back to the default", () => {
    // Without the guard, `#<anything>` would be written straight into state and
    // render no tab content at all.
    expect(isEarnTabKey("markets-typo")).toBe(false);
    expect(isEarnTabKey("")).toBe(false);
    expect(isEarnTabKey("__proto__")).toBe(false);
  });
});
