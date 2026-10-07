/**
 * Cross-device recovery of a launch's registration (#3267).
 *
 * WHAT IS ON CHAIN, AND WHAT THAT PROVES
 *
 * A keeper-priced launch signs, inside its InitMarket transaction, an SPL Memo
 * `percolator:keeper-register:v2:<sha256(canonical params)>` (lib/keeper-register-memo.ts). The
 * digest binds the token identity (mainnet CA, symbol, name), the pool and dex type, and the
 * markets-row payload (price, margin, fee, LP seed, oracle authority, ...). So the creation
 * transaction is a signed commitment to what the launch registers, and it is public forever.
 *
 * What the original browser kept in localStorage (the proof tx signature, the registration payload
 * and request) is therefore recoverable from chain plus ONE thing the chain does not carry in the
 * clear: which token the market prices. The creator supplies that token's mainnet address; the app
 * derives pool, symbol and name exactly as the wizard does, rebuilds the payload with the SAME
 * builder (lib/market-registration-payload.ts), and accepts the result only if the memo it
 * recomputes equals the memo on chain. A wrong token, a wrong pool or a payload that differs in any
 * bound field cannot verify, so a guess cannot register anything.
 *
 * Nothing here weakens the server: POST /api/playground/keeper-register re-verifies the memo from
 * the landed transaction regardless. This module only avoids sending a request that cannot verify,
 * and refuses markets whose creator is not the connected wallet.
 */
