/**
 * The market's LP (the AMM counterparty, TradeCpi accountB), chosen by ON-CHAIN IDENTITY.
 *
 * WHY: the trade, close, first-trade, fill-cap and LP-capital paths used to take "the first
 * portfolio on the market with an enabled matcher config". The wrapper lets ANY portfolio
 * owner enable a matcher on their own portfolio (bd4fe5f8 handle_set_matcher_config checks
 * only owner == signer), and assertCanonicalMatcher pins only the matcher PROGRAM, not the
 * ctx or the LP. So any stranger's portfolio with an enabled matcher (including our own test
 * wallets) could become accountB for every user's trade: LpFloorHalt, a zero fill, or a
 * foreign ctx, i.e. trading blocked for everyone, and the LP-capital stat attacker-chosen.
 *
 * A candidate qualifies only if ALL hold:
 *  1. it is a real portfolio account of THIS market (kind byte + size, provenance
 *     market_group_id == market, provenance portfolio_account_id == its own address);
 *  2. its PortfolioMatcherConfig is enabled;
 *  3. its matcher ctx is BOUND to it: the ctx account is owned by the configured matcher
 *     program and ctx.lp_pda (vAMM ctx offset 16, absolute 80) == the config's
 *     matcher_delegate == deriveMatcherDelegate(program, market, portfolio, owner, prog, ctx);
 *  4. it is the market's LP by identity, in this order:
 *     a. P3: asset 0 has a bound vault LP -> exactly that portfolio (nothing else);
 *     b. its (immutable provenance) owner == asset 0's asset_admin, the creator key recorded
 *        on the market;
 *     c. asset_admin renounced (zero) or no admin-owned candidate -> the market's LAUNCH
 *        portfolio, i.e. the lowest portfolio_id on the market (the wizard creates the LP
 *        first; ids are program-assigned and monotonic, so nobody can obtain a lower one
 *        later).
 * Several qualifying under (b): the lowest portfolio_id wins (deterministic), and it is logged.
 */
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import {
  V17_PORTFOLIO_IDENTITY_TRAILER_LEN,
  decodePortfolioMatcherControl,
  deriveMatcherDelegate,
} from "@percolatorct/sdk";
import { isPortfolioAccount } from "@/lib/portfolio-account";
import { readAssetAdmin } from "@/lib/v18-wire";
import { getMultipleAccountsInfoChunked } from "@/lib/rpc-chunk";
import { parsePortfolio } from "@/lib/v22/layout";
import { decodeAssetVaultLpP3 } from "@/lib/v22/records";

