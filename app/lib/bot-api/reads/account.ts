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
import { riskLegFields } from "@/lib/risk-entry";
import { parseAssetAdlFactors, adlSideFactor, adlRemainingBps } from "@/lib/v17-adl";
import { computeMarginCushion, severityFromCushion } from "@/lib/liquidation-risk";
import { decodeMarketEngineView } from "@/lib/limits/decode";

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

  const positions = pf.legs
    .filter((l) => l.active)
    .map((leg) => {
      const side = leg.side === 0 ? "long" : "short";
      if (!detail || !engine) {
        return { asset: leg.assetIndex, side, rawBasisQ: leg.basisPosQ, sizeQ: null, entryPriceE6: null, entrySource: null, entryIsEstimate: null, markPriceE6: null, unrealizedPnl: null, liqPriceE6: null, notional: null, leverage: null, marginCushion: null };
      }
      const aSide = adl ? adlSideFactor(adl, leg.side) : 0n;
      const r = computePositionPnl({
        basisQ: leg.basisPosQ,
        aBasis: leg.aBasis,
        epochSnap: leg.epochSnap,
        adlFactors: adl,
        markE6: mark,
        onChainPnl: pf.pnl,
        initialMarginBps: imBps,
        maintenanceMarginBps: mmBps,
        capital: pf.capital,
        ...riskLegFields(pf.legs),
      });
      // Raw basis is signed only by `side`; the effective (ADL-scaled) size is what exposure, notional and liquidation use.
      const eff = r.effectiveSize;
      const signedEff = eff === null ? null : leg.side === 0 ? abs(eff) : -abs(eff);
      const notional = eff === null ? null : (abs(eff) * mark) / 1_000_000n;
      const leverage = notional !== null && pf.capital > 0n ? Number((notional * 100n) / pf.capital) / 100 : null;
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
        unrealizedPnl: r.riskUnrealizedPnl ?? r.unrealizedPnl,
        liqPriceE6: r.liquidationPriceE6 !== null && r.liquidationPriceE6 > 0n ? r.liquidationPriceE6 : null,
        notional,
        leverage,
        marginCushion: cushion,
        severity: cushion === null ? null : severityFromCushion(cushion),
      };
    });
  const valuePnl = positions.reduce((s, x) => s + (typeof x.unrealizedPnl === "bigint" ? x.unrealizedPnl : 0n), 0n);
  const flat = positions.length === 0;
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
    // Account value at the mark: capital + the position's value-side PnL; a flat account holds its settled pnl.
    equity: flat ? pf.capital + pf.pnl : pf.capital + valuePnl,
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
