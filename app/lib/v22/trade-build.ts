/**
 * Server-side builder for a v2.2 market order: the same instructions hooks/useTrade.ts sends, returned UNSIGNED.
 *
 * Used by POST /api/v22/trade so a bot, an agent or a Blink can trade without the browser. The server never signs
 * and never sends; every transaction is simulated here (sigVerify off, read-only) before it is returned, and the
 * refusal is returned instead when it does not simulate clean.
 *
 * Same pieces as the hook, in the same order:
 *  - market checks: wrapper allowlist, v2.2 layout, lot surface (lotTradingRefusal), single-asset only (v1);
 *  - accounts: the market LP by on-chain identity + canonical matcher (lib/v22/trade-accounts.ts), the owner's portfolio;
 *  - limit: from the engine's effective price (lib/close-limit.ts limitFromEngine, as the ticket sends), never a feed;
 *  - fee cap: lib/limits/trade-fee-resolve.ts, strict (an unreadable market refuses); a 98 is rebuilt once with the
 *    utilisation maximum, only within the caller's maxFeeBps;
 *  - lev guard tail, funding memo (when it fits), taker crank plan (lib/taker-crank.ts), self-heal (lib/self-heal.ts),
 *    a 121 answered with the stale peers' refresh cranks (lib/v22/trade-refresh-wire.ts).
 * Not covered (refused): multi-asset markets, a first trade (no portfolio yet), splits over the matcher's per-fill cap.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  encodePermissionlessCrank,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  buildIx,
  derivePythPushOraclePDA,
  parseWrapperConfigV17,
  parseAssetOracleProfileV17,
  V17_HEADER_LEN,
} from "@percolatorct/sdk";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { getMaintenanceConfig } from "@/lib/maintenance";
import { isWrapperAccount, marketGeometry, parsePortfolio } from "@/lib/v22/layout";
import { marketAssetSlots } from "@/lib/v22/trade-refresh";
import { planTradeRefresh } from "@/lib/v22/trade-refresh-wire";
import { lotTradingRefusal } from "@/lib/v22/lot-coverage";
import { lotExpOfMarketV22 } from "@/lib/v22/sdk/v22-lot";
import { levGuardExists } from "@/lib/v22/lev-guard";
import { resolveLpTradeAccounts, isReducingOrder } from "@/lib/v22/trade-accounts";
import { findOwnerPortfolio } from "@/lib/owner-portfolio";
import { detectOracleMode } from "@/lib/oraclePrice";
import { decodeMarketEngineView, signedPositionForAsset } from "@/lib/limits/decode";
import { effectiveLeg } from "@/lib/limits/effective-quantity";
import { fetchTradeFeeBps, isUtilFeeNotCovered } from "@/lib/limits/trade-fee-resolve";
import { limitFromEngine } from "@/lib/close-limit";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { sanitizePriceE6 } from "@/lib/oraclePrice";
import { buildTradeIxs } from "@/lib/trade-ix";
import { fetchPortfolioIdentity, fetchAssetMarketId, defaultCrankObservations } from "@/lib/v18-wire";
import { planTakerCrank } from "@/lib/taker-crank";
import { readBeforeTradeFull } from "@/lib/position-change";
import { memoIfFits, openFundingMemoIx } from "@/lib/funding-memo";
import { simulateForGate, SimulationRefusal, getPriorityFee } from "@/lib/tx";
import { planSelfHeal, connectionSelfHealDeps, isSelfHealEnabled } from "@/lib/self-heal";
import { MAX_TX_COMPUTE_UNITS, signedComputeUnitLimit, tradeCuCap } from "@/lib/compute-budget";
import { isLossStaleError } from "@/lib/v21/loss-stale-retry";
import { finalTxWireSize, PACKET_DATA_SIZE } from "@/lib/limits/resolved-topup";

export interface TradeBuildRequest {
  owner: PublicKey;
  slab: PublicKey;
  /** Signed engine size (q): > 0 buy, < 0 sell. */
  size: bigint;
  /** Slippage around the engine's effective price; default = the app's (lib/slippage.ts). Ignored with limitPriceE6. */
  slippageBps?: bigint;
  /** Explicit worst price (E6, per lot as the engine prices). 0 is refused: it disables the on-chain check. */
  limitPriceE6?: bigint;
  /**
   * The most fee (bps) the caller agrees to sign. Without it the fee the market requires now is signed, and a 98 (that fee
   * no longer covers the utilisation fee) is refused with the new cap instead of raised silently: an API caller is a
   * confirmed order (the hook's sendWithConfirmedFeeCap), never the silent close retry.
   */
  maxFeeBps?: bigint;
  /** The owner's portfolio on this market, when the caller knows it: checked (program, owner, market) and the scan is skipped. */
  portfolio?: PublicKey;
  /**
   * Caller checks that run once the market, the limit and the owner's position are known and BEFORE anything is simulated
   * (the bot API's caps: slippage, notional, leverage, reduce-only). Throw to refuse; nothing is built. May be async
   * (the bot API reads the LP's accounts for the per-side size cap); a rejection that is not the caller's own error
   * reads as an RPC failure.
   */
  preflight?: (p: TradePreflight) => void | Promise<void>;
  /**
   * An order still refused 121 (EngineLossStale) after the stale peers' refresh cranks: when the taker has an open leg and a
   * crank of its portfolio simulates clean, return that crank alone with resubmitAfter, as a reducing order gets. Without
   * it a buy failed non-retryably where a sell got the crank (council trader seat). Off for POST /api/v22/trade.
   */
  crankOnLossStale?: boolean;
}

