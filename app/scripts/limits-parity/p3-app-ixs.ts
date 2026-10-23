/**
 * Emits APP-BUILT P3 instructions as JSON for the LiteSVM scenario
 * `limits_app_p3_end_to_end` (patch: scripts/limits-parity/p3-sim/). The instructions come
 * from the SAME lib code the hooks send:
 *   bind      -> lib/limits/p3-wizard.ts buildP3BindIxs            (wizard M4p / step 5)
 *   deposit   -> lib/limits/earn-ixs.ts earnTxPlan + buildEarnDepositIxs  (useInsuranceLP.deposit)
 *   execute   -> lib/limits/earn-ixs.ts earnTxPlan + buildEarnExecuteIxs  (useInsuranceLP.withdraw)
 *   exit      -> lib/limits/resolved-exit-ixs.ts exitStepIxs      (useResolvedExit)
 *   junior-release -> lib/limits/junior-resolved-release.ts (useJuniorTranche.releaseResolved):
 *                ATA-idempotent + [78 if pending] + 102 resolved, amount = physical - C from raw bytes
 *   init-market -> lib/create-market-args.ts slabSizeFor + buildV17InitMarketArgs (create() M1:
 *                createAccount(slab) + InitMarket [admin, slab, mint]); p3 => 1 slot, else 14
 *   plan      -> lib/limits/resolved-exit.ts planResolvedExit on RAW account bytes (base64),
 *                decoded by lib/limits/decode.ts exactly as the hook does
 *   finish    -> lib/limits/resolved-finish.ts buildFinishList + finishItemIxs (useResolvedExit.finish):
 *                the whole "Finish now" list from ONE snapshot (+ the redeemer's 76 last)
 *   finish-needed -> resolved-finish.ts stepNeeded on fresh bytes (runFinish's skip rule)
 * argv: <cmd> <json>. Keys are base58; bigints are decimal strings.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { ACCOUNTS_INIT_MARKET, buildAccountMetas, buildIx, deriveInsuranceLpMint, deriveLpBackingLedger, deriveLpEscrow, deriveLpRedemption, encodeInitMarket } from "@percolatorct/sdk";
import { buildV17InitMarketArgs, marketAssetSlotsFor, slabSizeFor } from "../../lib/create-market-args";
import { deriveMarketParams, MIN_LEVERAGE_X } from "../../lib/market-params";
import { buildP3BindIxs, canonicalVaultLpMatcher } from "../../lib/limits/p3-wizard";
import { buildEarnDepositIxs, buildEarnExecuteIxs, buildRequestRedeemIx, earnTxPlan, withForcedHarvest } from "../../lib/limits/earn-ixs";
import { CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET, TAG_DEPOSIT_TO_LP_VAULT, TAG_EXECUTE_REDEMPTION, KIND_PORTFOLIO } from "../../lib/limits/constants";
import { buildDepositJuniorTrancheIx, buildWithdrawJuniorTrancheIx, deriveLpVaultRegistryPda, deriveVaultLpState } from "../../lib/limits/p3-ix";
import { exitStepIxs, type ExitIxContext, type ExitPortfolioRef } from "../../lib/limits/resolved-exit-ixs";
import { viewerOwnedKeys } from "../../lib/limits/resolved-topup";
import { emptyCloseSteps, MAX_PREPENDED_EMPTY_CLOSES } from "../../lib/limits/resolved-exit-load";
import { buildFinishList, finishEstimate, finishItemCu, finishItemIxs, FINISH_MAX_TXS, planPortfolios, pruneRefusedItems, stepNeeded, type FinishItem } from "../../lib/limits/resolved-finish";
import { planResolvedExit, type ExitStep, type ExitPortfolio } from "../../lib/limits/resolved-exit";
import {
  decodeLpVaultRegistryBound,
  decodeLpVaultRegistryShares,
  decodeMarketEngineView,
  decodeResolvedMarket,
  decodeLpVaultRegistryDomain,
  decodeResolvedPortfolio,
  decodeTerminalBacking,
  decodeVaultLpState,
  decodePortfolioRisk,
  decodePortfolioLegs,
  decodeAssetVaultLp,
} from "../../lib/limits/decode";
import { earnPanelPricing, earnViewFromLimits, lagBoundsMarketFromEngine } from "../../lib/limits/earn";
import { vaultLpEquityLagBounds } from "../../lib/limits/earn-pricing";
import { previewDepositShares, previewWithdrawAtoms } from "../../lib/limits/earn-withdraw";
import { buildFirstTradeInitIxs, buildFundAndTradeIxs, failedFirstTradeLeg, isPortfolioIdRace, predictPortfolioId, readNextPortfolioId } from "../../lib/first-trade";
import { readAssetMarketId, readPortfolioIdentity } from "../../lib/v18-wire";
import { earnAbsorbed, harvestableFeeAtoms, vaultLpValueAtoms } from "../../lib/limits/vault-tranche";
import { find77, recallCandidates, redeemRepairVariants } from "../../lib/limits/senior-draw-repair";
import { parseP3DrawLogs, summarizeDrawEvents } from "../../lib/limits/p3-draw-logs";
import { buildCatchUpCrankIx, planCatchUp } from "../../lib/self-heal";
import { planOwnPortfolioCleanup } from "../../lib/limits/own-portfolio-cleanup";
import { buildJuniorResolvedReleaseIxs, juniorReleaseNeedsHarvest, juniorResolvedReleasableAtoms } from "../../lib/limits/junior-resolved-release";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

interface J { [k: string]: unknown }
const [cmd, raw] = process.argv.slice(2);
const a = JSON.parse(raw ?? "{}") as J;
const pk = (k: string): PublicKey => new PublicKey(String(a[k]));
const big = (k: string): bigint => BigInt(String(a[k]));
const b64 = (s: unknown): Uint8Array => new Uint8Array(Buffer.from(String(s), "base64"));

function enc1(ix: TransactionInstruction) {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    dataHex: Buffer.from(ix.data).toString("hex"),
  };
}

function out(ixs: TransactionInstruction[], extra: J = {}): void {
  process.stdout.write(
    JSON.stringify({
      ...extra,
      ixs: ixs.map((ix) => ({
        programId: ix.programId.toBase58(),
        keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
        dataHex: Buffer.from(ix.data).toString("hex"),
      })),
    }),
  );
}

/** The P3 Earn context from raw account bytes (what readEarnP3Context decodes after its RPC). */
function earnCtx(programId: PublicKey, market: PublicKey) {
  const md = b64(a.marketB64);
  const rd = b64(a.registryB64);
  const sd = a.vaultLpStateB64 ? b64(a.vaultLpStateB64) : null;
  const view = decodeMarketEngineView(md);
  const st = sd ? decodeVaultLpState(sd) : null;
  const rm = decodeResolvedMarket(md);
  const dom = decodeLpVaultRegistryDomain(rd);
  const tb = dom !== null ? decodeTerminalBacking(md, dom) : null;
  return {
    terminalFlat: !!rm && rm.mode === 1 && rm.materializedPortfolioCount === 0n && rm.cTot === 0n,
    terminalResidual: tb ? tb.residual : null,
    bound: decodeLpVaultRegistryBound(rd),
    vaultLpState: deriveVaultLpState(programId, market),
    lpPortfolio: st ? new PublicKey(st.lpPortfolio) : null,
    harvestable: view ? harvestableFeeAtoms(view) : null,
    registryShares: decodeLpVaultRegistryShares(rd),
    mode: view ? view.mode : 0,
  };
}

