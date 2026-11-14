/**
 * A wallet's v2.2 trading accounts, read-only. Mirrors hooks/usePortfolio.ts fetchPortfolioSnapshot (a "use client"
 * module, so not imported): one owner-filtered getProgramAccounts per wrapper program (wrapper magic + owner@116, the
 * filters usePortfolio uses; plus market@16 when ?market= is given), one batched read of the markets they sit on, then the
 * same pure pieces the hook uses (parsePortfolio, ADL factors, computePositionPnl, margin cushion).
 *
 * What differs from the hook, on purpose:
 *  - LP portfolios are listed with `isLp: true` (the hook hides them from a creator's own page; a bot wants to see them).
 *  - No device cache: v2.2 has no lot-aware indexer, so there is no recorded fill price. `entryPriceE6` is back-solved from
 *    the on-chain pnl (`entrySource: "derived"`, `entryIsEstimate: true`) and `unrealizedPnl` is the value-side PnL
 *    (`capital + unrealizedPnl` = account value at the mark). Fills with real entry prices arrive with the indexer.
 *  - `markPriceE6` is the engine's effective price (the price margin and liquidation use).
 *  - NFT-wrapped (escrowed) portfolios are not listed: their owner is the NFT program's escrow, so the owner filter cannot see them.
 */
import { PublicKey } from "@solana/web3.js";
import { ApiError } from "../errors";
import { OWNER_PORTFOLIO_MAGIC, OWNER_PORTFOLIO_MARKET_OFF, OWNER_PORTFOLIO_OWNER_OFF } from "@/lib/owner-portfolio";
import { rpc, wrapperPrograms, type ReadConnection } from "./common";
import { decodeMarketDetail } from "./market";
import { parsePortfolio, isWrapperAccount } from "@/lib/v22/layout";
import { isLpPortfolio } from "@/lib/lpPortfolio";
import { decodePortfolioRisk } from "@/lib/limits/decode";
import { computePositionPnl } from "@/lib/position-pnl";
import { sanitizePriceE6 } from "@/lib/oraclePrice";
import { riskLegFields, parseAssetSettleState } from "@/lib/risk-entry";
import { pendingKfPnl } from "./pending-pnl";
import { parseAssetAdlFactors, adlSideFactor, adlRemainingBps } from "@/lib/v17-adl";
import { computeMarginCushion, severityFromCushion } from "@/lib/liquidation-risk";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { conservativeEquity } from "../builders/equity";

type Scanned = { pubkey: PublicKey; account: { data: Buffer | Uint8Array } };

export interface AccountsRead {
  slot: number;
  portfolios: Scanned[];
  programOf: Map<string, PublicKey>;
  markets: Map<string, { raw: Uint8Array; programId: PublicKey } | null>;
}

/** The raw reads: owner scan(s) + one batched market read. `slot` is the lowest context slot among them. */
export async function loadAccountsRaw(
  connection: ReadConnection,
  meta: { rpcCalls: number },
  wallet: PublicKey,
  marketFilter: PublicKey | null,
): Promise<AccountsRead> {
  const portfolios: Scanned[] = [];
  const programOf = new Map<string, PublicKey>();
  let slot = Number.POSITIVE_INFINITY;
  for (const programId of wrapperPrograms()) {
    const res = await rpc(meta, () =>
      connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        withContext: true,
        filters: [
          { memcmp: { offset: 0, bytes: OWNER_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
          { memcmp: { offset: OWNER_PORTFOLIO_OWNER_OFF, bytes: wallet.toBase58() } },
          ...(marketFilter ? [{ memcmp: { offset: OWNER_PORTFOLIO_MARKET_OFF, bytes: marketFilter.toBase58() } }] : []),
        ],
      }),
    );
    slot = Math.min(slot, res.context.slot);
    for (const r of res.value) {
      portfolios.push(r);
      programOf.set(r.pubkey.toBase58(), programId);
    }
  }
  // Markets the portfolios sit on (market_group_id), one batched read.
  const keys = new Map<string, PublicKey>();
  for (const p of portfolios) {
    try {
      const pf = parsePortfolio(new Uint8Array(p.account.data));
      keys.set(pf.marketGroupId.toBase58(), pf.marketGroupId);
    } catch {
      /* unreadable portfolio: reported below */
    }
  }
  const markets = new Map<string, { raw: Uint8Array; programId: PublicKey } | null>();
  const list = [...keys.values()];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const res = await rpc(meta, () => connection.getMultipleAccountsInfoAndContext(chunk, "confirmed"));
    slot = Math.min(slot, res.context.slot);
    res.value.forEach((info, k) => markets.set(chunk[k].toBase58(), info ? { raw: new Uint8Array(info.data), programId: info.owner } : null));
  }
  if (!Number.isFinite(slot)) slot = await rpc(meta, () => connection.getSlot("confirmed"));
  return { slot, portfolios, programOf, markets };
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