import { PublicKey, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { IX_TAG } from "@percolatorct/sdk";
import { bpsPct } from "@/lib/format";
import {
  INIT_MARKET_TAG,
  KEEPER_REGISTER_MEMO_FAMILY,
  MEMO_PROGRAM_ID,
  keeperMemoParams,
  keeperRegisterMemoText,
  verifyKeeperRegisterProofTx,
} from "@/lib/keeper-register-memo";
import type { KeeperRegisterRequest } from "@/lib/keeper-register-client";
import { saveProofPayload, saveProofTx, saveRegisterRequest, type KeyStore } from "@/lib/keeper-register-client";
import { buildMarketRegistrationPayload, flooredInitialMarginBps } from "@/lib/market-registration-payload";
import { resolveMarketMetadata } from "@/lib/market-metadata";
import { backingSeedPerDomain, leverageFromMarginBps } from "@/lib/market-params";
import type { DexPoolResult } from "@/hooks/useDexPoolSearch";
import type { TokenMeta } from "@/lib/tokenMeta";

// ── The creation transaction, read from chain ────────────────────────────────────────────────────

export const INIT_MARKET_DATA_LEN = 219;
/** Wrapper DepositJuniorTranche (lib/limits/constants.ts P3_TAG). */
const DEPOSIT_JUNIOR_TRANCHE_TAG = 96;

/** The InitMarket arguments the launch's payload and resume depend on (layout: SDK encodeInitMarket). */
export interface InitMarketFacts {
  maxPortfolioAssets: number;
  initialPriceE6: bigint;
  initialMarginBps: bigint;
  maxTradingFeeBps: bigint;
  tradeFeeBaseBps: bigint;
}

const u64At = (d: Uint8Array, off: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);

/**
 * tag(1) maxPortfolioAssets(u16) hMin(u64) hMax(u64) initialPrice(u64) minNonzeroMmReq(u128)
 * minNonzeroImReq(u128) maintenanceMarginBps(u64) initialMarginBps(u64) maxTradingFeeBps(u64)
 * tradeFeeBaseBps(u64) ...
 */
export function decodeInitMarketData(data: Uint8Array): InitMarketFacts | null {
  if (data.length !== INIT_MARKET_DATA_LEN || data[0] !== INIT_MARKET_TAG) return null;
  return {
    maxPortfolioAssets: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(1, true),
    initialPriceE6: u64At(data, 19),
    initialMarginBps: u64At(data, 67),
    maxTradingFeeBps: u64At(data, 75),
    tradeFeeBaseBps: u64At(data, 83),
  };
}

export interface CreationFacts {
  slab: string;
  proofTx: string;
  tx: VersionedTransactionResponse;
  /** The InitMarket admin (a signer): the market's creator. */
  creator: string;
  /** The registration memo text on chain. */
  memo: string;
  init: InitMarketFacts;
  collateralMint: string;
  /** Amounts of the wrapper DepositCollateral / DepositJuniorTranche instructions in the launch's first transactions (LP-seed candidates; the memo picks). */
  depositAmounts: bigint[];
}

export type CreationRead =
  | { ok: true; facts: CreationFacts }
  | { ok: false; reason: "rpc" | "no-creation-tx" | "no-memo" | "several-memos" };

/** How far back to look for the creation tx, and how many launch txs to read for the LP deposit. */
const SIG_PAGE = 1000;
const MAX_SIG_PAGES = 5;
const LAUNCH_TX_WINDOW = 12;

type TxConn = Pick<Connection, "getSignaturesForAddress" | "getTransaction">;

/**
 * The market's creation transaction and what it carries. The oldest signatures of the slab are the
 * launch itself (InitMarket creates the account), so only those are read.
 */
export async function readCreationFromChain(connection: TxConn, slab: string, wrapperProgramId: string): Promise<CreationRead> {
  try {
    const slabPk = new PublicKey(slab);
    let before: string | undefined;
    let oldestPage: { signature: string; err: unknown }[] = [];
    for (let page = 0; page < MAX_SIG_PAGES; page++) {
      const sigs = await connection.getSignaturesForAddress(slabPk, { limit: SIG_PAGE, before }, "confirmed");
      if (sigs.length === 0) break;
      oldestPage = sigs;
      if (sigs.length < SIG_PAGE) break;
      before = sigs[sigs.length - 1]?.signature;
      if (page === MAX_SIG_PAGES - 1) return { ok: false, reason: "no-creation-tx" }; // history too long to reach the start
    }
    // Newest-first within the page: the launch is the tail.
    const launch = oldestPage.filter((s) => s.err === null).slice(-LAUNCH_TX_WINDOW).reverse();
    if (launch.length === 0) return { ok: false, reason: "no-creation-tx" };
    const txs: { sig: string; tx: VersionedTransactionResponse | null }[] = [];
    for (const s of launch) {
      const tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      // A signature the RPC listed but cannot return is a read problem, not proof that the launch
      // carries no registration: report it as one rather than as "no memo".
      if (!tx) return { ok: false, reason: "rpc" };
      txs.push({ sig: s.signature, tx });
    }

    let found: Omit<CreationFacts, "depositAmounts" | "slab"> | null = null;
    let memos = 0;
    const depositAmounts: bigint[] = [];
    for (const { sig, tx } of txs) {
      if (!tx?.meta || tx.meta.err !== null) continue;
      const msg = tx.transaction.message;
      const keys = msg.staticAccountKeys.map((k) => k.toBase58());
      let init: InitMarketFacts | null = null;
      let admin: string | null = null;
      let mint: string | null = null;
      let memo: string | null = null;
      let txMemos = 0;
      for (const ix of msg.compiledInstructions) {
        const prog = keys[ix.programIdIndex];
        if (prog === MEMO_PROGRAM_ID.toBase58()) {
          const text = Buffer.from(ix.data).toString("utf8");
          if (text.startsWith(KEEPER_REGISTER_MEMO_FAMILY)) {
            txMemos++;
            memo = text;
          }
        } else if (prog === wrapperProgramId) {
          const data = Uint8Array.from(ix.data);
          const accts = ix.accountKeyIndexes.map((i) => keys[i]);
          if (data[0] === INIT_MARKET_TAG && accts[1] === slab) {
            init = decodeInitMarketData(data);
            admin = accts[0] ?? null;
            mint = accts[2] ?? null;
          } else if (data[0] === DEPOSIT_JUNIOR_TRANCHE_TAG && data.length === 17 && accts.includes(slab)) {
            // A vault-owned-LP (P3) launch seeds liquidity as the creator's junior tranche (tag 96, u128 amount)
            // instead of a DepositCollateral: that amount IS the LP seed the memo binds (juniorAtoms = lpCollateral).
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            depositAmounts.push(view.getBigUint64(1, true) | (view.getBigUint64(9, true) << 64n));
          } else if (data[0] === IX_TAG.DepositCollateral && data.length === 33 && accts.includes(slab)) {
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            depositAmounts.push(view.getBigUint64(17, true) | (view.getBigUint64(25, true) << 64n));
          }
        }
      }
      if (init && admin && mint) {
        memos = txMemos;
        if (memo && txMemos === 1) found = { proofTx: sig, tx, creator: admin, memo, init, collateralMint: mint };
      }
    }
    if (!found) return { ok: false, reason: memos > 1 ? "several-memos" : memos === 0 ? "no-memo" : "no-creation-tx" };
    return { ok: true, facts: { slab, ...found, depositAmounts: [...new Set(depositAmounts)] } };
  } catch {
    return { ok: false, reason: "rpc" };
  }
}

// ── Rebuilding the registration, proven against the memo ─────────────────────────────────────────

export type RecoveryReason =
  | "rpc"
  | "no-creation-tx"
  | "no-memo"
  | "several-memos"
  | "not-your-market"
  | "bad-address"
  | "no-pools"
  | "pools-unavailable"
  | "no-deposit"
  | "no-match";

/** What to tell the creator. Calm, and honest about what is and is not known. */
export const RECOVERY_COPY: Record<RecoveryReason, string> = {
  rpc: "Couldn't read this market's launch from the chain just now. Try again in a moment.",
  "no-creation-tx": "Couldn't find this market's creation transaction on chain, so its live price can't be connected from here.",
  "no-memo": "This market's creation transaction carries no price-feed registration, so there is nothing to connect from here.",
  "several-memos": "This market's creation transaction carries more than one registration, so it can't be connected from here.",
  "not-your-market": "This market wasn't created by the connected wallet.",
  "bad-address": "That isn't a valid token address.",
  "no-pools": "That token has no pool the live price can read.",
  "pools-unavailable": "Couldn't look up that token's pools right now. Try again in a moment.",
  "no-deposit": "Nothing was deposited when this launch stopped, so enter the liquidity amount you chose and it will be checked against the launch.",
  "no-match": "That token address doesn't match what this market was launched with.",
};

export interface RecoveredLaunch {
  /** The exact registration request, verified against the on-chain memo (what the route will re-verify). */
  request: KeeperRegisterRequest;
  creator: string;
  symbol: string;
  name: string;
  poolAddress: string;
  dexType: string;
  /** The LP seed the memo binds, atoms. */
  lpCollateralAtoms: bigint;
  initialMarginBps: number;
  tradingFeeBps: number;
  initialPriceE6: bigint;
  /** InitMarket's maxPortfolioAssets: 1 marks a vault-owned-LP (P3) market. */
  maxPortfolioAssets: number;
  /** The slab's own insurance balance when this launch was read (atoms), if known: pinned for a resume. */
  onChainInsuranceAtoms?: bigint | null;
  /**
   * The LP-exposure setting (bps of the seed) the matcher limits will be written with, when the liquidity
   * step has not run yet. It is NOT bound by the memo and not readable from chain before the matcher
   * exists, so the creator confirms it; once the matcher exists (step 3) it is already written and this
   * stays undefined.
   */
  lpExposureBps?: number;
}

export interface ReconstructInput {
  facts: CreationFacts;
  mainnetCA: string;
  pools: readonly DexPoolResult[];
  tokenMeta: Pick<TokenMeta, "symbol" | "name"> | null;
  /** The program the launch ran on (the route's wrapper). */
  wrapperProgramId: string;
  /** Config the payload builder reads (devnet crank wallet rule). */
  crankWallet?: string;
  isDevnetEnv: boolean;
  /** Extra LP seeds to try (atoms), beyond the deposits found on chain. */
  extraLpCandidates?: readonly bigint[];
}

function uniqueNumbers(xs: number[]): number[] {
  return [...new Set(xs.filter((n) => Number.isFinite(n) && n > 0))];
}

/**
 * Try every (pool x metadata derivation x LP seed x leverage) the launch could have used and keep the
 * one whose recomputed memo equals the on-chain memo AND passes the same proof check the route runs.
 * Returns null when none does.
 */
export async function reconstructRegistration(i: ReconstructInput): Promise<RecoveredLaunch | null> {
  const { facts } = i;
  const lpCandidates = [...new Set([...facts.depositAmounts, ...(i.extraLpCandidates ?? [])])];
  const imBps = Number(facts.init.initialMarginBps);
  const leverages = uniqueNumbers([
    leverageFromMarginBps(imBps),
    leverageFromMarginBps(flooredInitialMarginBps(imBps)),
  ]);
  const fee = Number(facts.init.tradeFeeBaseBps);
  const mint = new PublicKey(facts.collateralMint);
  // Both derivations the wizard uses for (symbol, name): the token's metadata (keeper markets), and
  // the pool's base/quote pair (hyperp markets).
  const metaFor = (pool: DexPoolResult) => {
    const a = resolveMarketMetadata({ symbol: i.tokenMeta?.symbol, name: i.tokenMeta?.name, mint: i.mainnetCA });
    const b = resolveMarketMetadata({ symbol: pool.baseSymbol, name: `${pool.baseSymbol}/${pool.quoteSymbol} Perpetual`, mint: i.mainnetCA });
    return a.symbol === b.symbol && a.name === b.name ? [a] : [a, b];
  };

  for (const pool of i.pools) {
    if (!pool.dexType) continue;
    for (const md of metaFor(pool)) {
      for (const lp of lpCandidates) {
        for (const lev of leverages) {
          // The wizard's own builder, fed the launch's parameters. initialMarginBps goes in as the
          // on-chain value; the builder floors it through the same derivation the launch used.
          const imForPayload = imBps;
          const payload = buildMarketRegistrationPayload({
            slabAddress: facts.slab,
            params: {
              mint,
              symbol: md.symbol,
              name: md.name,
              decimals: 6,
              dexPoolAddress: pool.poolAddress,
              initialPriceE6: facts.init.initialPriceE6,
              initialMarginBps: imForPayload,
              tradingFeeBps: fee,
              lpCollateral: lp,
              mainnetCA: i.mainnetCA,
            },
            deployer: facts.creator,
            oracleMode: "keeper",
            isAdminOracle: false,
            isDevnetEnv: i.isDevnetEnv,
            crankWallet: i.crankWallet,
          });
          // max_leverage is the one derived field with more than one reading; pin each candidate.
          const withLev = { ...payload, max_leverage: lev };
          const request: Omit<KeeperRegisterRequest, "proofTx"> = {
            slabAddress: facts.slab,
            mainnetCA: i.mainnetCA,
            dexPoolAddress: pool.poolAddress,
            dexType: pool.dexType,
            symbol: md.symbol,
            payload: withLev,
          };
          const params = await keeperMemoParams({ ...request, payload: withLev });
          if ((await keeperRegisterMemoText(params)) !== facts.memo) continue;
          // The exact proof check the route runs, against the landed transaction.
          const verdict = await verifyKeeperRegisterProofTx(facts.tx, params, i.wrapperProgramId);
          if (!verdict.ok) continue;
          return {
            request: { ...request, proofTx: facts.proofTx },
            creator: verdict.creator,
            symbol: md.symbol,
            name: md.name,
            poolAddress: pool.poolAddress,
            dexType: pool.dexType,
            lpCollateralAtoms: lp,
            initialMarginBps: imBps,
            tradingFeeBps: fee,
            initialPriceE6: facts.init.initialPriceE6,
            maxPortfolioAssets: facts.init.maxPortfolioAssets,
          };
        }
      }
    }
  }
  return null;
}

export interface RecoveryDeps {
  connection: TxConn;
  wrapperProgramId: string;
  crankWallet?: string;
  isDevnetEnv: boolean;
  searchPools: (mint: string) => Promise<{ pools: DexPoolResult[] }>;
  fetchMeta: (mint: PublicKey) => Promise<Pick<TokenMeta, "symbol" | "name">>;
}

export type RecoveryResult = { ok: true; launch: RecoveredLaunch } | { ok: false; reason: RecoveryReason };

/**
 * The whole path: read the creation tx, refuse unless the connected wallet created it, derive the
 * token's pool / symbol / name from the address the creator typed, and prove the result against the
 * on-chain memo.
 */
export async function recoverLaunchFromChain(
  deps: RecoveryDeps,
  input: { slab: string; wallet: string; mainnetCA: string; /** LP seeds (atoms) the creator says they chose; the memo proves or rejects them. */ lpCandidates?: readonly bigint[] },
): Promise<RecoveryResult> {
  let caPk: PublicKey;
  try {
    caPk = new PublicKey(input.mainnetCA.trim());
  } catch {
    return { ok: false, reason: "bad-address" };
  }
  const read = await readCreationFromChain(deps.connection, input.slab, deps.wrapperProgramId);
  if (!read.ok) return { ok: false, reason: read.reason };
  // The memo is signed by the creator and is public, so anyone could replay it; the creator
  // check is what keeps this flow to the creator's own wallet.
  if (read.facts.creator !== input.wallet) return { ok: false, reason: "not-your-market" };
  if (read.facts.depositAmounts.length === 0 && !(input.lpCandidates?.length)) return { ok: false, reason: "no-deposit" };

  let pools: DexPoolResult[];
  try {
    pools = (await deps.searchPools(caPk.toBase58())).pools;
  } catch {
    return { ok: false, reason: "pools-unavailable" };
  }
  if (pools.length === 0) return { ok: false, reason: "no-pools" };
  let meta: Pick<TokenMeta, "symbol" | "name"> | null = null;
  try {
    meta = await deps.fetchMeta(caPk);
  } catch {
    meta = null;
  }
  const launch = await reconstructRegistration({
    facts: read.facts,
    mainnetCA: caPk.toBase58(),
    pools,
    tokenMeta: meta,
    wrapperProgramId: deps.wrapperProgramId,
    crankWallet: deps.crankWallet,
    isDevnetEnv: deps.isDevnetEnv,
    extraLpCandidates: input.lpCandidates,
  });
  if (!launch) return { ok: false, reason: "no-match" };
  if (launch.creator !== input.wallet) return { ok: false, reason: "not-your-market" };
  return { ok: true, launch };
}

/**
 * Save what this browser would have saved at launch time, so everything that already reads it (the
 * attention strip's saved retry, the resume's keeper loop, retryKeeperRegistration's payload recall)
 * works on this device too. Only ever called with a launch that verified against the on-chain memo.
 */
export function adoptRecoveredLaunch(launch: RecoveredLaunch, store?: KeyStore | null): void {
  const r = launch.request;
  saveProofTx(r.slabAddress, r.proofTx);
  if (r.payload) saveProofPayload(r.slabAddress, r.payload);
  saveRegisterRequest(
    { slabAddress: r.slabAddress, mainnetCA: r.mainnetCA, dexPoolAddress: r.dexPoolAddress, dexType: r.dexType, symbol: r.symbol },
    store,
  );
}

// ── Resuming an unfinished launch from chain ─────────────────────────────────────────────────────

/**
 * Where a cross-device resume starts. Steps 1-3 each read the chain and skip what already landed
 * (nft registry, oracle hand-off, LP portfolio + matcher, deposit, insurance), and 4-5 check their
 * own accounts, so starting early is always safe; this only avoids needless reads. Step 0 (slab
 * creation) can never be resumed here: it needs the slab's own keypair.
 */
export function inferResumeStep(f: { portfolios: bigint; cTot: bigint }): 1 | 2 | 3 {
  if (f.portfolios === 0n) return 1;
  if (f.cTot === 0n) return 2;
  return 3;
}

/** Atoms to the human string the wizard's amount fields hold ("1000", "0.5"). */
export function atomsToHuman(atoms: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = atoms / base;
  const frac = (atoms % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** What cannot be resumed without the launching browser, and why, for the resume card. */
export const CANNOT_RESUME_COPY = {
  step0:
    "A launch that stopped before its market was created has nothing on chain to continue from, and its account can only be reclaimed with a key that never left the browser that started it.",
  p3Seed:
    "This market's liquidity seed isn't recorded in its launch history, so its registration can't be proven from here.",
} as const;

/** The launch parameters a chain-recovered resume must not let the live wizard state change. */
export interface ResumableParams {
  initialPriceE6: bigint;
  tradingFeeBps: number;
  initialMarginBps: number;
  lpCollateral: bigint;
  insuranceAmount?: bigint;
  lpExposureBps?: number;
  symbol?: string;
  name?: string;
  mainnetCA?: string;
  dexPoolAddress?: string;
  dexType?: string;
  oracleMode?: "pyth" | "hyperp" | "admin" | "keeper";
  p3?: unknown;
}

/**
 * Whether a recovered launch can be resumed from here. A market created with ONE asset slot is a
 * vault-owned-LP (P3) market: its later steps sign a junior-tranche floor and amount that neither the
 * memo binds nor the chain yet records in a form this recovery reads. Resuming it with today's flag or
 * form default would sign values the creator never chose, so it is refused until those parameters can
 * be read or proven. (Registration-only recovery of a FINISHED market is unaffected.)
 */
export function canResumeLaunch(r: Pick<RecoveredLaunch, "maxPortfolioAssets">): { ok: true } | { ok: false; reason: string } {
  if (r.maxPortfolioAssets === 1) {
    return {
      ok: false,
      reason:
        "This launch can't be resumed from here yet: it is a vault-owned-liquidity market, and the parameters its remaining steps would sign aren't recorded on chain. Continue it from the browser that started it.",
    };
  }
  return { ok: true };
}

/**
 * Pin a resumed launch's parameters to what the market was created with and what the memo bound.
 * InitMarket already fixed price, margin and fee on chain; the memo bound the pool, dex type, symbol,
 * name and LP seed; the slab's own insurance balance, when above zero, is what was already funded. The
 * live wizard re-detects some of these (a different top pool, a moved price), and letting that through
 * would resume the market with different parameters, or send a registration that can no longer verify.
 * A one-slot (P3) market never reaches here (canResumeLaunch refuses it), so `p3` is always cleared:
 * it must not depend on today's flag or form.
 */
export function applyRecoveredLaunch<T extends ResumableParams>(params: T, r: RecoveredLaunch | null): T {
  if (!r) return params;
  const ins = r.onChainInsuranceAtoms;
  return {
    ...params,
    initialPriceE6: r.initialPriceE6,
    tradingFeeBps: r.tradingFeeBps,
    initialMarginBps: r.initialMarginBps,
    lpCollateral: r.lpCollateralAtoms,
    ...(ins != null && ins > 0n ? { insuranceAmount: ins } : {}),
    ...(r.lpExposureBps != null ? { lpExposureBps: r.lpExposureBps } : {}),
    symbol: r.symbol,
    name: r.name,
    mainnetCA: r.request.mainnetCA ?? params.mainnetCA,
    dexPoolAddress: r.poolAddress,
    dexType: r.dexType,
    oracleMode: "keeper",
    p3: undefined,
  };
}

/**
 * Every value the resumed steps will make the wallet sign that the registration memo does NOT bind, in
 * plain words, for the "Verified" summary. The memo binds price, margin, fee, LP seed, token, pool and
 * symbol/name; these are the rest.
 */
export function unboundResumeValues(r: RecoveredLaunch, decimals = 6): string[] {
  const out: string[] = [];
  const ins = r.onChainInsuranceAtoms;
  out.push(
    ins != null && ins > 0n
      ? `Insurance: ${atomsToHuman(ins, decimals)}, as already funded on chain.`
      : "Insurance top-up: the amount in this form (not part of the signed registration); nothing is funded yet.",
  );
  out.push(
    `Earn-vault backing seed: ${atomsToHuman(2n * backingSeedPerDomain(r.lpCollateralAtoms), decimals)} in total across both backing domains (derived from the liquidity seed, not separately signed).`,
  );
  out.push(
    r.lpExposureBps != null
      ? `Trade limits (per-trade and position caps): from the liquidity exposure shown, ${bpsPct(r.lpExposureBps)} of the liquidity seed, written once at the liquidity step. The original value can't be read until that step has run.`
      : "Trade limits: already written at the liquidity step; this resume does not change them.",
  );
  return out;
}

export const CHAIN_RESUME_MISMATCH_COPY = "This resume was verified for a different market or wallet. Cancel it and open the launch again.";

/**
 * Why a chain resume may not be used for a launch or Retry right now, or null when it may: it must be for
 * the slab being resumed and for the connected wallet, and be a market this recovery can resume.
 */
export function chainResumeRefusal(
  r: Pick<RecoveredLaunch, "creator" | "maxPortfolioAssets"> & { request: Pick<RecoveredLaunch["request"], "slabAddress"> },
  resumeSlab: string | null,
  walletB58: string | null,
): string | null {
  if (r.request.slabAddress !== resumeSlab || r.creator !== walletB58) return CHAIN_RESUME_MISMATCH_COPY;
  const can = canResumeLaunch(r);
  return can.ok ? null : can.reason;
}
