// @vitest-environment node
/** UX WP-9 AC1 (audit §3.10): the creator-stake state, the program's 97 rule, reason precedence. */
import { describe, expect, it } from "vitest";
import { CREATOR_STAKE_PANEL_COPY, clampStakeWithdraw, clampStakeWithdrawFor, creatorStakeState, stakeReasonFromRefusal } from "@/lib/limits/creator-stake";
import { juniorWithdrawableAtoms } from "@/lib/limits/vault-tranche";
import { SimulationRefusal } from "@/lib/tx";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { isJuniorWithdrawRefusal } from "@/hooks/useJuniorTranche";

const C = 1_000_000_000n;
const base = { vaultValue: C + 300_000_000n, seniorClaimEff: C, backingCover: C, floorBps: 2_000, lpFlat: true, drawOutstandingAtoms: 0n, impaired: false };

describe("creatorStakeState", () => {
  it("withdrawable = junior above the floor (the same rule as juniorWithdrawableAtoms), no reason", () => {
    const s = creatorStakeState(base);
    expect(s).toMatchObject({ stakeValue: 300_000_000n, protects: C, mustKeep: 200_000_000n, floorPct: "20%", withdrawable: 100_000_000n, reason: null });
    expect(s.withdrawable).toBe(juniorWithdrawableAtoms(base.vaultValue, C, C, 2_000));
  });
  it("reason precedence: draw pending > LP open > backing short > at floor; withdrawable 0 with each", () => {
    expect(creatorStakeState({ ...base, drawOutstandingAtoms: 1n, lpFlat: false, backingCover: 0n })).toMatchObject({ reason: "draw-pending", withdrawable: 0n });
    expect(creatorStakeState({ ...base, lpFlat: false, backingCover: 0n })).toMatchObject({ reason: "lp-open", withdrawable: 0n });
    expect(creatorStakeState({ ...base, backingCover: C - 1n })).toMatchObject({ reason: "backing-short", withdrawable: 0n });
    expect(creatorStakeState({ ...base, vaultValue: C + 150_000_000n })).toMatchObject({ reason: "at-floor", withdrawable: 0n });
  });
  it("unknown value: no withdrawable, no reason; 12.5% floors keep a decimal", () => {
    expect(creatorStakeState({ ...base, vaultValue: null })).toMatchObject({ stakeValue: null, withdrawable: null, reason: null });
    expect(creatorStakeState({ ...base, floorBps: 1_250 }).floorPct).toBe("12.5%");
  });
  it("a 75 refusal maps to the state's reason, else a NEUTRAL line (GH#3680)", () => {
    // Unchanged: a reason the state explains always wins.
    expect(stakeReasonFromRefusal(creatorStakeState({ ...base, drawOutstandingAtoms: 3n }))).toBe("draw-pending");
    expect(stakeReasonFromRefusal(creatorStakeState({ ...base, lpFlat: false, backingCover: 0n }))).toBe("lp-open");
    expect(stakeReasonFromRefusal(creatorStakeState({ ...base, backingCover: C - 1n }))).toBe("backing-short");
    // A real at-floor state still reads as the floor.
    expect(stakeReasonFromRefusal(creatorStakeState({ ...base, vaultValue: C + 150_000_000n }))).toBe("at-floor");

    // CHANGED (GH#3680). `base` has `reason: null` and `withdrawable: 100_000_000n` -- the state
    // does NOT explain this refusal, and it computed a POSITIVE withdrawable above the floor.
    // The old fallback answered "at-floor" ("This is the minimum you must keep while Earn
    // deposits are in the vault"), which this very fixture disproves. Tag 97 has more refusal
    // causes than this module models -- RC2 adds the AUD-S1-15 open-interest lock, which fires
    // when the vault LP is FLAT, i.e. exactly when `lp-open` is not selected -- so the fallback
    // must not name a cause it cannot know.
    const unexplained = creatorStakeState(base);
    expect(unexplained).toMatchObject({ reason: null, withdrawable: 100_000_000n });
    expect(stakeReasonFromRefusal(unexplained)).toBe("locked");
  });
  it("clamp", () => {
    expect(clampStakeWithdraw(5n, 3n)).toBe(3n);
    expect(clampStakeWithdraw(2n, 3n)).toBe(2n);
    expect(clampStakeWithdraw(2n, null)).toBe(0n);
    expect(clampStakeWithdraw(-1n, 3n)).toBe(0n);
  });
  it("isJuniorWithdrawRefusal: only a pre-sign 75 refusal", () => {
    expect(isJuniorWithdrawRefusal(new SimulationRefusal({ InstructionError: [1, { Custom: WRAPPER_ERR.VaultLpJuniorWithdrawRefused }] }))).toBe(true);
    expect(isJuniorWithdrawRefusal(new SimulationRefusal({ InstructionError: [1, { Custom: 21 }] }))).toBe(false);
    expect(isJuniorWithdrawRefusal(new Error("custom program error: 0x4b"))).toBe(false);
  });
});