/** v17 portfolio account magic (first 8 bytes): PERCV16\0 */
const V17_PORTFOLIO_MAGIC = new Uint8Array([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
/** Provenance header: HEADER_LEN(16) + market_group_id(0) / portfolio_account_id(32) / owner(64). */
export const PORTFOLIO_MARKET_GROUP_OFF = 16;
const PORTFOLIO_ACCOUNT_ID_OFF = 48;
const PORTFOLIO_PROVENANCE_OWNER_OFF = 80;
/** sizeof(PortfolioMatcherConfigV16): program[32] | context[32] | delegate[32] | control u64. */
const MATCHER_CONFIG_LEN = 104;
/** Matcher ctx: 64-byte return slot, then the vAMM ctx whose lp_pda sits at +16. */
const CTX_LP_PDA_OFF = 64 + 16;

export type MarketLpReason = "vault-lp" | "asset-admin" | "launch-portfolio";

export interface MarketLp {
  pubkey: PublicKey;
  data: Uint8Array;
  /** Immutable provenance owner (the key SetMatcherConfig authenticated and the delegate binds). */
  owner: PublicKey;
  portfolioId: bigint;
  matcherProg: PublicKey;
  matcherCtx: PublicKey;
  matcherDelegate: PublicKey;
  reason: MarketLpReason;
}

export interface PortfolioRow {
  pubkey: PublicKey;
  data: Uint8Array;
}

export interface CtxRow {
  owner: PublicKey;
  data: Uint8Array;
}

export interface MatcherConfig {
  matcherProg: PublicKey;
  matcherCtx: PublicKey;
  matcherDelegate: PublicKey;
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The enabled PortfolioMatcherConfig, or null (disabled / not a portfolio). DataView only: browser-safe. */
export function readEnabledMatcherConfig(data: Uint8Array): MatcherConfig | null {
  if (!isPortfolioAccount(data)) return null;
  const off = data.length - MATCHER_CONFIG_LEN - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
  if (off < 0) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (!decodePortfolioMatcherControl(dv.getBigUint64(off + 96, true)).enabled) return null;
  return {
    matcherProg: new PublicKey(data.subarray(off, off + 32)),
    matcherCtx: new PublicKey(data.subarray(off + 32, off + 64)),
    matcherDelegate: new PublicKey(data.subarray(off + 64, off + 96)),
  };
}

interface Parsed {
  row: PortfolioRow;
  owner: PublicKey;
  portfolioId: bigint;
  cfg: MatcherConfig | null;
}

/** A real portfolio of THIS market (rule 1), or null. */
function parseRow(row: PortfolioRow, market: PublicKey): Parsed | null {
  const d = row.data;
  if (!isPortfolioAccount(d)) return null;
  if (!bytesEq(d.subarray(PORTFOLIO_MARKET_GROUP_OFF, PORTFOLIO_MARKET_GROUP_OFF + 32), market.toBytes())) return null;
  if (!bytesEq(d.subarray(PORTFOLIO_ACCOUNT_ID_OFF, PORTFOLIO_ACCOUNT_ID_OFF + 32), row.pubkey.toBytes())) return null;
  let portfolioId: bigint;
  try {
    portfolioId = parsePortfolio(d).portfolioId;
  } catch {
    return null;
  }
  return {
    row,
    owner: new PublicKey(d.subarray(PORTFOLIO_PROVENANCE_OWNER_OFF, PORTFOLIO_PROVENANCE_OWNER_OFF + 32)),
    portfolioId,
    cfg: readEnabledMatcherConfig(d),
  };
}

/** Rule 3: the ctx is bound to this exact (market, portfolio, owner, program, ctx). */
function isCtxBound(programId: PublicKey, market: PublicKey, p: Parsed, ctx: CtxRow | null | undefined): boolean {
  if (!p.cfg || !ctx) return false;
  if (!ctx.owner.equals(p.cfg.matcherProg)) return false;
  if (ctx.data.length < CTX_LP_PDA_OFF + 32) return false;
  const [derived] = deriveMatcherDelegate(programId, market, p.row.pubkey, p.owner, p.cfg.matcherProg, p.cfg.matcherCtx);
  if (!p.cfg.matcherDelegate.equals(derived)) return false;
  return bytesEq(ctx.data.subarray(CTX_LP_PDA_OFF, CTX_LP_PDA_OFF + 32), derived.toBytes());
}

/** The bound P3 vault LP of asset 0, or null (no P3 state / unbound / undecodable). */
function boundVaultLp(marketData: Uint8Array): PublicKey | null {
  try {
    const r = decodeAssetVaultLpP3(marketData, 0);
    return r.bound && r.vaultLpPortfolio ? r.vaultLpPortfolio : null;
  } catch {
    return null;
  }
}

function assetAdmin(marketData: Uint8Array): PublicKey | null {
  try {
    const a = readAssetAdmin(marketData, 0);
    return a.equals(PublicKey.default) ? null : a;
  } catch {
    return null;
  }
}

function byId(a: Parsed, b: Parsed): number {
  return a.portfolioId < b.portfolioId ? -1 : a.portfolioId > b.portfolioId ? 1 : a.row.pubkey.toBase58().localeCompare(b.row.pubkey.toBase58());
}

function toLp(p: Parsed, reason: MarketLpReason): MarketLp {
  const cfg = p.cfg!;
  return { pubkey: p.row.pubkey, data: p.row.data, owner: p.owner, portfolioId: p.portfolioId, ...cfg, reason };
}

/** The matcher ctx addresses worth fetching for `rows` (enabled configs only, deduped). */
export function ctxAddressesToFetch(rows: PortfolioRow[]): PublicKey[] {
  const seen = new Map<string, PublicKey>();
  for (const r of rows) {
    const cfg = readEnabledMatcherConfig(r.data);
    if (cfg) seen.set(cfg.matcherCtx.toBase58(), cfg.matcherCtx);
  }
  return [...seen.values()];
}

/**
 * Pure selection (see the module comment). `portfolios` should be EVERY portfolio of the
 * market for rule 4c to be sound; with a partial list, 4c is skipped. `ctxs` maps a ctx
 * address (base58) to its account.
 */
export function selectMarketLp(args: {
  programId: PublicKey;
  market: PublicKey;
  marketData: Uint8Array;
  portfolios: PortfolioRow[];
  ctxs: Map<string, CtxRow | null>;
  /** True when `portfolios` is the market's full scan (enables rule 4c). */
  complete: boolean;
}): MarketLp | null {
  const { programId, market, marketData } = args;
  const parsed = args.portfolios.map((r) => parseRow(r, market)).filter((p): p is Parsed => p !== null);
  const eligible = parsed
    .filter((p) => p.cfg && isCtxBound(programId, market, p, args.ctxs.get(p.cfg.matcherCtx.toBase58())))
    .sort(byId);

  const vault = boundVaultLp(marketData);
  if (vault) {
    const v = eligible.find((p) => p.row.pubkey.equals(vault));
    return v ? toLp(v, "vault-lp") : null;
  }

  const admin = assetAdmin(marketData);
  if (admin) {
    const owned = eligible.filter((p) => p.owner.equals(admin));
    if (owned.length > 1) {
      console.warn(
        `[market-lp] ${owned.length} admin-owned LP candidates on ${market.toBase58()}; using lowest portfolio_id ${owned[0].portfolioId} (${owned[0].row.pubkey.toBase58()})`,
      );
    }
    if (owned.length > 0) return toLp(owned[0], "asset-admin");
  }

  if (!args.complete || parsed.length === 0) return null;
  const launch = [...parsed].sort(byId)[0];
  if (eligible.some((p) => p.row.pubkey.equals(launch.row.pubkey))) {
    console.warn(
      `[market-lp] ${market.toBase58()}: ${admin ? "no admin-owned LP" : "asset_admin renounced"}; using the launch portfolio ${launch.row.pubkey.toBase58()} (id ${launch.portfolioId})`,
    );
    return toLp(launch, "launch-portfolio");
  }
  return null;
}

/** getProgramAccounts filters for every portfolio of one market. */
export function marketPortfolioFilters(market: PublicKey) {
  return [
    { memcmp: { offset: 0, bytes: Buffer.from(V17_PORTFOLIO_MAGIC).toString("base64"), encoding: "base64" as const } },
    { memcmp: { offset: PORTFOLIO_MARKET_GROUP_OFF, bytes: market.toBase58() } },
  ];
}

async function fetchCtxs(connection: Connection, rows: PortfolioRow[]): Promise<Map<string, CtxRow | null>> {
  const addrs = ctxAddressesToFetch(rows);
  const out = new Map<string, CtxRow | null>();
  if (addrs.length === 0) return out;
  const infos = await getMultipleAccountsInfoChunked(connection, addrs);
  addrs.forEach((a, i) => {
    const info = infos[i] as AccountInfo<Buffer> | null | undefined;
    out.set(a.toBase58(), info ? { owner: info.owner, data: new Uint8Array(info.data) } : null);
  });
  return out;
}

/**
 * Resolve the market's LP on-chain. `knownLp` (a curated address) is tried first with a
 * cheap fetch; it must still pass every rule. Falls back to the full market scan.
 * Throws only on RPC failure of the scan; null = no qualifying LP.
 */
export async function resolveMarketLp(
  connection: Connection,
  programId: PublicKey,
  market: PublicKey,
  knownLp?: PublicKey | null,
): Promise<MarketLp | null> {
  const marketInfo = await connection.getAccountInfo(market, "confirmed");
  if (!marketInfo) return null;
  const marketData = new Uint8Array(marketInfo.data);

  if (knownLp) {
    try {
      const info = await connection.getAccountInfo(knownLp, "confirmed");
      if (info && info.owner.equals(programId)) {
        const rows = [{ pubkey: knownLp, data: new Uint8Array(info.data) }];
        const lp = selectMarketLp({ programId, market, marketData, portfolios: rows, ctxs: await fetchCtxs(connection, rows), complete: false });
        if (lp) return lp;
      }
    } catch {
      /* fall through to the scan */
    }
  }

  const accounts = await connection.getProgramAccounts(programId, { filters: marketPortfolioFilters(market) });
  const rows = accounts.map(({ pubkey, account }) => ({ pubkey, data: new Uint8Array(account.data) }));
  const ctxs = await fetchCtxs(connection, rows);
  return selectMarketLp({ programId, market, marketData, portfolios: rows, ctxs, complete: true });
}

/** Batch form for the all-markets server scan: rows grouped by market, markets fetched once. */
export async function selectMarketLpsFromScan(
  connection: Connection,
  programId: PublicKey,
  rows: PortfolioRow[],
): Promise<Map<string, MarketLp>> {
  const byMarket = new Map<string, PortfolioRow[]>();
  for (const r of rows) {
    if (!isPortfolioAccount(r.data)) continue;
    const m = new PublicKey(r.data.subarray(PORTFOLIO_MARKET_GROUP_OFF, PORTFOLIO_MARKET_GROUP_OFF + 32)).toBase58();
    const list = byMarket.get(m);
    if (list) list.push(r);
    else byMarket.set(m, [r]);
  }
  // Only markets that have at least one enabled matcher can have an LP.
  const markets = [...byMarket.entries()].filter(([, list]) => list.some((r) => readEnabledMatcherConfig(r.data)));
  const out = new Map<string, MarketLp>();
  if (markets.length === 0) return out;
  const marketPks = markets.map(([m]) => new PublicKey(m));
  const [marketInfos, ctxs] = await Promise.all([
    getMultipleAccountsInfoChunked(connection, marketPks),
    fetchCtxs(connection, markets.flatMap(([, list]) => list)),
  ]);
  markets.forEach(([m, list], i) => {
    const info = marketInfos[i];
    if (!info || !info.owner.equals(programId)) return;
    const lp = selectMarketLp({
      programId, market: marketPks[i], marketData: new Uint8Array(info.data), portfolios: list, ctxs, complete: true,
    });
    if (lp) out.set(m, lp);
  });
  return out;
}