const programId = pk("programId");
const market = pk("market");
const domain = Number(a.domain ?? 0);
const ledger = deriveLpBackingLedger(programId, market, domain)[0];
const siblingLedger = deriveLpBackingLedger(programId, market, domain ^ 1)[0];
const registry = deriveLpVaultRegistryPda(programId, market);

/** Decode every account exactly as useResolvedExit does and plan (shared by plan / exit / finish). */
function exitSnapshot() {
  const md = b64(a.marketB64);
  const rd = b64(a.registryB64);
  const sd = a.vaultLpStateB64 ? b64(a.vaultLpStateB64) : null;
  const m = decodeResolvedMarket(md);
  if (!m) throw new Error("market not decodable");
  const bound = decodeLpVaultRegistryBound(rd) === true;
  const st = bound && sd ? decodeVaultLpState(sd) : null;
  const vaultLpKey = st ? new PublicKey(st.lpPortfolio).toBase58() : null;
  const portfolios: ExitPortfolio[] = [];
  const refs = new Map<string, ExitPortfolioRef>();
  for (const p of (a.portfolios as J[]) ?? []) {
    const d = b64(p.dataB64);
    if (d[10] !== KIND_PORTFOLIO) continue;
    const view = decodeResolvedPortfolio(d);
    if (!view) continue;
    const key = String(p.key);
    const owner = new PublicKey(view.owner);
    refs.set(key, { owner, portfolioId: BigInt(String(p.portfolioId)), matcherSequence: BigInt(String(p.matcherSequence)), positionEpoch: BigInt(String(p.positionEpoch)) });
    const isVaultLp = key === vaultLpKey;
    portfolios.push({ key, view, isVaultLp, escrowed: !isVaultLp && !PublicKey.isOnCurve(owner.toBytes()) && !owner.equals(registry) });
  }
  const engine = decodeMarketEngineView(md);
  const plan = planResolvedExit({
    market: m, nowSlot: big("nowSlot"), portfolios, boundVault: bound, harvestableAtoms: engine ? harvestableFeeAtoms(engine) : null,
    terminalResidualAtoms: decodeTerminalBacking(md, domain)?.residual ?? null,
  });
  const ctx: ExitIxContext = {
    payer: pk("payer"),
    collateralMint: pk("mint"),
    vaultToken: pk("vaultToken"),
    vaultAuthority: pk("vaultAuthority"),
    programId,
    market,
    portfolios: refs,
    vault: st
      ? { programId, market, registry, vaultLpState: deriveVaultLpState(programId, market), lpPortfolio: new PublicKey(st.lpPortfolio), ledger, siblingLedger, juniorOwner: new PublicKey(st.juniorOwner), domain }
      : null,
  };
  return { plan, portfolios, bound, ctx };
}