export interface TradePreflight {
  size: bigint;
  limitPriceE6: bigint;
  /** Engine effective price (0 when unreadable). */
  effectivePriceE6: bigint;
  /**
   * Signed ADL-EFFECTIVE position on this market before the order (null when unreadable: the engine would refuse the
   * leg, or the market's engine view does not decode). The engine applies a trade to this quantity, not to the leg's
   * raw basis (lib/limits/effective-quantity.ts), so every size check here uses it. A prior-reset leg owns 0.
   */
  positionBeforeQ: bigint | null;
  /** The leg is a prior-reset obligation: it owns no open interest (positionBeforeQ is 0). */
  positionLegReset: boolean;
  /** isReducingOrder on the effective position. */
  reducing: boolean;
  marketData: Uint8Array;
  portfolioData: Uint8Array | null;
  programId: PublicKey;
  market: PublicKey;
  /** The market's LP side the order trades against. */
  lp: { accountB: PublicKey; matcherCtx: PublicKey };
}

/**
 * The taker's ADL-effective signed position on asset 0 of this market, from the portfolio and market bytes.
 * `q` is null when the engine would refuse the leg (InvalidLeg) or the engine view is unreadable; `reset` marks a
 * prior-reset leg (owns 0). Same rule as hooks/useClosePosition.ts (effectiveLeg).
 */
export function effectiveTakerPosition(portfolio: Uint8Array, engine: ReturnType<typeof decodeMarketEngineView>): { q: bigint | null; reset: boolean } {
  if (!engine || engine.marketId === null || engine.marketId === undefined) return { q: null, reset: false };
  let pf: ReturnType<typeof parsePortfolio>;
  try {
    pf = parsePortfolio(portfolio);
  } catch {
    return { q: null, reset: false };
  }
  const leg = pf.legs.find((l) => l.active && l.assetIndex === 0 && l.marketId === engine.marketId);
  if (!leg) return { q: 0n, reset: false };
  const eff = effectiveLeg(engine, leg);
  if (eff.kind === "invalid") return { q: null, reset: false };
  return { q: eff.signedQ, reset: eff.kind === "reset" };
}

export interface BuiltTx {
  purpose: "crank" | "order";
  /** Unsigned; fee payer = owner; carries a recent blockhash. */
  transaction: Transaction;
  computeUnitLimit: number;
  unitsConsumed: number | null;
}