type PortfolioParsed = ReturnType<typeof parsePortfolio>;

/**
 * Liquidation price with the engine's per-leg maintenance floor. The engine requires MM(n) = max(ceil(n x mm_bps / 1e4),
 * min_nonzero_mm_req) (engine v16.rs maintenance_requirement_for_notional), so for a small position the floor, not the
 * percentage, decides when it is liquidated. lib/liquidation-risk.ts computeEngineLiqPrice models the percentage only. MM is the
 * larger of two lines, so a long is liquidated at the HIGHER of the two prices, a short at the LOWER:
 *   floor line, long : equity(P) = capital + q (P - entry) = floor  ->  P = entry + (floor - capital) / q
 *   floor line, short: equity(P) = capital + |q| (entry - P) = floor ->  P = entry + (capital - floor) / |q|
 * (prices E6, q and atoms as the engine has them: notional atoms = |q| x P / 1e6). Rounded toward the mark, like the percentage
 * price. `proportional` is that percentage price (null = unknown, 0n = a long covered at any price). Pure.
 */
export function liqPriceWithMmFloor(proportional: bigint | null, entryE6: bigint, capital: bigint, effectiveQ: bigint, mmFloorAtoms: bigint): bigint | null {
  if (proportional === null || effectiveQ === 0n || entryE6 <= 0n || mmFloorAtoms <= 0n) return proportional;
  const q = abs(effectiveQ);
  const delta = effectiveQ > 0n ? mmFloorAtoms - capital : capital - mmFloorAtoms; // atoms
  // delta x 1e6 / q, rounded away from the entry's far side (up for a long, down for a short): the shown price is never past the engine's
  const num = delta * 1_000_000n;
  const step = effectiveQ > 0n ? (num >= 0n ? (num + q - 1n) / q : -((-num) / q)) : num >= 0n ? num / q : -((-num + q - 1n) / q);
  const floorPrice = entryE6 + step;
  if (floorPrice <= 0n) return proportional;
  if (effectiveQ > 0n) return proportional === 0n ? floorPrice : floorPrice > proportional ? floorPrice : proportional;
  return floorPrice < proportional ? floorPrice : proportional;
}

/** computePositionPnl for one leg, with the inputs both the account view and the order caps use. */
function legPnl(pf: PortfolioParsed, leg: PortfolioParsed["legs"][number], adl: ReturnType<typeof parseAssetAdlFactors> | null, mark: bigint, imBps: bigint, mmBps: bigint, pnl: bigint = pf.pnl) {
  return computePositionPnl({
    basisQ: leg.basisPosQ,
    aBasis: leg.aBasis,
    epochSnap: leg.epochSnap,
    adlFactors: adl,
    markE6: mark,
    onChainPnl: pnl,
    initialMarginBps: imBps,
    maintenanceMarginBps: mmBps,
    capital: pf.capital,
    ...riskLegFields(pf.legs),
  });
}

/**
 * The account's PnL at the engine's effective price, for the order caps (builders/caps.ts) and GET /v1/account:
 * the stored `pnl` PLUS what each open leg has accrued in K and F since its snapshot (pending-pnl.ts, the engine's own
 * settlement arithmetic). `flat` = no open leg (the stored pnl is the figure; 0 is a valid pnl), `open` = pnl + the legs'
 * pending, `unreadable` = a leg whose pending cannot be computed (never guessed).
 */