if (cmd === "init-market") {
  // Exactly create()'s M1 shape: the slab sized by slabSizeFor(params), InitMarket args from
  // buildV17InitMarketArgs(params, derived) with derived = deriveMarketParams(leverage, lp, price).
  const params = {
    p3: a.p3 === true ? { juniorFloorBps: 1_000, juniorAtoms: big("lpCollateral") } : undefined,
    initialPriceE6: big("initialPriceE6"),
    tradingFeeBps: Number(a.tradingFeeBps),
    initialMarginBps: Number(a.initialMarginBps),
    lpCollateral: big("lpCollateral"),
  };
  const derived = deriveMarketParams(
    params.initialMarginBps > 0 ? 10_000 / params.initialMarginBps : MIN_LEVERAGE_X,
    params.lpCollateral,
    params.initialPriceE6,
  );
  const space = slabSizeFor(params);
  out(
    [
      SystemProgram.createAccount({
        fromPubkey: pk("funder"), newAccountPubkey: market, lamports: Number(a.lamports), space, programId,
      }),
      buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, { admin: pk("admin"), slab: market, mint: pk("mint") }),
        data: encodeInitMarket(buildV17InitMarketArgs(params, derived)),
      }),
    ],
    { space, maxPortfolioAssets: marketAssetSlotsFor(params) },
  );
} else if (cmd === "junior-release") {
  const md = b64(a.marketB64);
  const st = decodeVaultLpState(b64(a.vaultLpStateB64));
  if (!st) throw new Error("no vault LP state");
  const owner = pk("owner");
  const mint = pk("mint");
  const releasable = juniorResolvedReleasableAtoms(md, domain, st.seniorClaimAtoms);
  if (releasable === null) throw new Error("terminal backing unreadable");
  // `amount` overrides the planned amount (negative controls only; the UI caps at releasable).
  const amount = a.amount !== undefined ? big("amount") : releasable;
  const needHarvest = juniorReleaseNeedsHarvest(md, domain);
  const vm = { programId, market, registry, vaultLpState: deriveVaultLpState(programId, market), lpPortfolio: new PublicKey(st.lpPortfolio), ledger, siblingLedger };
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);
  out(
    amount > 0n
      ? buildJuniorResolvedReleaseIxs({ vm, domain, owner, ownerAta, mint, vaultToken: pk("vaultToken"), vaultAuthority: pk("vaultAuthority") }, amount, needHarvest)
      : [],
    { amount: amount.toString(), releasable: releasable.toString(), needHarvest, ownerAta: ownerAta.toBase58() },
  );
} else if (cmd === "bind") {
  out(
    buildP3BindIxs({
      market: { programId, market, registry, vaultLpState: deriveVaultLpState(programId, market), lpPortfolio: pk("vaultLpPortfolio"), ledger, siblingLedger },
      creator: pk("creator"),
      vaultLpPortfolio: pk("vaultLpPortfolio"),
      portfolioLen: Number(a.portfolioLen),
      portfolioRentLamports: Number(a.rent),
      matcherProgram: canonicalVaultLpMatcher(String(a.matcherProgram ?? CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET)),
      matcherCtx: pk("matcherCtx"),
      matcherCtxRentLamports: Number(a.ctxRent),
      juniorFloorBps: Number(a.floorBps),
      juniorAtoms: big("juniorAtoms"),
      creatorAta: pk("creatorAta"),
      vaultToken: pk("vaultToken"),
    }),
  );
} else if (cmd === "deposit" || cmd === "execute") {
  const ctx = earnCtx(programId, market);
  // forceHarvest: the payout's pre-sign 84 retry (lib/limits/earn-ixs.ts sendWithHarvestOn84).
  const plan = withForcedHarvest(earnTxPlan(cmd === "deposit" ? TAG_DEPOSIT_TO_LP_VAULT : TAG_EXECUTE_REDEMPTION, ctx), a.forceHarvest === true);
  if (!plan.ok) {
    out([], { blocked: plan.reason });
  } else if (cmd === "deposit") {
    out(
      buildEarnDepositIxs({
        programId, depositor: pk("user"), market, registry, lpMint: pk("lpMint"), depositorLpAta: pk("lpAta"),
        sourceToken: pk("source"), vaultToken: pk("vaultToken"), ledger, siblingLedger, domain, amount: big("amount"), plan,
      }),
      { prependHarvest: plan.prependHarvest, tail: !!plan.tail },
    );
  } else {
    out(
      buildEarnExecuteIxs({
        programId, redeemer: pk("user"), market, registry, redemption: pk("redemption"), lpMint: pk("lpMint"), escrow: pk("escrow"),
        vaultToken: pk("vaultToken"), vaultAuthority: pk("vaultAuthority"), ledger, redeemerDest: pk("dest"), siblingLedger, domain, plan,
      }),
      { prependHarvest: plan.prependHarvest, tail: !!plan.tail },
    );
  }
} else if (cmd === "recall-variants") {
  // The 88 repair (lib/limits/senior-draw-repair.ts, run by sendTx): the SAME execute list the
  // Earn claim sends, and for each recall candidate the list with a 98 inserted before the 77.
  // sendTx simulates them in order and keeps the first that succeeds; the sim does the same.
  const ctx = earnCtx(programId, market);
  const plan = earnTxPlan(TAG_EXECUTE_REDEMPTION, ctx);
  if (!plan.ok) throw new Error(`blocked: ${plan.reason}`);
  const exec = buildEarnExecuteIxs({
    programId, redeemer: pk("user"), market, registry, redemption: pk("redemption"), lpMint: pk("lpMint"), escrow: pk("escrow"),
    vaultToken: pk("vaultToken"), vaultAuthority: pk("vaultAuthority"), ledger, redeemerDest: pk("dest"), siblingLedger, domain, plan,
  });
  const md = b64(a.marketB64);
  const vs = decodeVaultLpState(b64(a.vaultLpStateB64));
  if (!vs) throw new Error("no vault LP state");
  const eng = decodeMarketEngineView(md);
  const risk = a.lpB64 ? decodePortfolioRisk(b64(a.lpB64)) : null;
  const lpVal = eng && risk ? vaultLpValueAtoms(risk, eng) : null;
  const at = find77(exec, programId);
  const cands = recallCandidates(md, vs, domain, lpVal && lpVal.kind !== "stale" ? lpVal.atoms : null);
  process.stdout.write(
    JSON.stringify({
      candidates: cands.map(String),
      plain: exec.map(enc1),
      variants: redeemRepairVariants(exec, at, pk("user"), cands).map((v) => ({ kind: v.kind, amount: v.amount?.toString() ?? null, ixs: v.ixs.map(enc1) })),
    }),
  );
} else if (cmd === "earn-price") {
  // Earn worse-of pricing (ede691b6): the panel's preview from RAW bytes, through the SAME code the
  // Earn page runs (lib/limits/earn.ts earnPanelPricing -> earn-pricing.ts earnSeniorPricing).
  // backing = the pots' NAV the app is given (the page passes useInsuranceLP's vaultTotalAtoms).
  const md = b64(a.marketB64);
  const rd = b64(a.registryB64);
  const eng = decodeMarketEngineView(md);
  const vs = decodeVaultLpState(b64(a.vaultLpStateB64));
  const lpBytes = b64(a.lpB64);
  const risk = decodePortfolioRisk(lpBytes);
  const shares = decodeLpVaultRegistryShares(rd);
  const avl = decodeAssetVaultLp(md, 0);
  if (!eng || !vs || !risk || shares === null || !avl) throw new Error("earn-price: undecodable input");
  const limits = {
    state: "ready", flags: { p1: true, p2: true, p2FeeCharged: false, p3: true }, engine: eng, riskLimits: null, bandBps: null,
    vaultLp: avl, lp: { ...risk, address: new PublicKey(avl.vaultLpPortfolio), posQ: 0n, legs: decodePortfolioLegs(lpBytes) },
    matcher: null, vaultState: vs, registryShares: shares, assetAdmin: null,
  } as unknown as Parameters<typeof earnPanelPricing>[0];
  const backing = big("backing");
  const pr = earnPanelPricing(limits, backing);
  const view = earnViewFromLimits(limits, backing, 0n);
  const bounds = vaultLpEquityLagBounds({ ...risk, legs: decodePortfolioLegs(lpBytes) }, lagBoundsMarketFromEngine(eng));
  const redeem = a.shares ? big("shares") : 0n;
  const amount = a.amount ? big("amount") : 0n;
  process.stdout.write(
    JSON.stringify({
      eff: eng.effectivePriceE6.toString(), tgt: eng.targetPriceE6.toString(),
      legs: decodePortfolioLegs(lpBytes).map((l) => ({ slot: l.slot, asset: l.assetIndex, side: l.side, basis: l.basisPosQ.toString() })),
      worse: bounds === "stale" ? "stale" : bounds.worse.toString(), better: bounds === "stale" ? "stale" : bounds.better.toString(),
      cEff: view?.seniorClaimEff.toString() ?? null, nav: view?.backingCover.toString() ?? null, totalShares: shares.toString(),
      withdrawSeniorValue: pr?.withdrawSeniorValue?.toString() ?? null, depositClaim: pr?.depositSeniorValue?.toString() ?? null,
      withdrawAtoms: pr && redeem > 0n ? previewWithdrawAtoms(redeem, pr.totalShares, pr.withdrawSeniorValue)?.toString() ?? null : null,
      depositShares: pr && amount > 0n ? previewDepositShares(amount, pr.totalShares, pr.depositSeniorValue)?.toString() ?? null : null,
      // CONTROL: the same numbers WITHOUT the worse-of rule (pre-ede691b6 pricing)
      plainWithdrawAtoms: view?.senior != null && redeem > 0n ? previewWithdrawAtoms(redeem, shares, view.senior)?.toString() ?? null : null,
    }),
  );
} else if (cmd === "first-trade") {
  // UX WP-6: the first trade in ONE approval (lib/first-trade.ts, run by hooks/useFirstTrade):
  // A = [CreateAccount, InitPortfolio]; B = [Deposit, TradeCpi] at the PREDICTED portfolio id read
  // from the market bytes (asset 0 AssetOracleProfileV16.next_portfolio_id, rustc offset 480).
  // With portfolioB64 (the race: someone initialised in between) B is rebuilt with the REAL id.
  const md = b64(a.marketB64);
  const eng = decodeMarketEngineView(md);
  const lpId = readPortfolioIdentity(b64(a.lpB64));
  const next = readNextPortfolioId(md);
  if (!eng || next === null) throw new Error("first-trade: undecodable market");
  const p = {
    programId, owner: pk("owner"), market, portfolio: pk("portfolio"), userAta: pk("userAta"), vaultTokenAta: pk("vaultToken"),
    depositAtoms: big("depositAtoms"),
    lp: { accountB: pk("lp"), matcherProg: pk("matcherProg"), matcherCtx: pk("matcherCtx"), matcherDelegate: pk("matcherDelegate") },
    lpId, marketId: readAssetMarketId(md, 0), size: big("size"), limitPriceE6: big("limitPriceE6"), marketTradeFeeBps: eng.tradeFeeBaseBps,
  };
  const real = a.portfolioB64 ? readPortfolioIdentity(b64(a.portfolioB64)) : null;
  const id = real
    ? { portfolioId: real.portfolioId, sequence: real.matcherSequence, positionEpoch: real.positionEpoch }
    : { portfolioId: predictPortfolioId(next), sequence: 0n, positionEpoch: 0n };
  process.stdout.write(
    JSON.stringify({
      next: next.toString(), predicted: predictPortfolioId(next).toString(), usedId: id.portfolioId.toString(),
      a: buildFirstTradeInitIxs(p, Number(a.rent ?? 0)).map(enc1),
      b: buildFundAndTradeIxs(p, id).map(enc1),
    }),
  );
} else if (cmd === "first-trade-classify") {
  const e = { message: String(a.error) };
  process.stdout.write(JSON.stringify({ race: isPortfolioIdRace(e), leg: failedFirstTradeLeg(e, Number(a.depositIndex ?? 2)) }));
} else if (cmd === "catch-up") {
  // UX WP-2 (SH-2): the catch-up cranks planSelfHeal prepends (lib/self-heal.ts).
  const md = b64(a.marketB64);
  const plan = planCatchUp(md, big("readSlot"), Number(a.userCu ?? 200_000));
  const ixs = Array.from({ length: plan.k }, () => buildCatchUpCrankIx(programId, pk("cranker"), market, pk("portfolio")));
  out(ixs, { k: plan.k, lagSlots: plan.lagSlots.toString(), dtSlots: plan.dtSlots?.toString() ?? null, beyondCap: plan.beyondCap });
} else if (cmd === "draw-logs") {
  const ev = parseP3DrawLogs(a.logs as string[]);
  process.stdout.write(JSON.stringify({ events: JSON.parse(JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), summary: JSON.parse(JSON.stringify(summarizeDrawEvents(ev), (_k, v) => (typeof v === "bigint" ? v.toString() : v))) }));
} else if (cmd === "earn-absorbed") {
  const vs = decodeVaultLpState(b64(a.vaultLpStateB64));
  const r = vs ? earnAbsorbed(vs) : null;
  process.stdout.write(JSON.stringify(r ? { outstanding: r.outstanding.toString(), drawn: r.drawn.toString(), restored: r.restored.toString() } : null));
} else if (cmd === "junior-withdraw" || cmd === "junior-deposit") {
  // useJuniorTranche: 97 / 96 against the vault LP named by the on-chain vault-LP state.
  const st = decodeVaultLpState(b64(a.vaultLpStateB64));
  if (!st) throw new Error("vault LP state not decodable");
  const vm = { programId, market, registry, vaultLpState: deriveVaultLpState(programId, market), lpPortfolio: new PublicKey(st.lpPortfolio), ledger, siblingLedger };
  out([
    cmd === "junior-withdraw"
      ? buildWithdrawJuniorTrancheIx(vm, pk("owner"), pk("dest"), pk("vaultToken"), pk("vaultAuthority"), big("amount"))
      : buildDepositJuniorTrancheIx(vm, pk("owner"), pk("source"), pk("vaultToken"), big("amount")),
  ]);
} else if (cmd === "own-cleanup") {
  // useCloseMarket (B12): the wallet's OWN portfolios on a Resolved market, owner-signed groups.
  const portfolios = ((a.portfolios as J[]) ?? []).flatMap((p) => {
    const view = decodeResolvedPortfolio(b64(p.dataB64));
    return view ? [{ key: new PublicKey(String(p.key)), view, portfolioId: BigInt(String(p.portfolioId)), matcherSequence: BigInt(String(p.matcherSequence)), positionEpoch: BigInt(String(p.positionEpoch)) }] : [];
  });
  const groups = planOwnPortfolioCleanup({ programId, owner: pk("owner"), market, collateralMint: pk("mint"), vaultToken: pk("vaultToken"), vaultAuthority: pk("vaultAuthority"), portfolios });
  const g = groups[0];
  if (!g) {
    out([], { groups: 0 });
  } else {
    // two ix lists: [withClose, withoutClose]; the harness applies runOwnPortfolioCleanup's rule
    process.stdout.write(JSON.stringify({ kind: g.kind, withClose: JSON.parse(JSON.stringify(g.withClose.map(enc1))), withoutClose: g.withoutClose ? g.withoutClose.map(enc1) : null }));
  }
} else if (cmd === "plan" || cmd === "exit") {
  const x = exitSnapshot();
  // `skip`: step kinds the harness leaves for later (e.g. close-empty, to stage empties).
  const skip = new Set(Array.isArray(a.skip) ? (a.skip as unknown[]).map(String) : []);
  const steps: ExitStep[] = (x.plan.phase === "sweep" || x.plan.phase === "owner-window" ? x.plan.steps : []).filter((s) => !skip.has(s.kind));
  const blockers = x.plan.phase === "not-resolved" ? [] : x.plan.blockers.map((b) => b.kind);
  const summary: J = { phase: x.plan.phase, steps: steps.map((s) => ({ kind: s.kind, portfolio: "portfolio" in s ? s.portfolio : "" })), blockers };
  if (cmd === "plan" || steps.length === 0) {
    out([], summary);
  } else {
    const first = steps[0];
    if (!first) throw new Error("no step");
    out(exitStepIxs(first, x.ctx), summary);
  }
} else if (cmd === "empty-closes") {
  // useInsuranceLP / useJuniorTranche: the tag-8 closes of empty portfolios prepended to 77 / 102.
  const x = exitSnapshot();
  const steps = emptyCloseSteps(x.plan, a.max !== undefined ? Number(a.max) : MAX_PREPENDED_EMPTY_CLOSES);
  out(steps.flatMap((st) => exitStepIxs(st, x.ctx)), { closes: steps.length });
} else if (cmd === "finish") {
  // UX WP-8 "Finish now": the WHOLE pre-signed list from ONE snapshot (useResolvedExit.finish),
  // each item's instructions + compute budget; optionally the redeemer's own 76 last.
  const x = exitSnapshot();
  const withEarnRequest = a.redeemer !== undefined && a.redeemer !== null;
  const items = buildFinishList({
    portfolios: x.portfolios,
    boundVault: x.bound,
    withEarnRequest,
    only: x.plan.phase === "owner-window" ? planPortfolios(x.plan) : undefined,
    // useResolvedExit.finish: the connected wallet's own portfolios go first (its 46 top-up).
    viewerOwned: a.viewer ? viewerOwnedKeys(x.portfolios, pk("viewer")) : undefined,
  }).slice(0, FINISH_MAX_TXS);
  let request: TransactionInstruction | null = null;
  if (withEarnRequest) {
    const redeemer = pk("redeemer");
    const lpMint = deriveInsuranceLpMint(programId, market)[0];
    request = buildRequestRedeemIx({
      programId, redeemer, registry, lpMint, redeemerLpAta: pk("redeemerLpAta"),
      escrow: deriveLpEscrow(programId, market)[0], redemption: deriveLpRedemption(programId, registry, redeemer)[0], shares: big("shares"),
      // AUD-S1-18: the app always sends the floored 76; the floor is whatever the caller quotes (default 1 atom).
      minPayoutAtoms: a.minPayout !== undefined ? big("minPayout") : 1n,
    });
  }
  process.stdout.write(JSON.stringify({
    phase: x.plan.phase,
    estimate: finishEstimate(items),
    items: items.map((item) => ({ item, cu: finishItemCu(item), ixs: finishItemIxs(item, x.ctx, request).map(enc1) })),
  }));
} else if (cmd === "finish-prune") {
  // useResolvedExit.finish's pre-sign pass: drop what the simulation refused (pruneRefusedItems).
  const items = a.items as unknown as FinishItem[];
  const refused = new Set((a.refused as unknown as number[]).map(Number));
  const kept = pruneRefusedItems(items, items.filter((_, i) => refused.has(i)));
  process.stdout.write(JSON.stringify({ kept: items.map((it, i) => (kept.includes(it) ? i : -1)).filter((i) => i >= 0) }));
} else if (cmd === "finish-needed") {
  // The driver's skip rule (runFinish): re-plan from fresh bytes, is this item still needed?
  const x = exitSnapshot();
  process.stdout.write(JSON.stringify({ phase: x.plan.phase, needed: stepNeeded(a.item as unknown as FinishItem, x.plan) }));
} else {
  throw new Error(`unknown cmd ${cmd}`);
}