export interface TradeBuildResult {
  transactions: BuiltTx[];
  /**
   * true = only a maintenance crank of the owner's portfolio was returned: the order alone is refused until it lands, and
   * crank + order in one tx fails 21 (lib/taker-crank.ts). Send it, then ask again for the order.
   */
  resubmitAfter: boolean;
  /** The blockhash every returned tx carries and the block height after which none of them can land. */
  blockhash: string;
  lastValidBlockHeight: number;
  summary: {
    market: string;
    portfolio: string;
    lpPortfolio: string;
    size: string;
    limitPriceE6: string;
    effectivePriceE6: string;
    feeBps: string | null;
    lotExp: number;
    positionBeforeQ: string | null;
    reducing: boolean;
    repairs: string[];
  };
}

/** A refusal with a stable code and the HTTP status the route answers with. */
export class TradeBuildRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 422, readonly logs: string[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TradeBuildRefusal";
  }
}

const ZERO = new PublicKey(new Uint8Array(32));

/** Carries a preflight's own error out of buildV22Trade unchanged (every other non-refusal reads as an RPC failure). */
class PreflightThrow {
  constructor(readonly inner: unknown) {}
}

/**
 * The market's LP side, cached per (program, market) like the hook's 60 s trade-account cache: it is a market-wide
 * getProgramAccounts scan and only changes on SetMatcherConfig. A failed build does not evict it (the next scan is
 * at most 60 s away); a stale entry costs one refused simulation, never a wrong counterparty, because the canonical
 * matcher check ran when it was cached and the program checks the binding on every trade.
 */
const LP_TTL_MS = 60_000;
const lpCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof resolveLpTradeAccounts>> }>();
const lpInflight = new Map<string, Promise<Awaited<ReturnType<typeof resolveLpTradeAccounts>>>>();
async function cachedLp(connection: Connection, programId: PublicKey, market: PublicKey, now = Date.now()) {
  const k = `${programId.toBase58()}|${market.toBase58()}`;
  const hit = lpCache.get(k);
  if (hit && now - hit.at < LP_TTL_MS) return hit.value;
  const running = lpInflight.get(k);
  if (running) return running;
  const p = resolveLpTradeAccounts(connection, programId, market)
    .then((value) => {
      lpCache.set(k, { at: Date.now(), value });
      return value;
    })
    .finally(() => lpInflight.delete(k));
  lpInflight.set(k, p);
  return p;
}
function evictLp(programId: PublicKey, market: PublicKey): void {
  lpCache.delete(`${programId.toBase58()}|${market.toBase58()}`);
}
/** Test seam. */
export function __clearTradeBuildCacheForTest(): void {
  lpCache.clear();
  lpInflight.clear();
}

type Sim = Awaited<ReturnType<typeof simulateForGate>>;
/** Every simulation gates what is returned: an RPC failure is never read as "clean" (review finding 2). */
async function gate(connection: Connection, owner: PublicKey, ixs: TransactionInstruction[]): Promise<Sim> {
  const s = await simulateForGate(connection, owner, ixs);
  if (s.rpcFailed) throw new TradeBuildRefusal("rpc", "simulation RPC failed, try again", 503);
  return s;
}

function wrap(ixs: TransactionInstruction[], cuLimit: number, priorityFee: number, owner: PublicKey, blockhash: string): Transaction {
  const tx = new Transaction();
  // The wrapper aborts on its first heap allocation without the full heap frame: FIRST (lib/tx.ts sendTx).
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  return tx;
}

export async function buildV22Trade(connection: Connection, req: TradeBuildRequest): Promise<TradeBuildResult> {
  try {
    return await buildInner(connection, req);
  } catch (e) {
    if (e instanceof TradeBuildRefusal) throw e;
    if (e instanceof PreflightThrow) throw e.inner;
    // Anything else is a read that failed (rate limit, timeout, account vanished mid-build). Never a partial result.
    throw new TradeBuildRefusal("rpc", "a market read failed, try again", 503, [], e);
  }
}

