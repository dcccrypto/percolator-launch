/**
 * #3601 follow-up (credited #3623): the bond launch's error panel. A fresh launch makes a new slab keypair, so it must
 * never be offered when the one transaction may already have landed, and never run twice for one error.
 */
import { describe, expect, it, vi } from "vitest";
import { bondRetryAction, freshLaunchOnce } from "@/lib/v22/bond-relaunch";

const at = (o: Partial<Parameters<typeof bondRetryAction>[0]>) => bondRetryAction({ bond: true, step: 0, resumeFromStep: null, outcomeUnknown: false, ...o });

describe("bondRetryAction", () => {
  it("sent but not confirmed (may have landed in full): no Continue, no fresh relaunch", () => {
    expect(at({ outcomeUnknown: true })).toBe("hidden");
  });
  it("nothing on chain at step 0 (declined, refused): Continue is a fresh launch", () => {
    expect(at({})).toBe("fresh");
  });
  it("a stuck-slab resume keeps the normal path", () => {
    expect(at({ resumeFromStep: 0 })).toBe("default");
    expect(at({ step: 2 })).toBe("default");
  });
  it("CONTROL: a launch without a bond is never changed, even when the outcome is unknown", () => {
    expect(at({ bond: false })).toBe("default");
    expect(at({ bond: false, outcomeUnknown: true })).toBe("default");
  });
});

describe("freshLaunchOnce", () => {
  it("a double click starts one launch", () => {
    const guard = { current: false };
    const launch = vi.fn(() => true);
    freshLaunchOnce(guard, launch);
    freshLaunchOnce(guard, launch);
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("a launch that stopped before starting re-arms the guard (the button never goes dead)", () => {
    const guard = { current: false };
    const launch = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    freshLaunchOnce(guard, launch);
    expect(guard.current).toBe(false);
    freshLaunchOnce(guard, launch);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(guard.current).toBe(true);
  });
});

describe("the wizard routes its error panel through these", () => {
  it("Continue is withheld and the fresh-launch shortcut is skipped when the outcome is unknown", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../../../components/create/CreateMarketWizard.tsx"), "utf8");
    expect(src).toMatch(/onRetry=\{bondRetry === "hidden" \? undefined : handleRetry\}/);
    expect(src).toMatch(/if \(bondRetry === "hidden"\) return false;/);
    expect(src).toMatch(/outcomeUnknown: !!createState\.outcomeUnknown/);
    // Every fresh launch from the panel goes through one path: the blocked-reason note, then the one-shot guard.
    expect(src).toMatch(/const freshFromPanel = [\s\S]{0,300}retryBlockedReason\([\s\S]{0,200}setRetryNote\(blocked\);\n\s+if \(blocked\) return;\n\s+freshLaunchOnce\(bondChoiceUsedRef, run\);/);
    expect(src.match(/freshFromPanel\(/g)?.length).toBe(3);
    // The second is I-1's "Continue without the bond": one resume per refusal, not a fresh launch.
    expect(src.match(/freshLaunchOnce\(/g)?.length).toBe(2);
    expect(src).toMatch(/const handleContinueWithoutBond = \(\) =>\n\s+freshLaunchOnce\(bondChoiceUsedRef,/);
  });
});
