// @vitest-environment node
/**
 * Phase 0 honesty (devnet-v2-growth-plan 2026-10-04, task 5): the lock copy promises no duration, the ADL duration is
 * shown, per-market health reflects ADL and LP capital = 0, and dead markets read "v1 / Close-only".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as C from "@/lib/limits/constants";
import { decodeMarketHealth, healthBadges, isDeadMarket } from "@/lib/market-health";
import type { MarketHealthRow } from "@/lib/market-health";
import { marketHeaderStatus, LIST_BADGE_IDS } from "@/lib/market-header-status";
import { liveHealthLevel, isCloseOnlyRow, isNeedsLiquidityRow } from "@/lib/market-health-overlay";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { TICKET_COPY } from "@/lib/limits/copy";
import { MSG_LOSS_STALE } from "@/lib/market-error";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(Buffer.from(readFileSync(join(__dirname, "..", "fixtures", "v18-liveness", `${name}.b64`), "utf8").trim(), "base64"));
const SLOT = 505580400n;
const ADL_ONE = 1_000_000_000_000_000n;
const T0 = Date.UTC(2026, 9, 3, 15, 18, 0);

function writeU128(d: Uint8Array, off: number, v: bigint) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  dv.setBigUint64(off, v & 0xffff_ffff_ffff_ffffn, true);
  dv.setBigUint64(off + 8, v >> 64n, true);
}
/** A healthy market whose a_short was ADL-scaled down (SI 8WC8vALs: a_short 0.0267). */
function adlMarket(): Uint8Array {
  const d = fixture("pengu-market-v18-healthy").slice();
  writeU128(d, C.assetEngineOff(0) + C.A_A_SHORT, (ADL_ONE * 267n) / 10_000n);
  return d;
}
const row = (over: Partial<MarketHealthRow> = {}): MarketHealthRow => ({
  lpCapital: "49000000000",
  lpDepleted: false,
  payoutHaircutBps: 0,
  openProfitAtoms: "0",
  realizableProfitAtoms: "0",
  lockReasons: [],
  badges: [],
  ...over,
});

describe("no duration promised for locks", () => {
  const PROMISE = /within (a |\d+ )?(seconds?|minutes?)|usually (a few )?(seconds?|a minute)|(few|couple of) seconds|clears? (on its own )?(soon|quickly)/i;

  it("loss-stale badge, header status, ticket message and error copy make no time promise", () => {
    const h = decodeMarketHealth(
      (() => {
        const d = fixture("pengu-market-v18-healthy").slice();
        d[592 + 623] = 1; // loss_stale_active
        return d;
      })(),
      SLOT,
      1n,
    );
    const badge = healthBadges(h).find((b) => b.id === "loss-stale")!;
    expect(badge.detail).not.toMatch(PROMISE);
    expect(badge.detail).toBe("Positions are being refreshed after a price move. New positions wait until that finishes.");

    const status = marketHeaderStatus(row({ badges: [badge] }));
    expect(status?.kind).toBe("engine-catching-up");
    expect(status?.body).not.toMatch(PROMISE);

    const lockErr = Object.assign(new Error('Transaction simulation failed: {"InstructionError":[2,{"Custom":21}]}'), {
      name: "SimulationRefusal", code: 21, programId: "GnwdeQr", logs: [] as string[],
    });
    for (const surface of ["trade"] as const) {
      const m = resolveUserMessage(lockErr, { surface, health: { lossStale: true } });
      expect(`${m.title} ${m.body}`).not.toMatch(PROMISE);
    }
    expect(TICKET_COPY.catchingUp.body).not.toMatch(PROMISE);
    expect(MSG_LOSS_STALE).not.toMatch(PROMISE);
  });

  it("every copy is one short line", () => {
    for (const s of [TICKET_COPY.catchingUp.body, MSG_LOSS_STALE]) {
      expect(s.split(/[.!?]\s/).filter(Boolean).length).toBeLessThanOrEqual(2);
      expect(s.length).toBeLessThan(140);
    }
  });
});

describe("ADL duration", () => {
  it("the close-only badge says how long, as a lower bound, with the start in UTC", () => {
    const h = decodeMarketHealth(adlMarket(), SLOT, 1n);
    expect(h.lockReasons).toContain("adl-reduce-only");
    const b = healthBadges(h, T0, T0 + 57.6 * 3_600_000).find((x) => x.id === "adl-reduce-only")!;
    expect(b.detail).toContain("Close-only for at least 2 d 9 h (since 3 Oct, 15:18 UTC).");
  });

  it("no duration line when the start is unknown", () => {
    const h = decodeMarketHealth(adlMarket(), SLOT, 1n);
    const b = healthBadges(h, null).find((x) => x.id === "adl-reduce-only")!;
    expect(b.detail).not.toMatch(/at least/);
  });

  it("the header status carries it", () => {
    const h = decodeMarketHealth(adlMarket(), SLOT, 1n);
    const r = row({ badges: healthBadges(h, T0, T0), lockReasons: h.lockReasons, adlSinceMs: T0 });
    const st = marketHeaderStatus(r, T0 + 20.1 * 3_600_000);
    expect(st?.kind).toBe("adl-reduce-only");
    expect(st?.body).toContain("Close-only for at least 20 h (since 3 Oct, 15:18 UTC).");
  });

  it("NEGATIVE CONTROL: a market that is not reduce-only shows no duration", () => {
    const h = decodeMarketHealth(fixture("pengu-market-v18-healthy"), SLOT, 49_000_000_000n);
    expect(healthBadges(h, T0, T0 + 1).some((b) => b.id === "adl-reduce-only")).toBe(false);
  });
});