export function openLegsValuePnl(marketRaw: Uint8Array, portfolioData: Uint8Array): { kind: "flat" } | { kind: "open"; valuePnl: bigint } | { kind: "unreadable" } {
  let pf: PortfolioParsed;
  try {
    pf = parsePortfolio(portfolioData);
  } catch {
    return { kind: "unreadable" };
  }
  const legs = pf.legs.filter((l) => l.active);
  if (legs.length === 0) return { kind: "flat" };
  const pending = accountPendingKf(marketRaw, legs);
  if (pending === null) return { kind: "unreadable" };
  return { kind: "open", valuePnl: pf.pnl + pending.total };
}

/** The pending K/F PnL of each open leg and their sum; null when any leg's cannot be computed. */
export function accountPendingKf(marketRaw: Uint8Array, legs: readonly PortfolioParsed["legs"][number][]): { total: bigint; perLeg: bigint[] } | null {
  let total = 0n;
  const perLeg: bigint[] = [];
  for (const leg of legs) {
    const st = parseAssetSettleState(marketRaw, leg.assetIndex);
    const p = pendingKfPnl(st, riskLegFields([leg]).riskLeg, leg.basisPosQ, leg.aBasis);
    if (p === null) return null;
    perLeg.push(p.net);
    total += p.net;
  }
  return { total, perLeg };
}


