import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMove } from "@/lib/v21/move/run";
import { buildMovePlan } from "@/lib/v21/move/plan";
import { V1_PROGRAM_IDS } from "@/lib/v21/move/ids";
import { stepHref } from "@/hooks/useMoveFlow";
import { input, market, pk } from "./fixtures";

const root = join(__dirname, "../../../..");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const V21 = { wrapper: pk(), matcher: pk(), nft: pk(), stake: pk() };
const open = { capital: 5n, releasedPnl: 0n, openLegs: 1, closeOnly: false };
const flat = { capital: 5n, releasedPnl: 0n, openLegs: 0, closeOnly: false };
const SLAB_B = pk();
afterEach(() => vi.restoreAllMocks());

/** Text of the first `const <name> = useCallback(` body up to the next top-level useCallback. */
function fnBody(file: string, name: string): string {
  const s = src(file);
  const i = s.indexOf(`const ${name} = useCallback(`);
  if (i < 0) throw new Error(`${name} not found in ${file}`);
  const j = s.indexOf("\n  const ", i + 10);
  return s.slice(i, j < 0 ? undefined : j);
}

describe("N-1 / N-2: account creation and junior deposits are guarded on v1", () => {
  it("useInitUser calls the guard after the program allowlist check, before any tx is built", () => {
    const s = src("hooks/useInitUser.ts");
    const g = s.indexOf('assertV1AllowsNewFunds(slabProgramId, "deposit")');
    expect(g).toBeGreaterThan(0);
    expect(g).toBeGreaterThan(s.indexOf("assertKnownProgram(slabProgramId)"));
    expect(g).toBeLessThan(s.indexOf("const programId = slabProgramId;"));
  });
  it("useJuniorTranche guards deposit only, never withdraw", () => {
    const s = src("hooks/useJuniorTranche.ts");
    expect(s).toContain("if (kind === 'deposit') assertV1AllowsNewFunds(programId, 'earn-deposit');");
    expect(s).not.toMatch(/kind === 'withdraw'\)\s*assertV1AllowsNewFunds/);
  });
  it("the Start Trading CTA is disabled and explains why under the flag", () => {
    const s = src("components/trade/OrderTicket.tsx");
    expect(s).toContain("disabled={initLoading || starterOver || v1CloseOnly}");
    expect(s).toContain('data-testid="v1-init-off"');
  });
});

describe("withdraw and claim stay unguarded (flag on, v1)", () => {
  it("useInsuranceLP.withdraw and the redemption paths do not call the guard; deposit does", () => {
    expect(fnBody("hooks/useInsuranceLP.ts", "deposit")).toContain("assertV1AllowsNewFunds(");
    expect(fnBody("hooks/useInsuranceLP.ts", "withdraw")).not.toContain("assertV1AllowsNewFunds");
    expect(fnBody("hooks/useInsuranceLP.ts", "resizeRedemption")).not.toContain("assertV1AllowsNewFunds");
  });
  it("useClaimCreatorFees does not import or call the guard", () => {
    const s = src("hooks/useClaimCreatorFees.ts");
    expect(s).not.toContain("assertV1AllowsNewFunds");
    expect(s).not.toContain("close-only");
  });
});

describe("N-3: a hand-off-only step does not stop later markets", () => {
  const resolvedOpen = market({ resolved: true, portfolio: open, settleOpensAtSlot: 0n });
  const later = market({ slab: SLAB_B, symbol: "JUP", portfolio: open });
  it("skips the settle hand-off, runs the later market's close, then reports the hand-off", async () => {
    let closed = false;
    const close = vi.fn(async () => { closed = true; return "sig"; });
    const scan = async () => input([resolvedOpen, { ...later, portfolio: closed ? flat : open }]);
    const r = await runMove({ scan, executors: { close }, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(r.sent).toEqual(["sig"]);
    expect(r.stop).toMatchObject({ reason: "handoff", action: { kinds: ["settle-resolved"] } });
  });
  it("with only the hand-off left it still stops with that hand-off and sends nothing", async () => {
    const r = await runMove({ scan: async () => input([resolvedOpen]), executors: {}, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21: V21 });
    expect(r.stop).toMatchObject({ reason: "handoff" });
    expect(r.sent).toEqual([]);
  });
});

describe("N-4: Finish now only once the force-close delay has elapsed", () => {
  const base = { resolved: true, portfolio: open };
  const stepOf = (m: ReturnType<typeof market>, nowSlot = 1_000n) => buildMovePlan(input([m], { nowSlot })).markets[0].steps.find((s) => s.kind === "settle-resolved");
  it("before the delay: waiting, with the wait in slots and no 'Finish now'", () => {
    const s = stepOf(market({ ...base, settleOpensAtSlot: 5_000n }));
    expect(s?.status).toBe("waiting");
    expect(s?.waitSlots).toBe(4_000n);
    expect(s?.line).not.toMatch(/Finish now/);
    expect(s?.line).toMatch(/in about/);
  });
  it("at or after the delay: ready, Earn hand-off when the wallet holds Earn", () => {
    const e = { shares: 1n, pending: null, requestsPaused: false };
    const s = stepOf(market({ ...base, earn: e, settleOpensAtSlot: 1_000n }));
    expect(s?.status).toBe("ready");
    expect(s?.handoff).toBe("earn");
    expect(s?.line).toMatch(/Finish now/);
    expect(stepHref("settle-resolved", "S", null, s?.handoff)).toBe("/earn/S");
  });
  it("no Earn vault: hands off to the market page, never promises Finish now", () => {
    const s = stepOf(market({ ...base, earn: null, settleOpensAtSlot: 0n }));
    expect(s?.status).toBe("ready");
    expect(s?.handoff).toBe("market");
    expect(s?.line).not.toMatch(/Finish now/);
    expect(stepHref("settle-resolved", "S", null, s?.handoff)).toBe("/trade/S");
  });
  it("unknown opening slot is not treated as waiting", () => {
    expect(stepOf(market({ ...base }))?.status).toBe("ready");
  });
});
