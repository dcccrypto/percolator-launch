/**
 * H3: /api/devnet-pre-fund must check the on-chain balance BEFORE consuming the
 * 24h per-wallet-per-mint rate gate.
 *
 * All three pre-fund calls inside a single wizard launch (vault seed, LP
 * collateral, insurance top-up — see hooks/useCreateMarket.ts) target the SAME
 * wallet + the SAME shared sim-USDC collateral mint, so they hash to one gate
 * key. Checking the gate before the balance meant the 2nd/3rd call in one flow
 * always collided with the 1st call's still-open 24h claim and 429'd, throwing
 * mid-launch — even though FUND_AMOUNT already tops up to 2× the full
 * three-step requirement.
 *
 * We test the ordering in isolation (no live Solana RPC / Supabase needed),
 * mirroring the gate-integration test shape in gh1601-devnet-pre-fund-rate-limit.test.ts.
 */
import { describe, it, expect } from "vitest";

interface GateResult {
  allowed: boolean;
  nextClaimAt: string | null;
  claimId?: number;
}

// Mirrors app/api/devnet-pre-fund/route.ts constants.
const FULL_MARKET_TOKEN_REQUIREMENT = 1_600_000_000n;
const FUND_AMOUNT = FULL_MARKET_TOKEN_REQUIREMENT * 2n;

/** Simulates the post-H3 balance-first flow from devnet-pre-fund/route.ts. */
async function simulatePreFund(
  currentBalance: bigint,
  tryFaucetGate: () => Promise<GateResult>,
  doMint: () => Promise<{ sig: string }>,
): Promise<
  | { status: "sufficient"; balance: string }
  | { status: "funded"; sig: string }
  | { status: "rate_limited"; nextClaimAt: string | null }
> {
  // H3: balance check comes FIRST — the gate is never touched on this path.
  if (currentBalance >= FULL_MARKET_TOKEN_REQUIREMENT) {
    return { status: "sufficient", balance: currentBalance.toString() };
  }

  const gate = await tryFaucetGate();
  if (!gate.allowed) {
    return { status: "rate_limited", nextClaimAt: gate.nextClaimAt };
  }

  const { sig } = await doMint();
  return { status: "funded", sig };
}

describe("H3: devnet-pre-fund balance-first gate ordering", () => {
  it("1st call in a flow (empty wallet): consumes the gate and mints", async () => {
    let gateConsumed = false;
    const tryFaucetGate = async () => {
      gateConsumed = true;
      return { allowed: true, nextClaimAt: null, claimId: 1 };
    };
    const doMint = async () => ({ sig: "SIG_1" });

    const result = await simulatePreFund(0n, tryFaucetGate, doMint);
    expect(result.status).toBe("funded");
    expect(gateConsumed).toBe(true);
  });

  it("2nd call in the same flow (already funded by the 1st): never touches the gate", async () => {
    let gateTouched = false;
    const tryFaucetGate = async () => {
      gateTouched = true;
      // The 1st call's still-open 24h claim — this must NEVER be reached.
      return { allowed: false, nextClaimAt: new Date(Date.now() + 86_400_000).toISOString() };
    };
    const doMint = async () => ({ sig: "SHOULD_NOT_REACH" });

    // Balance already at FUND_AMOUNT (2×) from the 1st call's mint.
    const result = await simulatePreFund(FUND_AMOUNT, tryFaucetGate, doMint);
    expect(result.status).toBe("sufficient");
    expect(gateTouched).toBe(false);
  });

  it("3rd call in the same flow (balance drawn down but still sufficient): still a no-op, no gate", async () => {
    let gateTouched = false;
    const tryFaucetGate = async () => {
      gateTouched = true;
      return { allowed: false, nextClaimAt: new Date().toISOString() };
    };
    const doMint = async () => ({ sig: "SHOULD_NOT_REACH" });

    // Vault seed (500 tokens) already spent since the 1st mint — still well
    // above the 1,600-token full requirement.
    const result = await simulatePreFund(FUND_AMOUNT - 500_000_000n, tryFaucetGate, doMint);
    expect(result.status).toBe("sufficient");
    expect(gateTouched).toBe(false);
  });

  it("genuinely under-funded AND rate-limited: still 429s (gate stays enforced when it matters)", async () => {
    const tryFaucetGate = async () => ({
      allowed: false,
      nextClaimAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const doMint = async () => ({ sig: "SHOULD_NOT_REACH" });

    const result = await simulatePreFund(0n, tryFaucetGate, doMint);
    expect(result.status).toBe("rate_limited");
  });
});