/** Pure: one scanned portfolio into the API view. Returns null for an account that is not a portfolio of this wallet. */
export function portfolioView(p: Scanned, wallet: PublicKey, programId: PublicKey, mkt: { raw: Uint8Array; programId: PublicKey } | null | undefined, slot: number) {
  const data = new Uint8Array(p.account.data);
  let pf: ReturnType<typeof parsePortfolio>;
  try {
    pf = parsePortfolio(data);
  } catch {
    return null; // the scan is advisory; an undecodable account is skipped, as the hook does
  }
  if (!pf.owner.equals(wallet)) return null; // re-verify after fetch: memcmp filters are advisory
  const risk = decodePortfolioRisk(data);
  const marketKey = pf.marketGroupId;
  let marketStatus: "ok" | "missing" | "unsupported" | "unreadable" = "ok";
  let detail: ReturnType<typeof decodeMarketDetail> | null = null;
  if (!mkt) marketStatus = "missing";
  else if (!isWrapperAccount(mkt.raw)) marketStatus = "unsupported";
  else {
    try {
      detail = decodeMarketDetail(mkt.raw, { market: marketKey, programId: mkt.programId, slot });
    } catch (e) {
      marketStatus = e instanceof ApiError && e.code === "market_unsupported" ? "unsupported" : "unreadable";
    }
  }
  const engine = mkt && detail ? decodeMarketEngineView(mkt.raw, 0) : null;
  const mark = detail ? detail.effectivePriceE6 : 0n;
  const imBps = engine?.initialMarginBps ?? 0n;
  const mmBps = engine?.maintenanceMarginBps ?? 0n;
  const adl = mkt && detail ? parseAssetAdlFactors(mkt.raw, 0) : null;

  const activeLegs = pf.legs.filter((l) => l.active);
  // What the open legs have accrued in K/F since their snapshots (null = cannot be computed: then the figures below fall back to the stored pnl and say so).
  const pending = mkt && detail && engine ? accountPendingKf(mkt.raw, activeLegs) : null;
  const single = activeLegs.length === 1;
  const rows = activeLegs
    .map((leg, i) => {
      const side = leg.side === 0 ? "long" : "short";
      if (!detail || !engine) {
        return { asset: leg.assetIndex, side, rawBasisQ: leg.basisPosQ, sizeQ: null, entryPriceE6: null, entrySource: null, entryIsEstimate: null, markPriceE6: null, unrealizedPnl: null, liqPriceE6: null, notional: null, marginCushion: null };
      }
      const aSide = adl ? adlSideFactor(adl, leg.side) : 0n;
      // Entry, liquidation price and cushion back-solve from the pnl the position has at the effective price: stored + pending (one leg: `pnl` is that leg's).
      const legPnlAtMark = single && pending ? pf.pnl + pending.total : pf.pnl;
      const r = legPnl(pf, leg, adl, mark, imBps, mmBps, legPnlAtMark);
      // Raw basis is signed only by `side`; the effective (ADL-scaled) size is what exposure, notional and liquidation use.
      const eff = r.effectiveSize;
      const signedEff = eff === null ? null : leg.side === 0 ? abs(eff) : -abs(eff);
      const notional = eff === null ? null : (abs(eff) * mark) / 1_000_000n;
      const cushion =
        signedEff === null
          ? null
          : computeMarginCushion({ positionSize: signedEff, entryPriceE6: r.entry, capital: pf.capital, markPriceE6: mark, maintenanceMarginBps: mmBps, initialMarginBps: imBps });
      return {
        asset: leg.assetIndex,
        side,
        rawBasisQ: leg.basisPosQ,
        sizeQ: signedEff,
        adlRemainingBps: adl ? adlRemainingBps(leg.aBasis, aSide) : null,
        entryPriceE6: r.entry > 0n ? r.entry : null,
        entrySource: r.entrySource,
        entryIsEstimate: r.entrySource !== "server" && r.entrySource !== "cache",
        markPriceE6: mark,
        // The leg's result at the effective price: its pending K/F, plus the stored pnl when it is the only leg (`pnl` is one
        // number per portfolio, so with several legs it cannot be split; the account's `valuePnl` is exact either way).
        unrealizedPnl: pending ? pending.perLeg[i] + (single ? pf.pnl : 0n) : null,
        liqPriceE6: ((): bigint | null => {
          const v = liqPriceWithMmFloor(r.liquidationPriceE6, r.riskEntry, pf.capital, signedEff ?? 0n, detail.risk.minNonzeroMaintenanceMarginReq ?? 0n);
          return v !== null && v > 0n ? v : null;
        })(),
        notional,
        marginCushion: cushion,
        severity: cushion === null ? null : severityFromCushion(cushion),
      };
    });
  // Stored pnl + every open leg's pending K/F: the account's PnL at the effective price (a flat account holds its stored pnl).
  const valuePnl = pf.pnl + (pending ? pending.total : 0n);
  // The equity the order caps divide by (builders/equity.ts): capital less unrealized losses and negative fee credits.
  const leverageEquity = conservativeEquity(pf.capital, valuePnl, pf.feeCredits);
  const positions = rows.map((x) => ({
    ...x,
    leverage: typeof x.notional === "bigint" && leverageEquity > 0n ? Number((x.notional * 10_000n) / leverageEquity) / 10_000 : null,
  }));
  return {
    address: p.pubkey.toBase58(),
    market: marketKey.toBase58(),
    programId: programId.toBase58(),
    marketStatus,
    symbol: detail?.symbol ?? null,
    isLp: isLpPortfolio(data),
    capital: pf.capital,
    pnl: pf.pnl,
    feeCredits: pf.feeCredits,
    leverageEquity,
    // K/F PnL accrued on the open legs since their snapshots and not yet settled into `pnl`; null = could not be computed.
    pendingPnl: rows.length === 0 ? 0n : pending ? pending.total : null,
    // Stored pnl + pendingPnl: the PnL at the engine's effective price.
    valuePnl,
    // Account value at the effective price: capital + valuePnl.
    equity: pf.capital + valuePnl,
    certifiedEquity: risk ? risk.cert.certifiedEquity : null,
    margin: { initialMarginBps: engine ? imBps : null, maintenanceMarginBps: engine ? mmBps : null, maxLeverage: detail?.maxLeverage ?? null },
    positions,
  };
}

export async function accountView(connection: ReadConnection, meta: { rpcCalls: number }, wallet: PublicKey, marketFilter: PublicKey | null) {
  const raw = await loadAccountsRaw(connection, meta, wallet, marketFilter);
  const portfolios = raw.portfolios
    .map((p) => {
      const programId = raw.programOf.get(p.pubkey.toBase58())!;
      let mk: { raw: Uint8Array; programId: PublicKey } | null | undefined;
      try {
        mk = raw.markets.get(parsePortfolio(new Uint8Array(p.account.data)).marketGroupId.toBase58());
      } catch {
        mk = undefined;
      }
      return portfolioView(p, wallet, programId, mk, raw.slot);
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.address.localeCompare(b.address));
  return { slot: raw.slot, wallet: wallet.toBase58(), portfolios };
}
