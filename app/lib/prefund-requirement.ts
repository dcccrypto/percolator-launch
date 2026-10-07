/**
 * What a market launch costs the creator, and what the devnet faucet therefore
 * has to mint.
 *
 * WHY THIS IS A MODULE AND NOT CONSTANTS IN THE ROUTE
 *
 * This arithmetic had four copies: `/api/devnet-pre-fund`'s local constants,
 * `CreateMarketWizard.tsx`'s launch gate, `createMarketValidation.ts:163` and
 * `CostEstimate.tsx:132`. Three of them drifted.
 *
 * GH#2515 / PR#2516 fixed the wizard gate after it omitted both backing-bucket
 * deposits. That PR touched two files and never reached the route, and on devnet
 * the wizard gate is switched off entirely (`skipTokenBalanceCheck = isDevnet ||
 * mockBypass`), so the route's stale copy became the only guard — and it was
 * understated by exactly the two deposits #2515 was about. GH#2592.
 *
 * The route's tests had a fifth copy, declared as "Mirrors
 * app/api/devnet-pre-fund/route.ts constants", which meant a test suite could
 * stay green while the route it mirrored changed underneath it. It did.
 *
 * So: one definition, imported by the route and by its tests. Server-safe —
 * nothing here is a client module, and no Solana or Supabase dependency.
 */

import { backingSeedPerDomain } from "@/lib/market-params";

/**
 * The vault seed is deliberately NOT part of this total.
 *
 * `MIN_INIT_MARKET_SEED` (500 tokens) looks like it belongs here and does not.
 * The W11 fix (2026-07-08, hooks/useCreateMarket.ts) removed the pre-InitMarket
 * vault Transfer entirely: `launch-test-market.ts`, the proven on-chain
 * reference, never seeds the vault before InitMarket and still succeeds, because
 * the engine does not require or account for a pre-existing vault balance. There
 * is no `createTransferInstruction` anywhere in the launch hook, and
 * `MIN_INIT_MARKET_SEED` survives there only in its own definition and two
 * "we removed this" comments.
 *
 * Charging it would over-state the requirement by 500 tokens, which is not
 * harmless: a balance between the real cost and the inflated one would stop
 * short-circuiting at the balance check and fall through to the 24h gate, where
 * a still-open claim 429s and aborts the launch mid-flight — the same class of
 * failure this module exists to prevent, just at a different balance.
 *
 * (The mobile route, app/api/mobile/create-market, DOES transfer a seed. It is a
 * different flow and does not call this endpoint.)
 */

/**
 * Amounts assumed when a caller sends none — the reference launch the pre-fund
 * route was originally written around (LP 1,000 / insurance 100 tokens at 6
 * decimals). Kept only so an un-updated caller still gets funded; a caller that
 * sends its real amounts always wins.
 */
export const DEFAULT_LP_COLLATERAL = 1_000_000_000n;
export const DEFAULT_INSURANCE_AMOUNT = 100_000_000n;

/**
 * Ceiling on a fundable launch, expressed as a REQUIREMENT (the mint is 2× it).
 *
 * The caller supplies the amounts that size the mint, so this bounds what a
 * single request can ask the faucet authority for. Before this was
 * request-derived the route always minted a fixed 3,200; keeping the ceiling
 * tight limits how far that amplification goes. At 10,000 the mint tops out at
 * 20,000 tokens — the same order as /api/faucet's flat 10,000 — and still covers
 * an LP seed of ~3,300, over 3x the default.
 *
 * Exceeding it must be REFUSED, never clamped: funding part-way and reporting
 * success is precisely the defect this module exists to remove.
 *
 * NOTE this route has no per-IP fund limiter, unlike /api/playground/faucet,
 * /api/auto-fund and /api/devnet-airdrop (see lib/fund-ip-rate-limit.ts). Only
 * the per-wallet 24h gate and middleware's general 120 req/min/IP apply, and
 * fresh keypairs defeat the former. Adding one is a separate decision.
 */
export const MAX_FUNDABLE_REQUIREMENT = 10_000_000_000n; // 10,000 tokens

/**
 * Total tokens a full market creation draws from the creator's collateral
 * account:
 *
 *   LP collateral
 *   + insurance fund
 *   + ONE backing seed PER DOMAIN   ← TWO deposits, both from the creator
 *
 * `TopUpBackingBucket` runs for both the long and short domain during a launch.
 * At BACKING_SEED_PCT_OF_LP = 100 those two deposits are the largest single term
 * in the total, and their omission is what made a fully-funded wallet unable to
 * finish a launch.
 *
 * Derived from `backingSeedPerDomain` rather than restated: that helper carries
 * the percentage AND the absolute floor (BACKING_SEED_MIN_ATOMS), and the
 * hand-copies in createMarketValidation.ts and CostEstimate.tsx reimplement it
 * in floating-point `Number` and apply no floor at all.
 */