/** D1 interim (v22 deep memo 2026-10-29): the deployed rule is net-based. Tag 97 refuses unless (deposited - withdrawn) after is 0 or >= $500. */
describe("creatorStakeState: the deployed net-deposit rule (D1 interim)", () => {
  const MIN = 500_000_000n;
  // Earn claim 1000, floor 20%: the value rule alone would let value - 200 leave.
  const g = { ...base, floorBps: 2_000 };
  const rule = (deposited: bigint, withdrawn = 0n) => ({ netRule: { deposited, withdrawn, minAtoms: MIN } });

  it("after a loss: $500 in, value 400 junior => nothing is offered, reason 'net-minimum' (the memo's example)", () => {
    // value 1400 = C 1000 + 400 junior; floor 200 => value rule alone offers 200, which the program refuses (net 300 in (0, 500)).
    const s = creatorStakeState({ ...g, vaultValue: C + 400_000_000n, ...rule(500_000_000n) });
    expect(s.withdrawable).toBe(0n);
    expect(s.reason).toBe("net-minimum");
    expect(clampStakeWithdrawFor(200_000_000n, s)).toBe(0n);
    expect(clampStakeWithdrawFor(400_000_000n, s)).toBe(0n);
  });
  it("net 1000, value 1100 junior (floor leaves 900 free): offers only what leaves >= 500 net, never an amount that leaves (0, 500)", () => {
    const s = creatorStakeState({ ...g, vaultValue: C + 1_100_000_000n, ...rule(1_000_000_000n) });
    expect(s.withdrawable).toBe(500_000_000n);
    expect(clampStakeWithdrawFor(900_000_000n, s)).toBe(500_000_000n);
    expect(clampStakeWithdrawFor(700_000_000n, s)).toBe(500_000_000n);
    expect(clampStakeWithdrawFor(500_000_000n, s)).toBe(500_000_000n);
    expect(clampStakeWithdrawFor(300_000_000n, s)).toBe(300_000_000n);
  });
  it("a full exit (net after 0) is offered only when the value rule allows the whole net", () => {
    const s = creatorStakeState({ ...g, vaultValue: C + 1_000_000_000n, ...rule(800_000_000n) });
    expect(s.withdrawable).toBe(800_000_000n);
    expect(clampStakeWithdrawFor(800_000_000n, s)).toBe(800_000_000n);
    expect(clampStakeWithdrawFor(600_000_000n, s)).toBe(300_000_000n); // 600 would leave 200 in (0, 500)
    expect(clampStakeWithdrawFor(900_000_000n, s)).toBe(300_000_000n);
  });
  it("a refused value rule keeps its own reason (at-floor beats net-minimum); null netRule is the old behaviour", () => {
    expect(creatorStakeState({ ...g, vaultValue: C + 150_000_000n, ...rule(500_000_000n) }).reason).toBe("at-floor");
    expect(creatorStakeState({ ...base })).toMatchObject({ withdrawable: 100_000_000n, reason: null });
    expect(clampStakeWithdrawFor(250_000_000n, creatorStakeState({ ...base }))).toBe(100_000_000n);
    expect(clampStakeWithdrawFor(1n, creatorStakeState({ ...base, vaultValue: null }))).toBe(0n);
  });
  it("copy: the interim sentence, exactly", () => {
    expect(CREATOR_STAKE_PANEL_COPY.reasons["net-minimum"]).toBe(
      "Locked until the market settles after a loss; withdrawals must leave at least $500 in deposits.",
    );
  });
});
