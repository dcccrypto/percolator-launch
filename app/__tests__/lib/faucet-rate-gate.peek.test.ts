/** peekFaucetGate splits errors like tryFaucetGate: a missing table is "unavailable" (durable fallback), any other read error is "unknown". */
import { describe, expect, it } from "vitest";
import { FaucetGateReadError, FaucetGateUnavailableError, peekFaucetGate } from "@/lib/faucet-rate-gate";

function sb(result: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: result.data ?? null, error: result.error ?? null });
  return { from: () => q };
}

describe("peekFaucetGate", () => {
  it("a missing table (PGRST205 / 42P01) is the 'unavailable' error", async () => {
    await expect(peekFaucetGate(sb({ error: { code: "PGRST205", message: "x" } }), "w", "usdc")).rejects.toBeInstanceOf(FaucetGateUnavailableError);
    await expect(peekFaucetGate(sb({ error: { code: "42P01", message: "x" } }), "w", "usdc")).rejects.toBeInstanceOf(FaucetGateUnavailableError);
  });
  it("any other read error is the 'read failed' error, not 'unavailable'", async () => {
    const e = await peekFaucetGate(sb({ error: { code: "57014", message: "timeout" } }), "w", "usdc").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FaucetGateReadError);
    expect(e).not.toBeInstanceOf(FaucetGateUnavailableError);
  });
  it("no row = not limited; a row = limited with the next time", async () => {
    expect(await peekFaucetGate(sb({}), "w", "usdc")).toEqual({ limited: false, nextClaimAt: null });
    const r = await peekFaucetGate(sb({ data: { claimed_at: "2099-01-01T00:00:00.000Z" } }), "w", "usdc", 1000);
    expect(r.limited).toBe(true);
    expect(r.nextClaimAt).toBe("2099-01-01T00:00:01.000Z");
  });
});