export function fullMarketRequirement(
  lpCollateral: bigint,
  insuranceAmount: bigint,
): bigint {
  return lpCollateral + insuranceAmount + 2n * backingSeedPerDomain(lpCollateral);
}

/**
 * What the faucet mints, given a requirement.
 *
 * 2× for retry headroom (#757) — and, load-bearing, so a SECOND
 * pre-fund call in a single launch still sees a sufficient balance and
 * short-circuits before the 24h per-wallet gate is consulted. (There are two
 * call sites, not the three the older comments claim — W11 deleted the
 * vault-seed call.) That property (H3,
 * GH#2335) only holds while the requirement is correct: understating it is what
 * pushed the step-4 call back into the gate and made it a 429.
 */
/**
 * The requirement actually used to fund, given what the caller asked for.
 *
 * SECURITY: the caller supplies the amounts and does NOT prove ownership of
 * `walletAddress`, and the 24h gate key is derived from public values. Letting a
 * request lower the target created an unauthenticated 24h launch-denial: POST a
 * victim's wallet with `lpCollateral: "0"`, the requirement collapses to the
 * backing floor, the gate is consumed, a token mint far too small to launch with
 * lands, and the victim's own launch then 429s for a full day. Before the amounts
 * were request-derived this was impossible, because the fixed mint happened to
 * satisfy a real launch.
 *
 * So a request may only ever raise the target. Upward correctness (a large LP
 * launch gets funded for a large LP launch) is preserved; the downward grief is
 * gone.
 */
export function fundingRequirement(lpCollateral: bigint, insuranceAmount: bigint): bigint {
  const asked = fullMarketRequirement(lpCollateral, insuranceAmount);
  const floor = fullMarketRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT);
  return asked > floor ? asked : floor;
}

export function fundAmountFor(requirement: bigint): bigint {
  return requirement * 2n;
}

/**
 * Parse an optional atomic-unit amount from a request body.
 *
 * Strings of digits only. These amounts size a mint, so a silent `Number()`
 * coercion, a negative, a float or an exponent is not acceptable. Returns
 * `null` for a value that is PRESENT but malformed, so the caller can reject it
 * rather than fall back to a default that would under-fund; returns `fallback`
 * only when the field is genuinely absent.
 */
export const U64_MAX = 2n ** 64n - 1n;

export function parseAtomicAmount(raw: unknown, fallback: bigint): bigint | null {
  // Only a genuinely ABSENT field falls back. `null` is present-and-not-a-string,
  // so it is refused like any other malformed value rather than silently
  // under-funding.
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^[0-9]{1,20}$/.test(raw)) return null;
  const value = BigInt(raw);
  // The digit bound does not bound the VALUE: 20 digits reaches ~5.4x u64, and
  // leading zeros make the digit count meaningless anyway. Amounts end up in a
  // u64 mint instruction, so bound the number. Today the ceiling check would also
  // catch this, which is exactly the problem — u64 safety should not depend on a
  // policy limit somebody may later raise.
  if (value > U64_MAX) return null;
  return value;
}

/** The route's refusal text for its per-wallet claim window (not its per-IP limiter). */
export const PREFUND_GATE_ERROR = "Already pre-funded recently";

/** Per-wallet-per-mint claim window — the same hour the playground faucet uses. */
export const PREFUND_WINDOW_MS = 60 * 60 * 1000;

/**
 * What a non-OK answer from /api/devnet-pre-fund means for THIS launch.
 *
 * The route judges the wallet against `fundingRequirement`, which is floored at a
 * default-size launch, so it can refuse a wallet that already holds everything a
 * smaller launch needs. And it has three different 429s; only the claim window is
 * a refusal to fund, the per-IP limiter and the edge limiter are transient.
 *
 *  - "proceed": the wallet already covers this launch; the refusal is irrelevant.
 *  - "blocked": short, and inside the claim window. No path can fund the deposit.
 *  - "error":   short, refused for another reason. Left to the caller's old handling.
 */
export function classifyPreFundRefusal(input: {
  status: number;
  body: { error?: unknown; nextClaimAt?: unknown } | null;
  balance: bigint;
  lpCollateral: bigint;
  insuranceAmount: bigint;
}): { kind: "proceed" } | { kind: "blocked"; nextClaimAt: string | null } | { kind: "error" } {
  if (input.balance >= fullMarketRequirement(input.lpCollateral, input.insuranceAmount)) return { kind: "proceed" };
  const nextClaimAt = typeof input.body?.nextClaimAt === "string" ? input.body.nextClaimAt : null;
  if (input.status === 429 && (input.body?.error === PREFUND_GATE_ERROR || nextClaimAt !== null)) {
    return { kind: "blocked", nextClaimAt };
  }
  return { kind: "error" };
}