async function buildInner(connection: Connection, req: TradeBuildRequest): Promise<TradeBuildResult> {
  const { owner, slab: slabPk, size } = req;
  // Same switch that stops every app send (lib/tx.ts sendTx).
  if (getMaintenanceConfig().blockWrites) throw new TradeBuildRefusal("maintenance", getMaintenanceConfig().message, 503);
  if (size === 0n) throw new TradeBuildRefusal("bad_size", "size must be non-zero", 400);
  if (req.limitPriceE6 !== undefined && req.limitPriceE6 <= 0n) {
    throw new TradeBuildRefusal("bad_limit", "limitPriceE6 must be > 0 (0 turns the on-chain slippage check off)", 400);
  }

  // ── market ────────────────────────────────────────────────────────────────
  const info = await connection.getAccountInfo(slabPk, "confirmed");
  if (!info) throw new TradeBuildRefusal("market_not_found", "market account not found", 404);
  try {
    assertKnownProgram(info.owner);
  } catch {
    throw new TradeBuildRefusal("unknown_program", "market is not owned by a known Percolator wrapper", 400);
  }
  const programId = info.owner;
  const raw = new Uint8Array(info.data);
  if (!isWrapperAccount(raw)) throw new TradeBuildRefusal("not_v22", "not a v2.2 market account", 400);
  const slots = marketAssetSlots(raw);
  if (slots === null || slots > 1) throw new TradeBuildRefusal("multi_asset_unsupported", "multi-asset markets are not supported by this endpoint yet");
  let lotExp: number;
  try {
    lotExp = lotExpOfMarketV22(raw);
  } catch {
    throw new TradeBuildRefusal("market_unreadable", "market lot exponent unreadable");
  }
  const lotRefusal = lotTradingRefusal(lotExp);
  if (lotRefusal) throw new TradeBuildRefusal("lots_unsupported", lotRefusal);

  const cfg = parseWrapperConfigV17(raw, V17_HEADER_LEN);
  const profile = parseAssetOracleProfileV17(raw, marketGeometry(raw, "trade-build").slotsBase);
  // Same oracle-mode shim as components/providers/SlabProvider.tsx (v17 branch).
  const indexFeedId = cfg.oracleMode !== 0 ? ZERO : (profile.oracleLegFeeds[0] ?? ZERO);
  const oracleMode = detectOracleMode({ oracleAuthority: profile.oracleAuthority, indexFeedId, oracleModeByte: cfg.oracleMode });
  const useAdminOracle = oracleMode !== "pyth-pinned";
  const feedHex = Array.from(indexFeedId.toBytes()).map((b) => b.toString(16).padStart(2, "0")).join("");
  const oracleAccount = useAdminOracle ? slabPk : derivePythPushOraclePDA(feedHex)[0];
  const oracleTail = useAdminOracle ? [] : [{ pubkey: oracleAccount, isSigner: false, isWritable: false }];

  // ── limit (engine effective price, as the ticket) ────────────────────────
  const engine = decodeMarketEngineView(raw);
  const effectiveE6 = engine ? sanitizePriceE6(engine.effectivePriceE6) : 0n;
  let limitPriceE6: bigint;
  try {
    limitPriceE6 = req.limitPriceE6
      ?? (req.slippageBps !== undefined
        ? (effectiveE6 > 0n ? computeLimitPriceE6({ markE6: effectiveE6, size, slippageBps: req.slippageBps }) : limitFromEngine(engine, size))
        : limitFromEngine(engine, size));
  } catch (e) {
    throw new TradeBuildRefusal("price_unreadable", e instanceof Error ? e.message : String(e), 503);
  }

  // ── accounts ──────────────────────────────────────────────────────────────
  // Order is fixed so the same request always answers the same way: the owner's account first (a missing account is
  // permanent, never dressed up as an RPC or LP problem), then the LP.
  const accountA = req.portfolio ?? (await findOwnerPortfolio(connection, programId, slabPk, owner).catch(() => {
    throw new TradeBuildRefusal("rpc", "portfolio lookup failed, try again", 503);
  }));
  if (!accountA) throw new TradeBuildRefusal("no_portfolio", "owner has no portfolio on this market; deposit in the app first", 409);
  const lp = await cachedLp(connection, programId, slabPk).catch((e) => {
    // Fixed text: the cause carries upstream RPC wording (review finding 5). An RPC failure is retryable, never "no LP".
    if (e instanceof Error && e.message.startsWith("Failed to scan")) throw new TradeBuildRefusal("rpc", "a market read failed, try again", 503, [], e);
    throw new TradeBuildRefusal("no_lp", "this market has no usable LP right now", 503, [], e);
  });

  const beforeFull = readBeforeTradeFull(connection, accountA, slabPk).catch(() => null);
  // A caller-named portfolio is checked BEFORE anything reads its identity: a wrong or missing account is the caller's input
  // (bad_portfolio, 400), not an RPC problem. It must be the owner's own taker portfolio on THIS market (same fields the scan selects on).
  let namedInfo: Awaited<ReturnType<Connection["getAccountInfo"]>> | undefined;
  if (req.portfolio) {
    namedInfo = await connection.getAccountInfo(accountA, "confirmed");
    let pf: ReturnType<typeof parsePortfolio> | null = null;
    try {
      pf = namedInfo && namedInfo.owner.equals(programId) ? parsePortfolio(new Uint8Array(namedInfo.data)) : null;
    } catch {
      pf = null;
    }
    if (!pf || !pf.owner.equals(owner) || !pf.marketGroupId.equals(slabPk) || pf.matcherEnabled) {
      throw new TradeBuildRefusal("bad_portfolio", "portfolio is not this owner's taker portfolio on this market", 400);
    }
  }
  const [takerId, lpId, marketId, portInfo] = await Promise.all([
    fetchPortfolioIdentity(connection, accountA),
    fetchPortfolioIdentity(connection, lp.accountB),
    fetchAssetMarketId(connection, slabPk, 0),
    namedInfo !== undefined ? Promise.resolve(namedInfo) : connection.getAccountInfo(accountA, "confirmed"),
  ]);

  let feeBps = await fetchTradeFeeBps(connection, slabPk, lp.matcherCtx, { fallback: cfg.tradeFeeBps, strict: true }).catch(() => {
    throw new TradeBuildRefusal("fee_unreadable", "market fee terms unreadable; nothing built", 503);
  });
  const checkFee = (f: bigint | undefined) => {
    if (req.maxFeeBps !== undefined && f !== undefined && f > req.maxFeeBps) {
      throw new TradeBuildRefusal("fee_above_max", `market needs a ${f} bps fee cap, above maxFeeBps ${req.maxFeeBps}`);
    }
  };
  checkFee(feeBps);
  const levGuard = await levGuardExists(connection, programId, slabPk);

  const tradeParams = {
    levGuard,
    programId,
    signer: owner,
    market: slabPk,
    accountA,
    accountB: lp.accountB,
    matcherProg: lp.matcherProg,
    matcherCtx: lp.matcherCtx,
    matcherDelegate: lp.matcherDelegate,
    takerId,
    lpId,
    marketId,
    legs: [size],
    size,
    limitPriceE6,
    feeBps,
    marketTradeFeeBps: cfg.tradeFeeBps,
  };
  let tradeIxs = buildTradeIxs(tradeParams);

  // ── taker crank (never in an open's tx; bundled into a reduce only when that simulates clean) ──
  let beforeQ: bigint | null = null;
  let hasActiveLegs = false;
  if (portInfo) {
    try {
      const d = new Uint8Array(portInfo.data);
      hasActiveLegs = parsePortfolio(d).legs.some((l) => l.active);
      if (engine?.marketId !== undefined && engine?.marketId !== null) beforeQ = signedPositionForAsset(d, 0, engine.marketId);
    } catch {
      hasActiveLegs = false;
    }
  }
  const reducing = isReducingOrder(beforeQ, size, 1);
  if (req.preflight) {
    try {
      const eff = portInfo ? effectiveTakerPosition(new Uint8Array(portInfo.data), engine) : { q: null, reset: false };
      await req.preflight({
        size,
        limitPriceE6,
        effectivePriceE6: effectiveE6,
        positionBeforeQ: eff.q,
        positionLegReset: eff.reset,
        reducing: isReducingOrder(eff.q, size, 1),
        marketData: raw,
        portfolioData: portInfo ? new Uint8Array(portInfo.data) : null,
        programId,
        market: slabPk,
        lp: { accountB: lp.accountB, matcherCtx: lp.matcherCtx },
      });
    } catch (e) {
      throw new PreflightThrow(e);
    }
  }
  const prefix: TransactionInstruction[] = [];
  const crankTxIxs: TransactionInstruction[] = [];
  let takerCrankIx: TransactionInstruction | null = null;
  if (hasActiveLegs) {
    const keys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [owner, slabPk, accountA]);
    keys.push(...oracleTail);
    const crankIx = buildIx({ programId, keys, data: encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) }) });
    takerCrankIx = crankIx;
    const plan = await planTakerCrank((ixs) => gate(connection, owner, ixs), tradeIxs, crankIx, 2, reducing);
    if (plan === "bundle") prefix.push(crankIx);
    else if (plan === "separate-tx") crankTxIxs.push(crankIx);
  }

  const [{ blockhash, lastValidBlockHeight }, priorityFee] = await Promise.all([connection.getLatestBlockhash("confirmed"), getPriorityFee(connection)]);
  const summary = (): TradeBuildResult["summary"] => ({
    market: slabPk.toBase58(),
    portfolio: accountA.toBase58(),
    lpPortfolio: lp.accountB.toBase58(),
    size: size.toString(),
    limitPriceE6: limitPriceE6.toString(),
    effectivePriceE6: effectiveE6.toString(),
    feeBps: feeBps === undefined ? null : feeBps.toString(),
    lotExp,
    positionBeforeQ: beforeQ === null ? null : beforeQ.toString(),
    reducing,
    repairs,
  });
  const repairs: string[] = [];

  const crankOnly = async (ixs: TransactionInstruction[]): Promise<TradeBuildResult> => {
    // Simulated clean just now; sized like the hook's crank send (cap 200k).
    const g = await gate(connection, owner, ixs);
    if (g.err) throw new TradeBuildRefusal("simulation_failed", new SimulationRefusal(g.err, g.logs, g.simulated).message, 422, g.logs.slice(-12));
    const lim = signedComputeUnitLimit(g.consumed, { cap: 200_000 });
    return {
      transactions: [{ purpose: "crank", transaction: wrap(ixs, lim, priorityFee, owner, blockhash), computeUnitLimit: lim, unitsConsumed: g.consumed }],
      resubmitAfter: true,
      blockhash,
      lastValidBlockHeight,
      summary: summary(),
    };
  };
  if (crankTxIxs.length > 0) return crankOnly(crankTxIxs);

  // ── order body ────────────────────────────────────────────────────────────
  const memo = memoIfFits([...prefix, ...tradeIxs], openFundingMemoIx(await beforeFull), owner);
  const body = (t: TransactionInstruction[]) => [...(memo ? [memo] : []), ...prefix, ...t];
  // Checked BEFORE every simulation: an oversized list is refused by the RPC as a transport error, which would read as
  // "rpc, try again" (review round 2, A). The memo goes first, as in the hook; still too large is a refusal.
  // web3.js serializes a message into a packet-sized buffer, so a list far over the limit throws instead of measuring.
  const fits = (ixs: TransactionInstruction[]): boolean => {
    try {
      return finalTxWireSize(ixs, owner) <= PACKET_DATA_SIZE;
    } catch {
      return false;
    }
  };
  const fit = (ixs: TransactionInstruction[]): TransactionInstruction[] => {
    if (fits(ixs)) return ixs;
    const noMemo = memo ? ixs.filter((ix) => ix !== memo) : ixs;
    if (noMemo.length < ixs.length && fits(noMemo)) return noMemo;
    throw new TradeBuildRefusal("too_large", "the order with its required repairs does not fit one transaction; try again shortly", 503);
  };
  let instructions = fit(body(tradeIxs));

  let sim = await gate(connection, owner, instructions);

  // 98: the cap does not cover the utilisation fee. Rebuild ONCE with the maximum (the hook's U-2), within maxFeeBps.
  if (sim.err && isUtilFeeNotCovered(new SimulationRefusal(sim.err, sim.logs, sim.simulated))) {
    const raised = await fetchTradeFeeBps(connection, slabPk, lp.matcherCtx, { fallback: feeBps, withUtilMax: true });
    if (req.maxFeeBps === undefined) {
      // No consent to a higher cap: say what it would take (review finding 1).
      throw new TradeBuildRefusal("fee_raise_required", `the market now needs a ${raised ?? "higher"} bps fee cap; ask again with maxFeeBps to accept it`, 409);
    }
    checkFee(raised);
    feeBps = raised;
    tradeIxs = buildTradeIxs({ ...tradeParams, feeBps: raised });
    instructions = fit(body(tradeIxs));
    repairs.push(`fee-cap-raised:${raised}`);
    sim = await gate(connection, owner, instructions);
  }

  // 121 (EngineLossStale): the stale positioned peers' refresh cranks in the same tx (the hook's single-asset path).
  if (sim.err && isLossStaleError(new SimulationRefusal(sim.err, sim.logs, sim.simulated), programId.toBase58())) {
    const plan = await planTradeRefresh(connection, {
      programId, market: slabPk, marketData: raw, cranker: owner, takerPortfolio: accountA, lpPortfolio: lp.accountB, body: instructions,
    }, { withPeers: true });
    if (plan.cranks.some((c) => c.role === "peer")) {
      instructions = fit(plan.instructions);
      repairs.push(`peer-refresh:${plan.cranks.filter((c) => c.role === "peer").length}`);
      sim = await gate(connection, owner, instructions);
    }
  }

  // Self-heal (expired backing bucket / reset side / lagging engine clock), as sendTx does for every order.
  if (sim.err && isSelfHealEnabled()) {
    const heal = await planSelfHeal(
      { programId, market: slabPk, instructions, computeUnits: tradeCuCap(1), catchUp: { cranker: owner, portfolio: lp.accountB, oracleTail } },
      connectionSelfHealDeps(connection, slabPk, owner),
    );
    if (heal.outcome === "repaired" && fits(heal.instructions)) {
      instructions = heal.instructions;
      repairs.push(...heal.repairs.map((r) => String((r as { kind?: string }).kind ?? "repair")));
      sim = await gate(connection, owner, instructions);
    }
  }

  // Still 121 with nothing left to refresh: the taker's own crank, alone, when it simulates clean (same answer on both sides).
  if (sim.err && req.crankOnLossStale && takerCrankIx && isLossStaleError(new SimulationRefusal(sim.err, sim.logs, sim.simulated), programId.toBase58())) {
    const alone = await gate(connection, owner, [takerCrankIx]);
    if (!alone.err) {
      const lim = signedComputeUnitLimit(alone.consumed, { cap: 200_000 });
      return {
        transactions: [{ purpose: "crank", transaction: wrap([takerCrankIx], lim, priorityFee, owner, blockhash), computeUnitLimit: lim, unitsConsumed: alone.consumed }],
        resubmitAfter: true,
        blockhash,
        lastValidBlockHeight,
        summary: summary(),
      };
    }
  }

  if (sim.err) {
    // The hook drops its cached trade accounts on any failure (a rotated matcher config); so does the server cache.
    evictLp(programId, slabPk);
    const r = new SimulationRefusal(sim.err, sim.logs, sim.simulated);
    throw new TradeBuildRefusal("simulation_failed", r.message, 422, sim.logs.slice(-12));
  }

  const cap = repairs.some((r) => r.startsWith("peer-refresh")) ? MAX_TX_COMPUTE_UNITS : tradeCuCap(1);
  const limit = signedComputeUnitLimit(sim.consumed, { cap });
  return {
    transactions: [{ purpose: "order", transaction: wrap(instructions, limit, priorityFee, owner, blockhash), computeUnitLimit: limit, unitsConsumed: sim.consumed }],
    resubmitAfter: false,
    blockhash,
    lastValidBlockHeight,
    summary: summary(),
  };
}