describe("per-market health reflects ADL and LP capital = 0", () => {
  it("Agency shape (LP capital 0, not ADL): 'Needs liquidity' from the live read overrides a stats 'healthy'; it is not close-only", () => {
    const h = decodeMarketHealth(fixture("pengu-market-v18-healthy"), SLOT, 0n);
    expect(h.lpDepleted).toBe(true);
    const r = row({ lpCapital: "0", lpDepleted: true, badges: healthBadges(h) });
    expect(isCloseOnlyRow(r)).toBe(false);
    expect(isNeedsLiquidityRow(r)).toBe(true);
    expect(liveHealthLevel("healthy", r)).toBe("needs-liquidity");
    expect(liveHealthLevel("caution", r)).toBe("needs-liquidity");
  });

  it("SI 8WC8vALs shape (ADL and LP 0): close-only wins", () => {
    const h = decodeMarketHealth(adlMarket(), SLOT, 0n);
    const r = row({ lpDepleted: true, badges: healthBadges(h, T0, T0) });
    expect(liveHealthLevel("healthy", r)).toBe("close-only");
  });

  it("NEGATIVE CONTROLS: healthy live read, unknown read and oracle-down never change the grade", () => {
    const h = decodeMarketHealth(fixture("pengu-market-v18-healthy"), SLOT, 49_000_000_000n);
    expect(liveHealthLevel("healthy", row({ badges: healthBadges(h) }))).toBe("healthy");
    expect(liveHealthLevel("healthy", null)).toBe("healthy");
    expect(liveHealthLevel("healthy", undefined)).toBe("healthy");
    const dead = row({ lpDepleted: true, badges: [{ id: "adl-reduce-only", label: "Close-only", tone: "warning", detail: "" }] });
    expect(liveHealthLevel("oracle-down", dead)).toBe("oracle-down");
    expect(isCloseOnlyRow(row({ badges: [{ id: "payout-haircut", label: "x", tone: "warning", detail: "" }] }))).toBe(false);
    expect(isCloseOnlyRow(row({ badges: [{ id: "bankruptcy", label: "x", tone: "info", detail: "" }] }))).toBe(false);
  });
});

describe("v1 / close-only labels only on markets that are actually dead (review B2)", () => {
  it("dead = ADL reduce-only or recovery. LP capital 0 is NOT dead: a new market waiting for its first deposit", () => {
    expect(isDeadMarket(decodeMarketHealth(adlMarket(), SLOT, 1n))).toBe(true);
    expect(isDeadMarket(decodeMarketHealth(fixture("pengu-market-v18-healthy"), SLOT, 0n))).toBe(false);
    expect(isDeadMarket(decodeMarketHealth(fixture("pengu-market-v18-healthy"), SLOT, 49_000_000_000n))).toBe(false);
  });

  it("an ADL market carries 'v1' right after its Close-only badge", () => {
    const badges = healthBadges(decodeMarketHealth(adlMarket(), SLOT, 1n), T0, T0);
    const i = badges.findIndex((b) => b.id === "adl-reduce-only");
    expect(badges[i + 1]?.id).toBe("v1");
    expect(badges[i + 1]?.label).toBe("v1");
    expect(LIST_BADGE_IDS.has("v1")).toBe(true);
  });

  it("a new market with LP capital 0 gets calm 'Needs liquidity' copy and NO v1 / close-only claim", () => {
    const h = decodeMarketHealth(fixture("pengu-market-v18-healthy"), SLOT, 0n);
    const badges = healthBadges(h);
    expect(badges.some((b) => b.id === "v1")).toBe(false);
    const lp = badges.find((b) => b.id === "lp-depleted")!;
    expect(lp.label).toBe("Needs liquidity");
    // non-vault: Earn does not reopen it, and the copy must not say it does
    expect(lp.detail).toMatch(/deposits to Earn or staking don't reopen it/);
    expect(lp.detail).not.toMatch(/v1|can't change|close-only/i);
  });

  it("an Earn-vault market says to deposit in Earn", () => {
    const h = { ...decodeMarketHealth(fixture("pengu-market-v18-healthy"), SLOT, 0n), lpIsVault: true };
    expect(healthBadges(h).find((b) => b.id === "lp-depleted")!.detail).toBe(
      "Needs liquidity: deposit in Earn to reopen new positions. Closing works normally.",
    );
  });

  it("NEGATIVE CONTROL: a live market has no v1 label", () => {
    const h = decodeMarketHealth(fixture("pengu-market-v18-healthy"), SLOT, 49_000_000_000n);
    expect(healthBadges(h).some((b) => b.id === "v1")).toBe(false);
  });
});
