// @vitest-environment node
/**
 * #3605: a quote whose simulation the wrapper refuses keeps the refusal code, so the Earn exit can show the mapped
 * line (cooldown, OI reservation, amount) instead of "Something went wrong and nothing was sent.".
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { keepAppMessage, parseFailure, plainMessage } from "@/lib/limits/user-message";
import { quoteExit, type ExitRunDeps, type SimResult } from "@/lib/v22/earn-exit-run";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

const wrapper = resolveDevnetProgramIds().wrapper;
const k = () => Keypair.generate().publicKey;
const input = {
  ctx: { market: { programId: new PublicKey(wrapper), market: k(), registryDomain: 0 }, redeemer: k(), redeemerLpAta: k(), redeemerDest: k(), vaultToken: k(), sourceDomain: 0, shares: 1_000n },
  mode: "execute" as const,
};
const refused = (code: number): SimResult => ({ err: { InstructionError: [0, { Custom: code }] }, logs: [`Program ${wrapper} failed: custom program error: 0x${code.toString(16)}`], destAfter: null });
const deps = (sim: SimResult): ExitRunDeps => ({ readStale: async () => [], readDestBalance: async () => 0n, simulate: vi.fn(async () => sim), send: vi.fn(), parse: parseFailure, sleep: async () => {} });
// What useEarnExitV22 shows for a failure.
const shown = (e: unknown) => plainMessage(e, { surface: "earn-withdraw" }, keepAppMessage);

describe("#3605: an Earn exit quote refused by the wrapper keeps its code", () => {
  it("cooldown (36) shows the cooldown line, not the generic failure", async () => {
    const r = await quoteExit(input, deps(refused(WRAPPER_ERR.LpVaultCooldownActive)));
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(shown(r.error)).toBe("Ready in a moment.");
  });

  it("CONTROL: a code with no copy shows the runner's own line, never raw chain text", async () => {
    const r = await quoteExit(input, deps(refused(9_999)));
    if (r.status !== "failed") throw new Error("expected failed");
    expect(shown(r.error)).toBe("The exit could not be priced right now. Try again shortly.");
  });
});
