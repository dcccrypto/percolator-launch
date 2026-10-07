"use client";
import { resolveMarketMetadata } from "@/lib/market-metadata";
import { UNSUPPORTED_POOL_COPY } from "@/lib/wizard-copy";
import { WIZARD_STORAGE_KEY } from "@/lib/wizard-storage";

import { DEFAULT_JUNIOR_FLOOR_BPS, validateP3Wizard, wizardP3Params } from "@/lib/limits/p3-wizard";
import { COPY as LIMITS_COPY } from "@/lib/limits/copy";
import { p3WizardEnabled } from "@/lib/limits/flags";
import { FC, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSolBalance } from "@/hooks/useSolBalance";
import {
  useCreateMarket,
  DEFAULT_SLAB_SIZE,
  wizardSlabBytes,
  flooredInitialMarginBps,
  type CreateMarketParams,
} from "@/hooks/useCreateMarket";
import { useStuckSlabs } from "@/hooks/useStuckSlabs";
import { clearInFlightMarket } from "@/lib/inFlightMarket";
import { useQuickLaunch } from "@/hooks/useQuickLaunch";
import { type DexPoolResult, isVerifiedPool } from "@/hooks/useDexPoolSearch";
import { parseHumanAmount } from "@/lib/parseAmount";
import { MAX_FUNDABLE_REQUIREMENT } from "@/lib/prefund-requirement";
import { backingSeedPerDomain, deriveLaunchMarketParams, leverageFromMarginBps } from "@/lib/market-params";
import { LP_EXPOSURE_DEFAULT_BPS, clampLpExposureBps } from "@/lib/matcher-params";
import { getConfig, getNetwork } from "@/lib/config";
import { toE6, formatMarkPrice } from "@/lib/format";

import { useDuplicateMarket } from "@/hooks/useDuplicateMarket";
import { WizardProgress } from "./WizardProgress";
import { StepTokenSelect } from "./StepTokenSelect";
import { StepControlRoom, leverageToMarginBps, marginBpsToLeverage } from "./StepControlRoom";
import { LaunchProgress } from "./LaunchProgress";
import { LaunchSuccess } from "./LaunchSuccess";
import { ResumeFromChainCard } from "./ResumeFromChainCard";
import { ChainResumeNotice } from "./ChainResumeNotice";
import { dropChainResume, useChainResumeWalletGuard } from "@/hooks/useChainResumeWalletGuard";
import { applyRecoveredLaunch, atomsToHuman, chainResumeRefusal, type RecoveredLaunch } from "@/lib/launch-recovery";
import { RecoverSolBanner } from "./RecoverSolBanner";
// W8 fix: share ONE SOL-cost formula with CostEstimate.tsx's own display so the
// launch gate and the number shown to the user can never drift apart — see that
// file's computeCreateMarketSolCost doc comment.
import { computeCreateMarketSolCost } from "./CostEstimate";
import { isValidBase58Pubkey } from "@/lib/createWizardUtils";
import { isMockMode } from "@/lib/mock-mode";
import { lowestLeverageTrackablePriceUsd } from "@/lib/launch-price-floor";
import { pickInitialPrice, toInitialPriceE6, withTrackableFloor } from "@/lib/initial-price";

type WizardStep = 1 | 2;

interface WizardState {
  step: WizardStep;
  // Step 1 — Token
  mintAddress: string;
  tokenMeta: { name: string; symbol: string; decimals: number } | null;
  walletBalance: bigint | null;
  // Auto-resolved (no longer user-chosen) — set once when leaving Step 1
  oracleType: "pyth" | "hyperp_ema" | "admin" | "keeper";
  oracleFeed: string;
  dexPool: DexPoolResult | null;
  pythFeed: { id: string; name: string } | null;
  // Step 2 — Control Room dials
  tradingFeeBps: number;
  initialMarginBps: number;
  lpCollateral: string;
  /** P3 wizard: junior floor, bps of the senior claim (10%..100%). */
  juniorFloorBps?: number;
  /** Largest one-sided position the LP takes on, bps of the LP seed (default 1x). */
  lpExposureBps: number;
  insuranceAmount: string;
  adminPrice: string | null;
  // #2588: set only by the user turning the dial. Detection that lands on step 2
  // (resolve price, pool scan) never overwrites a dial the user set.
  marginSetByUser: boolean;
  lpSetByUser: boolean;
}

const DEFAULT_STATE: WizardState = {
  step: 1,
  mintAddress: "",
  tokenMeta: null,
  walletBalance: null,
  oracleType: "admin",
  oracleFeed: "",
  dexPool: null,
  pythFeed: null,
  tradingFeeBps: 30,
  // GH#2621: 2000 bps (5x) — a conservative default until quick-launch detection
  // supplies a tier-based value. The dial itself now goes up to MAX_LEVERAGE_X
  // (10x, see StepControlRoom's MAX_LEVERAGE comment); this default was never
  // tied to the old dead 6.67x floor, it just predates the tier defaults below.
  initialMarginBps: 2000,
  lpCollateral: "",
  lpExposureBps: LP_EXPOSURE_DEFAULT_BPS,
  insuranceAmount: "100",
  adminPrice: null,
  marginSetByUser: false,
  lpSetByUser: false,
};

/**
 * Market Creation Wizard — the "Control Room" flow.
 * Step 1: Token → Step 2: Control Room (auto-resolved price feed + slab size,
 * four dials for leverage/fee/liquidity/insurance, hold-to-launch).
 * There is no mode toggle and no slab-tier picker — v17 has exactly one slab
 * size (max capacity) and oracle detection is always automatic.
 */
export const CreateMarketWizard: FC<{ initialMint?: string; /** /create?resume=<slab>: continue this unfinished launch from chain (#3267). */ resumeSlabParam?: string }> = ({ initialMint, resumeSlabParam }) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { state: createState, create, reset: resetCreate, restoreSlabKeypair, restoreSlabAddress, clearChainResume, retryKeeperRegistration, cancelInFlightLaunch } = useCreateMarket();
  // GH#2623: leaving this page mid-launch must stop the tail-broadcast retry
  // loop from prompting further wallet signatures — without this, a market
  // creation begun here kept re-signing (new popups) "even while out of the
  // create window" because create()'s async chain has no tie to this
  // component's lifecycle. Unmount-only: cancelInFlightLaunch is a stable
  // useCallback ([]), so this never fires mid-session, only on navigation
  // away. Safe to call even when nothing is in flight (a no-op abort).
  // Optional-chained: several existing tests mock useCreateMarket() with an
  // older shape that doesn't include this field.
  useEffect(() => {
    return () => cancelInFlightLaunch?.();
  }, [cancelInFlightLaunch]);
  // BUG 7 fix: RecoverSolBanner's onResume callback only forwards (slabAddress, fromStep) —
  // it's a shared component out of this fix's scope, so rather than changing its signature,
  // call useStuckSlabs() here too (same hook RecoverSolBanner uses internally) to get our own
  // reference to the reconstructed slab Keypair and hand it to restoreSlabKeypair below.
  //
  // W7 fix (2026-07-08): use the full `stuckSlabs` list, not just the singular
  // most-recent `stuckSlab` — RecoverSolBanner can now render a card (and a RESUME
  // button) for ANY in-flight market, not only the most-recently-touched one. Looking
  // up only `stuckSlab` here would silently fail to hand over the right keypair for an
  // older stuck slab's resume click.
  const { stuckSlab, stuckSlabs, refresh: refreshStuckSlabs } = useStuckSlabs();

  // PERC-516: Persist wizard state to localStorage so form survives page refresh.
  // This fixes the "Continue button does nothing" bug — without persisted state,
  // allValid is false after refresh because all fields are empty.
  // WIZARD_STORAGE_KEY lives in lib/wizard-storage so RecoverSolBanner clears the same key.
  // GH#1719: Use sessionStorage to track whether this is a fresh navigation to /create
  // vs. a same-session page refresh. On fresh navigation (new browser tab, link click from
  // another page), always start at step 1 to avoid showing stale Token step as "Complete"
  // with a mint that may no longer exist on devnet.
  // sessionStorage is cleared when the tab is closed; localStorage persists across sessions.
  const SESSION_VISITED_KEY = "percolator-wizard-visited";
  const isPageRefresh = typeof window !== "undefined" && sessionStorage.getItem(SESSION_VISITED_KEY) === "1";

  const [wizard, setWizard] = useState<WizardState>(() => {
    // GH#1719: Only restore persisted state on same-session page refresh.
    // On fresh navigation (new tab, external link), always start at Step 1 — Token.
    if (!isPageRefresh) {
      // Mark this tab as visited so a subsequent F5 refresh can restore.
      try { sessionStorage.setItem(SESSION_VISITED_KEY, "1"); } catch {}
      // Still pre-fill mintAddress from URL param when provided.
      return { ...DEFAULT_STATE, mintAddress: initialMint ?? "" };
    }
    try {
      const persisted = typeof window !== "undefined" ? localStorage.getItem(WIZARD_STORAGE_KEY) : null;
      if (persisted) {
        const parsed = JSON.parse(persisted);
        // GH#1298: Don't restore directly to the Control Room (step 2) — require the user
        // to navigate there explicitly in the current session. Restoring straight to the
        // step that contains the launch control with all fields pre-populated risks the
        // hold-to-launch control being immediately armable on first render. Clamp to Step 1
        // so the user must click CONTINUE once more before reaching it.
        const restoredStep = Number(parsed.step ?? 1);
        const safeStep: WizardStep = restoredStep >= 2 ? 1 : (restoredStep as WizardStep);
        // Restore serializable fields only — bigint and complex objects need special handling
        return {
          ...DEFAULT_STATE,
          ...parsed,
          // GH#1298: Never restore straight to the Control Room
          step: safeStep,
          // bigint fields can't survive JSON — restore as bigint or null
          walletBalance: parsed.walletBalance != null ? BigInt(parsed.walletBalance) : null,
          // DexPoolResult is a plain object, survives JSON. E2E B21: a pool persisted
          // before owner verification (no dexType) may be a DAMM pool the keeper can't
          // price, so it is dropped and re-picked from the verified search.
          dexPool: isVerifiedPool(parsed.dexPool) ? parsed.dexPool : null,
          pythFeed: parsed.pythFeed ?? null,
          tokenMeta: parsed.tokenMeta ?? null,
          // initialMint prop overrides persisted mint
          mintAddress: initialMint ?? parsed.mintAddress ?? "",
          marginSetByUser: false,
          lpSetByUser: false,
          // Restored with a bare spread above: never let a stale/corrupt value reach the matcher.
          lpExposureBps: clampLpExposureBps(parsed.lpExposureBps),
        };
      }
    } catch {
      // Corrupted data — ignore
    }
    return { ...DEFAULT_STATE, mintAddress: initialMint ?? "" };
  });
  // GH#1280: Restore completedSteps based on the persisted wizard step.
  // If the previous session reached step N, steps 1..N-1 were completed.
  // This ensures WizardProgress shows correct state after a reload and allows
  // the user to click back to previous steps during resume.
  // GH#1298: Use safeStep (same clamping as wizard state above) so completedSteps
  // doesn't mark step 1 complete when we've rewound past it.
  // GH#1719: Same fresh-navigation guard — don't restore completedSteps on new tabs.
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(() => {
    if (!isPageRefresh) return new Set<number>();
    try {
      const persisted = typeof window !== "undefined" ? localStorage.getItem(WIZARD_STORAGE_KEY) : null;
      if (persisted) {
        const parsed = JSON.parse(persisted);
        const step = Number(parsed.step ?? 1);
        // GH#1298: Apply same safe-step clamping as wizard state above
        const safeStep = step >= 2 ? 1 : step;
        if (safeStep > 1) {
          const steps = new Set<number>();
          for (let i = 1; i < safeStep; i++) steps.add(i);
          return steps;
        }
      }
    } catch {
      // Corrupted data — ignore
    }
    return new Set<number>();
  });
  /**
   * PERC-513: Track which step to resume from when recovering a stuck slab.
   * Set by onResume from RecoverSolBanner; null = fresh creation (step 0).
   * When non-null, handleLaunch skips slab creation and resumes from this step.
   */
  const [resumeFromStep, setResumeFromStep] = useState<number | null>(null);
  // Which stuck slab is being resumed; only meaningful while resumeFromStep is set.
  const [resumeSlab, setResumeSlab] = useState<string | null>(null);
  // #3267: a resume rebuilt from chain (proven against the creation tx's registration memo). Its
  // parameters are pinned: the live wizard must not re-detect a different pool or price under it.
  const [chainResume, setChainResume] = useState<RecoveredLaunch | null>(null);
  const chainResumeRef = useRef<RecoveredLaunch | null>(null);
  chainResumeRef.current = chainResume;
  const [chainResumeError, setChainResumeError] = useState<string | null>(null);
  // A chain resume belongs to ONE slab and ONE wallet. Switching wallet drops it (and the resume mode it
  // started), so a verification done for wallet A can never launch for wallet B.
  const walletB58 = publicKey?.toBase58() ?? null;
  useChainResumeWalletGuard(walletB58, !!chainResume, () =>
    dropChainResume({
      cancelInFlightLaunch,
      forget: () => {
        setChainResume(null);
        setChainResumeError(null);
        setResumeFromStep(null);
        setResumeSlab(null);
      },
      resetCreate,
    }),
  );
  /**
   * The chain resume a launch/retry may use, or null when there is none. Refuses (and says why) when it
   * is for a different slab than the one being resumed, was verified for another wallet, or is a market
   * this recovery cannot resume.
   */
  const gateChainResume = (): { ok: true; resume: RecoveredLaunch | null } | { ok: false } => {
    const r = chainResume;
    if (!r) return { ok: true, resume: null };
    const refusal = chainResumeRefusal(r, resumeSlab, walletB58);
    if (refusal) {
      setChainResumeError(refusal);
      return { ok: false };
    }
    setChainResumeError(null);
    return { ok: true, resume: r };
  };

  // BUG FIX (2026-09-25, tester-reported "RESUME CREATION is a dead button"):
  // clicking RESUME CREATION previously only updated React state — nothing
  // scrolled the "Resume mode" indicator (below) into view, so on a page
  // where the recovery card + the click target aren't both already on screen
  // (e.g. multiple stuck-slab cards stacked above it), the click looked like
  // it did nothing. Scroll the indicator into view the moment resume mode
  // turns on, so the click has an immediate, visible effect every time.
  const resumeBannerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (resumeFromStep === null) return;
    resumeBannerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [resumeFromStep]);

  // PERC-516: Persist wizard state to localStorage whenever it changes.
  // Clear on successful market creation (handled in the success callback).
  useEffect(() => {
    try {
      const serializable = {
        ...wizard,
        // bigint can't be JSON-serialized — convert to string
        walletBalance: wizard.walletBalance != null ? wizard.walletBalance.toString() : null,
      };
      localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(serializable));
    } catch {
      // localStorage full or unavailable — non-critical
    }
  }, [wizard]);

  // Auto-detection for oracle + suggested parameters — always on, there is no manual mode.
  const quickMintForHook = wizard.mintAddress.length >= 32 ? wizard.mintAddress : null;
  const quickLaunch = useQuickLaunch(quickMintForHook);

  // On-chain mint network validation (set by StepTokenSelect)
  // GH#1280: Initialize to true when restoring from localStorage with a valid tokenMeta.
  // The token was already validated in the previous session — re-validating is unnecessary
  // and would block Step 2 during resume since StepTokenSelect hasn't rendered.
  const [mintExistsOnNetwork, setMintExistsOnNetwork] = useState<boolean>(() => {
    try {
      const persisted = typeof window !== "undefined" ? localStorage.getItem(WIZARD_STORAGE_KEY) : null;
      if (persisted) {
        const parsed = JSON.parse(persisted);
        return !!(parsed.tokenMeta && parsed.mintAddress && (parsed.mintAddress as string).length >= 32);
      }
    } catch {
      // Corrupted data — ignore
    }
    return false;
  });

  // SOL balance for the Control Room's launch gate, kept current while the wizard is open (a
  // faucet airdrop used to leave the gate at "Need ~N SOL" until a reload). Mock mode: 8.5 SOL.
  const solBalance = useSolBalance(publicKey, connection);

  // Once a launch has started (or failed, with Retry pending), Retry resumes the
  // same market: InitMarket already fixed margin, fee and price on chain, and
  // later steps reuse the wizard's fee, collateral and price. Detection landing
  // in between must not move any of them. Nothing launches without a price, so
  // freezing adminPrice here cannot bring back the #2552 hang. A ref rather than
  // a dep, so the effect still re-runs on exactly config and adminPrice.
  const launchInFlightRef = useRef(false);
  launchInFlightRef.current = createState.loading || createState.step > 0 || !!createState.error;

  // Apply auto-detected defaults to the dials (fee, margin, collateral, price)
  useEffect(() => {
    if (!quickLaunch.config || launchInFlightRef.current) return;
    setWizard((prev) => ({
      ...prev,
      tradingFeeBps: chainResumeRef.current ? chainResumeRef.current.tradingFeeBps : quickLaunch.config!.tradingFeeBps,
      // Normalise through the dial's own quantisation so the number ON the dial is
      // exactly the number written on-chain. quick-launch's "high" tier supplies
      // 1000 bps (10x); GH#2621 raised the dial's ceiling to MAX_LEVERAGE_X (10x)
      // to match, so this now round-trips to 1000 bps exactly. Before that fix the
      // dial could only render up to 6.5x, so this round-trip silently downgraded
      // every high-tier default from 10x to 6.5x (1538 bps) — kept generically
      // (rather than special-cased to 10x) because it also protects any FUTURE
      // quick-launch tier from producing a bps the dial's own snap can't display.
      initialMarginBps: prev.marginSetByUser || chainResumeRef.current
        ? prev.initialMarginBps
        : leverageToMarginBps(marginBpsToLeverage(quickLaunch.config!.initialMarginBps)),
      lpCollateral: prev.lpSetByUser || chainResumeRef.current ? prev.lpCollateral : quickLaunch.config!.lpCollateral,
      // Apply detected oracle price as adminPrice (used if oracle ends up admin)
      adminPrice: pickInitialPrice(prev.adminPrice, quickLaunch.adminPrice, quickLaunch.config?.initialPrice),
    }));
    // `quickLaunch.adminPrice` belongs here too. The two prices resolve from
    // SEPARATE effects in useQuickLaunch — config lands as soon as tokenMeta
    // does, while /api/oracle/resolve takes up to 8s — so adminPrice is
    // normally the LATE one. Keyed on config alone, a price that arrived after
    // the auto-advance never reached the wizard at all, and the button sat on
    // "Waiting on price feed" with a perfectly good price one hook away. That
    // is the permanent form of the reported hang.
  }, [quickLaunch.config, quickLaunch.adminPrice]);

  // Derived values
  const mintValid = isValidBase58Pubkey(wizard.mintAddress) && wizard.mintAddress.length >= 32;
  // BUG 16 fix: use the FLOORED margin (what create() actually enforces on-chain,
  // via flooredInitialMarginBps / deriveMarketParams — see useCreateMarket.ts;
  // MIN_SAFE_INITIAL_MARGIN_BPS itself is superseded, see GH#2621) so the success
  // screen advertises real leverage, not the raw requested value the dial produced.
  // leverageFromMarginBps, not floor(10000 / bps): the margin rounds up (6x stores 1667 bps),
  // so a naive floor showed 6x as 5x. Same derivation create() records (useCreateMarket.ts).
  const maxLeverage = leverageFromMarginBps(flooredInitialMarginBps(wizard.initialMarginBps));
  // The per-slot price-move cap InitMarket will set for this leverage — the
  // same derivation create() uses (deriveLaunchMarketParams). It sets how small
  // an opening price can be before the mark stops moving under open interest
  // (lib/initial-price.ts minTrackablePriceE6), so the floor follows the dial.
  const launchPriceMoveBps = deriveLaunchMarketParams({
    initialMarginBps: wizard.initialMarginBps,
    lpCollateral: 0n,
    initialPriceE6: 1_000_000n,
  }).maxPriceMoveBpsPerSlot;
  const feeConflict = wizard.tradingFeeBps >= wizard.initialMarginBps;
  const hasTokens = wizard.walletBalance !== null && wizard.walletBalance > 0n;
  // Collateral is ALWAYS the universal Sim-USDC mint on devnet (6 decimals) — never the
  // base token's own decimals. The mirror-mint model (where collateral was a per-market
  // mint of the base token, at the base token's decimals) is removed; see the collateral
  // mint resolution below (`collateralMintAddress`) and launch-test-market.ts (the proven
  // reference), whose vault/LP/insurance amounts are all parsed at Sim-USDC's 6 decimals
  // regardless of what the base token's own decimals are. The base token's tokenMeta.decimals
  // is now purely informational (display only) — it no longer feeds collateral amount math.
  const decimals = 6;
  // GH#1301: Check against the full token requirement (LP collateral + insurance).
  // A user with 600 tokens but 1100 LP collateral entered would previously pass the
  // check and reach a failed on-chain tx.
  // W11 fix (2026-07-08): no longer adds MIN_INIT_MARKET_SEED (500 tokens) —
  // useCreateMarket.ts's create() no longer transfers a vault seed before InitMarket
  // (the proven on-chain reference, launch-test-market.ts, never seeds the vault and
  // succeeds; the engine doesn't require or account for it). Keeping the old +500 here
  // would over-require tokens the flow no longer needs.
  // GH#2515: the launch also seeds BOTH backing domains from the creator's
  // wallet (TopUpBackingBucket, one per domain), so LP + insurance is not what
  // a launch costs. At the current policy backingSeedPerDomain(lp) === lp, so a
  // 1,000 LP / 100 insurance launch needs 3,100 tokens, not 1,100 — this gate
  // enabled LAUNCH at 1,100 and the flow then stranded mid-way, after M1/M2 had
  // already landed on chain and spent SOL.
  //
  // The wizard was the only place that got this wrong: CostEstimate (:132) and
  // createMarketValidation (:163) both already add the two seeds, and
  // useCreateMarket's tx4 pre-flight (:2704) requires
  // `lpCollateral + insuranceAmount + 2n * backingSeed`. So the panel showed the
  // creator the correct total while the button beside it used a smaller one.
  //
  // Uses backingSeedPerDomain rather than re-deriving from
  // BACKING_SEED_PCT_OF_LP, which is what the other two call sites do: the
  // helper also applies BACKING_SEED_MIN_ATOMS, so a tiny LP seed does not
  // under-require here the way a bare percentage would.
  // GH#2592: deliberately NOT refactored to call fullMarketRequirement, even
  // though it computes the same number. create-market-launch-gate.test.ts binds
  // this expression textually — it is the regression guard dcc added for GH#2515
  // — and this copy has never been the one that drifted. The copy that did was
  // /api/devnet-pre-fund's, which is now unified with the hook's tx4Required.
  const totalTokensRequired = useMemo((): bigint => {
    const lpRaw = parseHumanAmount(wizard.lpCollateral || "0", decimals);
    const insRaw = parseHumanAmount(wizard.insuranceAmount, decimals);
    return lpRaw + insRaw + 2n * backingSeedPerDomain(lpRaw);
  }, [wizard.lpCollateral, wizard.insuranceAmount, decimals]);

  const hasSufficientTokensForSeed = wizard.walletBalance !== null && wizard.walletBalance >= totalTokensRequired;
  const symbol = wizard.tokenMeta?.symbol ?? "Token";

  // Step 1 validation
  // One market per token: an existing market for this CA blocks step 1 —
  // both the Continue button and auto-advance — BEFORE the user spends SOL
  // deploying a slab that POST /api/markets will 409 anyway (the server check
  // is the authoritative half of this guard). Lives here, not in
  // StepTokenSelect, because auto-advance unmounts this step the moment
  // conditions are met — step-local state would be discarded before it could
  // gate anything. Scoped to step-1 advancement only (NOT allValid) so a
  // mid-launch/resume flow can't be flipped invalid by its own market
  // appearing in the registry. Fail-open on lookup errors; auto-advance also
  // waits while `checking` so a slow lookup can't be raced past.
  const step1Valid = mintValid && wizard.tokenMeta !== null && (wizard.tokenMeta.decimals <= 12) && mintExistsOnNetwork;
  const duplicateCheck = useDuplicateMarket(wizard.step === 1 ? wizard.mintAddress : null);
  // Leaving step 1 also needs a connected wallet: the Control Room is where the
  // launch is signed, so a wallet-less user must never reach it (StepTokenSelect
  // shows "Connect wallet to continue" in place of Continue). Gates both the
  // Continue click and the one-shot auto-advance, which then fires as soon as
  // the user connects.
  const step1CanAdvance = step1Valid && !duplicateCheck.checking && duplicateCheck.duplicates.length === 0 && !!publicKey;

  // Control Room (dial) validation — trading fee, leverage margin, and seed amounts.
  const paramsValid =
    wizard.tradingFeeBps >= 1 &&
    wizard.tradingFeeBps <= 1000 &&
    wizard.initialMarginBps >= 100 &&
    !feeConflict &&
    parseFloat(wizard.lpCollateral || "0") > 0 &&
    parseFloat(wizard.insuranceAmount) >= 100;

  // BUG 1 fix: rent estimate must be sized off the actual v17 slab length
  // (DEFAULT_SLAB_SIZE = v17MarketAccountLen(14)) — v17 has no slab tiers, the slab is
  // always this fixed size.
  //
  // W8 fix (2026-07-08): this used to hand-roll its own formula that omitted the LP-portfolio
  // (9347 bytes) + matcher-ctx (320 bytes) rent entirely — under-counting required SOL by
  // ~0.067 SOL, enough to pass this gate and then strand the user mid-flow with "insufficient
  // lamports." Delegates to computeCreateMarketSolCost() (CostEstimate.tsx), the SAME formula
  // the Control Room's rent readout uses, so the gate and the displayed number can't drift
  // apart.
  const solCostBreakdown = useMemo(
    () => computeCreateMarketSolCost({ p3: p3WizardEnabled() }),
    [],
  );
  // Resuming a stuck launch from the recovery banner: its slab account (the bulk of the cost)
  // already exists, so only the remaining steps' SOL is required. Still a real check: with too
  // little SOL a resume could land the LP step (past the reclaim window) and stall after it.
  const requiredSol =
    resumeFromStep !== null
      ? solCostBreakdown.totalSolCost - solCostBreakdown.slabRentSol
      : solCostBreakdown.totalSolCost;
  const hasSufficientSol = solBalance !== null && solBalance >= requiredSol;
  const isDevnet = getNetwork() === "devnet";
  // Collateral mint: on devnet, ALWAYS the universal Sim-USDC mint (app/lib/config.ts
  // testUsdcMint) — the same collateral every seeded market, the faucet, and the trade
  // flow use. Never a per-market "mirror" of the base token entered in Step 1 (that model
  // is removed — see launch-test-market.ts, the proven end-to-end reference this now
  // matches: its InitMarket/vault ATA/LP deposit/StakeInitPool all use SIM_USDC as the
  // collateral mint). On mainnet (no Sim-USDC concept — testUsdcMint is devnet-only in
  // CONFIGS), collateral remains the user-entered mint, unchanged.
  const simUsdcMint = (getConfig() as Record<string, unknown>).testUsdcMint as string | undefined;
  const collateralMintAddress = isDevnet && simUsdcMint ? simUsdcMint : wizard.mintAddress;
  const collateralSymbol = isDevnet ? "Sim-USDC" : symbol;
  // GH#1301 (superseded): tokens used to be auto-airdropped only for Percolator-managed
  // mirror mints. Now that devnet collateral is ALWAYS Sim-USDC and is ALWAYS auto-funded
  // via /api/devnet-pre-fund (called from useCreateMarket.ts's create() before every
  // collateral-moving step), the wallet-token-balance precheck is unconditionally
  // irrelevant on devnet — skip it for every devnet market, not just former "mirror" ones.
  // Mock-mode (?mock=1) bypasses all balance checks so investors / pitch
  // captures can walk through the wizard without funding a real wallet.
  const mockBypass = isMockMode();
  const skipTokenBalanceCheck = isDevnet || mockBypass;
  // On devnet the token-balance gate above is skipped because the faucet funds
  // the wallet — but the faucet refuses a launch it cannot cover, and nothing
  // bounds LP collateral anywhere in validation. Left ungated, a creator who
  // types a large LP gets no warning and the refusal lands at step 3 of the
  // sequential/resume path, AFTER earlier steps have landed on chain and spent
  // SOL. Gate it where it is still free to fix.
  const devnetFaucetCeilingExceeded =
    isDevnet && !mockBypass && totalTokensRequired > MAX_FUNDABLE_REQUIREMENT;

  // Build oracle feed for create — also used below to gate launch on a real price
  // being available (no on-chain InitMarket call should ever ship a priceE6 of 0).
  const getOracleFeedAndPrice = (): { oracleFeed: string; priceE6: bigint } => {
    if (wizard.oracleType === "pyth") {
      return { oracleFeed: wizard.oracleFeed, priceE6: 0n };
    }
    if (wizard.oracleType === "hyperp_ema") {
      // PERC-470: Hyperp mode uses index_feed_id = zeros.
      // The DEX pool address is passed separately via dexPoolAddress.
      // Use the detected DEX price as initial mark price.
      // Same floor as the admin/keeper path below. Left on a bare toE6 this
      // branch disagreed with it in BOTH directions: 8e-7 rounded up to 1n and
      // launched at $0.000001 (+25%), while 4e-7 rounded to 0n and blocked —
      // reporting a feed problem for a price the feed had delivered.
      const dexPrice = wizard.dexPool?.priceUsd;
      const resolvedHyperp = withTrackableFloor(
        toInitialPriceE6(dexPrice != null ? String(dexPrice) : null),
        launchPriceMoveBps,
      );
      return {
        oracleFeed: "0".repeat(64),
        priceE6: resolvedHyperp.ok ? resolvedHyperp.e6 : 0n,
      };
    }
    // Admin / keeper oracle — NEVER default to a placeholder price.
    // deriveMarketParams converts the LP's notional guardrails into a TOKEN
    // count using this price, and the matcher has no update instruction, so a
    // wrong opening price mis-sizes maxFillAbs/maxInventoryAbs permanently.
    // That is not hypothetical: market 5sDvEs2… launched at a hand-entered
    // price while its feed published something else, and its $1,000 per-trade
    // cap became $9.57 — every larger trade failed with a bare
    // InvalidAccountData. A $1 fallback here also silently DEFEATED the
    // oraclePriceValid gate below (1 -> 1e6 is non-zero), so the launch was
    // never actually blocked. Missing or unparseable price => 0n => blocked.
    const resolved = withTrackableFloor(toInitialPriceE6(wizard.adminPrice), launchPriceMoveBps);
    return { oracleFeed: "0".repeat(64), priceE6: resolved.ok ? resolved.e6 : 0n };
  };

  // Pyth doesn't rely on a client-computed priceE6 (the on-chain feed supplies it), so it's
  // always "ready." Hyperp/admin/keeper all need a nonzero detected price before launching.
  const { priceE6: currentPriceE6 } = getOracleFeedAndPrice();
  const oraclePriceValid = wizard.oracleType === "pyth" ? true : currentPriceE6 !== 0n;
  // Why the price is unusable, so the button can say something true. A price
  // BELOW the E6 floor is not a feed problem and no amount of waiting fixes
  // it — telling the user to wait was the bug. See lib/initial-price.ts.
  const priceProblem =
    wizard.oracleType === "pyth"
      ? null
      : withTrackableFloor(
          toInitialPriceE6(
            // Read whichever field the active branch actually prices from,
            // otherwise the hyperp path blocks on dexPool.priceUsd and then
            // explains itself using an unrelated (often null) adminPrice.
            wizard.oracleType === "hyperp_ema"
              ? (wizard.dexPool?.priceUsd != null ? String(wizard.dexPool.priceUsd) : null)
              : wizard.adminPrice,
          ),
          launchPriceMoveBps,
        );
  const priceBelowMinimum =
    priceProblem != null && !priceProblem.ok && priceProblem.reason === "below-minimum"
      ? priceProblem
      : null;
  // The pricing helper also reports `above-maximum` (> $1,000,000/token), but the
  // disabled-reason cascade only surfaced below-minimum — so an above-maximum
  // price fell through to the literal feed-wait fallback, a message that can
  // never clear because no feed update makes such a price representable (#2606).
  const priceAboveMaximum =
    priceProblem != null && !priceProblem.ok && priceProblem.reason === "above-maximum"
      ? priceProblem
      : null;
  // Representable, but too small for the mark to move once positions open
  // (M-8). Lower leverage raises the per-slot cap and so lowers this floor.
  const priceBelowTrackable =
    priceProblem != null && !priceProblem.ok && priceProblem.reason === "below-trackable"
      ? priceProblem
      : null;
  // The floor at the lowest leverage the dial offers: only suggest lowering
  // leverage when doing so would actually clear the block.
  const lowestLeverageMinPrice = lowestLeverageTrackablePriceUsd();

  /**
   * Can the keeper actually PRICE this market once it exists?
   *
   * On devnet every market is priced by the keeper reading a mainnet DEX pool
   * (AUTH_MARK, oracle_authority delegated to the keeper wallet). A token with
   * no supported pool resolves to plain "admin" mode, which nothing pushes to
   * — the market would launch, list, and then sit at a frozen price forever.
   *
   * Derived from the SAME resolution applyOracleAndAdvance performs, so the
   * gate and the value actually written cannot drift apart. It reads the
   * DETECTION (quickLaunch), never wizard.oracleType — that is still the
   * "admin" default until the user leaves step 1, and gating on it deadlocked
   * every devnet launch once before (see 7567e0b5).
   */
  // No Pyth (2026-10-01): the detection never yields a Pyth oracle; a DEX pool or admin only.
  const resolvedOracleType: "hyperp_ema" | "admin" | "keeper" =
    quickLaunch.oracleType === "hyperp_ema" && quickLaunch.dexPoolAddress
        ? isDevnet
          ? "keeper"
          : "hyperp_ema"
        : "admin";
  const registrable = !isDevnet || resolvedOracleType === "keeper";
  const notRegistrableReason = registrable
    ? null
    : (quickLaunch.error ?? UNSUPPORTED_POOL_COPY);

  /**
   * The oracle fields the wizard must hold for the detected oracle. Written by
   * applyOracleAndAdvance AND re-synced on step 2 (effect below): the resolve
   * lookup routinely lands after the advance, and a one-time snapshot left the
   * wizard on the "admin" placeholder while `registrable` above (which reads
   * quickLaunch live) enabled the launch. That shipped pool-backed tokens as
   * unpriced admin markets (#2582). One derivation, written in both places.
   */
  const detectedOracle = useMemo(() => {
    switch (resolvedOracleType) {
      case "keeper":
      case "hyperp_ema":
        return {
          oracleType: resolvedOracleType,
          oracleFeed: quickLaunch.dexPoolAddress!,
          dexPool: quickLaunch.poolInfo ?? null,
        };
      default:
        return { oracleType: "admin" as const, oracleFeed: "" };
    }
  }, [resolvedOracleType, quickLaunch.dexPoolAddress, quickLaunch.poolInfo]);

  // Once create() has started, the wizard's oracle fields describe the slab on
  // chain and handleRetry must reuse them, so the sync stops.
  const launchStarted = createState.loading || createState.step > 0 || !!createState.error;
  // Shared by the sync and the launch gate so both compare the same fields.
  // Comparing oracleType alone leaves a one-commit window where the type
  // matches but the stored pool is stale.
  const matchesDetected = useCallback(
    (w: WizardState) =>
      w.oracleType === detectedOracle.oracleType &&
      w.oracleFeed === detectedOracle.oracleFeed &&
      (!("dexPool" in detectedOracle) || w.dexPool === detectedOracle.dexPool),
    [detectedOracle],
  );
  useEffect(() => {
    if (wizard.step !== 2 || launchStarted || quickLaunch.oracleResolving) return;
    setWizard((prev) => (matchesDetected(prev) ? prev : { ...prev, ...detectedOracle }));
  }, [wizard.step, launchStarted, quickLaunch.oracleResolving, detectedOracle, matchesDetected]);

  // Launch only with a SETTLED lookup that the wizard has actually applied.
  // Not part of allValid: handleRetry must keep working off the slab's original
  // config even if detection re-runs mid-flow.
  const oracleSettled = !quickLaunch.oracleResolving && matchesDetected(wizard);


  // Everything a launch or a Retry needs from the wizard's own fields.
  const configValid =
    // Never let an unregistrable market reach the launch button.
    registrable &&
    step1Valid &&
    paramsValid &&
    oraclePriceValid &&
    (skipTokenBalanceCheck || (hasTokens && hasSufficientTokensForSeed)) &&
    !devnetFaucetCeilingExceeded;
  // A fresh launch must also hold the FULL launch cost in SOL. Retry does not:
  // the steps already landed spent part of that SOL, so a live balance (kept
  // current by useSolBalance) sits below requiredSol after a partial launch and
  // would silently block resuming it. A step that is really short of SOL fails
  // with its own error and Retry can be pressed again after an airdrop.
  const allValid = configValid && (mockBypass || hasSufficientSol);

  // P3 wizard: the junior tranche requirement (floor range, junior >= floor of the Earn seed).
  const p3Issue = useMemo(() => {
    if (!p3WizardEnabled()) return null;
    // Same decimals handleLaunch parses the Liquidity amount with.
    const j = parseHumanAmount(wizard.lpCollateral || "0", wizard.tokenMeta?.decimals ?? 6);
    return validateP3Wizard({
      juniorFloorBps: wizard.juniorFloorBps ?? DEFAULT_JUNIOR_FLOOR_BPS,
      juniorAtoms: j,
      seedNavAtoms: 2n * backingSeedPerDomain(j),
    });
  }, [wizard.lpCollateral, wizard.juniorFloorBps, wizard.tokenMeta?.decimals]);
  const launchDisabled = !allValid || !oracleSettled || !publicKey || p3Issue !== null;
  const launchDisabledReason: string | undefined = !publicKey
    ? "Connect wallet"
    : p3Issue
      ? LIMITS_COPY.p3Wizard.issue[p3Issue]
    : !oracleSettled
      ? "Resolving price feed"
    : !registrable
      ? (notRegistrableReason ?? "This token cannot be priced")
    : !step1Valid
      ? "Resolve a token first"
      : duplicateCheck.duplicates.length > 0
        ? "Market already exists for this token"
        : feeConflict
          ? "Trading fee must be below leverage margin"
          : !paramsValid
            ? "Adjust liquidity or insurance"
            : !oraclePriceValid
              ? (priceBelowMinimum
                  ? `${wizard.tokenMeta?.symbol ?? "This token"} trades at ${formatMarkPrice(priceBelowMinimum.price)}, below the $0.000001 minimum a market can price`
                  : priceAboveMaximum
                    ? `${wizard.tokenMeta?.symbol ?? "This token"} trades at ${formatMarkPrice(priceAboveMaximum.price)}, above the $1,000,000 maximum a market can price`
                    : priceBelowTrackable
                      ? `${wizard.tokenMeta?.symbol ?? "This token"} trades at ${formatMarkPrice(priceBelowTrackable.price)}, below the ${formatMarkPrice(priceBelowTrackable.minPrice)} a ${maxLeverage}x market needs to track its price${priceBelowTrackable.price >= lowestLeverageMinPrice ? " — try lower leverage" : ""}`
                      : "Waiting on price feed")
              : !mockBypass && !hasSufficientSol
                ? `Need ~${requiredSol.toFixed(3)} SOL`
                : devnetFaucetCeilingExceeded
                  ? `Devnet faucet caps a launch at ${(Number(MAX_FUNDABLE_REQUIREMENT) / 10 ** decimals).toLocaleString()} ${collateralSymbol} — reduce LP collateral`
                  : !skipTokenBalanceCheck && (!hasTokens || !hasSufficientTokensForSeed)
                    ? "Insufficient token balance"
                    : undefined;

  // Demo-launch state machine. When mockBypass is on and the user clicks
  // LAUNCH MARKET, fake the 5-step deploy progress over ~3 seconds, then
  // redirect to the BONK mock trade page so the demo flow continues into
  // an actual-looking trading UI.
  const router = useRouter();
  const DEMO_BONK_SLAB = "HN7cABqLq46Es1jh92hQnvWo6BuZPdSmTQ5P2NMeVRgr";
  const DEMO_STEPS = [
    "Create slab & initialize market",
    "Oracle setup & crank",
    "Initialize LP",
    "Deposit, insurance & finalize",
    "Create Earn vault",
    "Initialize stake pool",
  ];
  const [demoLaunch, setDemoLaunch] = useState<{
    active: boolean;
    step: number;
    txSigs: string[];
  }>({ active: false, step: 0, txSigs: [] });

  useEffect(() => {
    if (!demoLaunch.active) return;
    if (demoLaunch.step >= DEMO_STEPS.length) {
      // All steps complete — redirect to the mock BONK trade page so the
      // demo flows from create → trade without breaking pace.
      const t = setTimeout(() => {
        router.push(`/trade/${DEMO_BONK_SLAB}?mock=1`);
      }, 600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setDemoLaunch((prev) => ({
        ...prev,
        step: prev.step + 1,
        txSigs: [
          ...prev.txSigs,
          // Plausible-looking base58 mock tx signature (88 chars)
          "5" + Math.random().toString(36).substring(2, 12).padEnd(10, "x") +
          Math.random().toString(36).substring(2, 12).padEnd(10, "x") +
          "demo" + Math.random().toString(36).substring(2, 12).padEnd(60, "x"),
        ],
      }));
    }, 650);
    return () => clearTimeout(t);
  }, [demoLaunch.active, demoLaunch.step, router]);

  // Navigation
  const goToStep = useCallback((step: WizardStep) => {
    setWizard((prev) => ({ ...prev, step }));
  }, []);

  const goBack = useCallback(() => {
    setWizard((prev) => ({ ...prev, step: Math.max(1, prev.step - 1) as WizardStep }));
  }, []);

  // Applies the auto-detected oracle (from useQuickLaunch) to wizard state and enters
  // the Control Room (Step 2). This is the ONLY way to leave Step 1 — there is no
  // separate manual oracle-selection step anymore, so the detection result must be
  // captured the moment the user leaves the token step.
  const applyOracleAndAdvance = useCallback(() => {
    setCompletedSteps((prev) => new Set(prev).add(1));
    // PERC-470: a detected DEX pool maps to hyperp_ema on mainnet and to
    // "keeper" on devnet (oracle_authority delegated to the keeper, which reads
    // the mainnet pool and pushes via PushAuthMark). See detectedOracle.
    setWizard((prev) => ({
      ...prev,
      ...detectedOracle,
      step: 2 as WizardStep,
      adminPrice: pickInitialPrice(prev.adminPrice, quickLaunch.adminPrice, quickLaunch.config?.initialPrice),
    }));
  }, [detectedOracle, quickLaunch.adminPrice, quickLaunch.config]);

  // Auto-advance: step 1 → step 2 the moment the token resolves and detection settles.
  // Only fires once per mount — a subsequent edit to the mint requires an explicit
  // Continue click (StepTokenSelect's own button, wired to the same handler below).
  const quickAutoAdvancedRef = useRef(false);
  useEffect(() => {
    if (quickAutoAdvancedRef.current) return;
    if (wizard.step !== 1) return;
    // One market per token: step1CanAdvance additionally waits for the
    // duplicate-market lookup to settle and come back clear — auto-advance
    // must not race past a pending check (see useDuplicateMarket).
    if (!step1CanAdvance) return;
    if (quickLaunch.loading) return;
    if (!quickLaunch.config) return;

    quickAutoAdvancedRef.current = true;
    applyOracleAndAdvance();
  }, [wizard.step, step1CanAdvance, quickLaunch.loading, quickLaunch.config, applyOracleAndAdvance]);

  // Keep a stable ref to the current mint address so setMintAddress (which has no
  // deps and therefore no closure over wizard) can detect same-value calls.
  // GH#1263: belt-and-suspenders guard — see comment on setMintAddress below.
  const currentMintRef = useRef(wizard.mintAddress);
  currentMintRef.current = wizard.mintAddress; // updated on every render (safe)

  // Updaters (memoized to avoid unnecessary re-renders in children)
  //
  // GH#1263 (secondary guard): Only reset mintExistsOnNetwork when the mint address
  // *actually* changed.  The primary fix is in StepTokenSelect's
  // debounce (it no longer calls onMintChange when the value is the same), but this
  // guard provides an extra safety net in case any other code path calls us with the
  // same value.  Without it, a spurious call resets mintExistsOnNetwork to false even
  // though on-chain validation already succeeded — permanently disabling Continue.
  const setMintAddress = useCallback((mint: string) => {
    if (currentMintRef.current === mint) return; // no-op if address unchanged
    setWizard((prev) => ({
      ...prev,
      mintAddress: mint,
      // A different token invalidates every detection result, and `adminPrice`
      // above all. pickInitialPrice deliberately KEEPS the last known price
      // rather than downgrading to nothing — correct across polls of the same
      // token, catastrophic across tokens, because the launch gate would then
      // pass using the PREVIOUS token's price. A wrong opening price is not
      // cosmetic: it permanently mis-sizes maxFillAbs/maxInventoryAbs (see the
      // note in getOracleFeedAndPrice). Clearing here is what makes the
      // never-downgrade rule safe.
      adminPrice: null,
      dexPool: null,
      oracleType: "admin",
      oracleFeed: "",
      marginSetByUser: false,
      lpSetByUser: false,
    }));
    // Reset network validation only on a genuine address change.
    setMintExistsOnNetwork(false);
  }, []);

  const setTokenMeta = useCallback(
    (meta: { name: string; symbol: string; decimals: number } | null) => {
      setWizard((prev) => ({ ...prev, tokenMeta: meta }));
    },
    []
  );

  const setWalletBalance = useCallback((balance: bigint | null) => {
    setWizard((prev) => ({ ...prev, walletBalance: balance }));
  }, []);

  // Mock-mode wallet-balance override. As soon as token metadata is
  // available, fake a "3,000 token" balance so the Step 1 token panel
  // renders as a funded wallet. No effect in production (isMockMode()
  // returns false without ?mock=1).
  useEffect(() => {
    if (!mockBypass) return;
    const decimals = wizard.tokenMeta?.decimals ?? 6;
    const mockAtoms = BigInt(3000) * BigInt(10) ** BigInt(decimals);
    setWizard((prev) => ({ ...prev, walletBalance: mockAtoms }));
  }, [mockBypass, wizard.tokenMeta?.decimals]);

  const setTradingFeeBps = useCallback((bps: number) => {
    setWizard((prev) => ({ ...prev, tradingFeeBps: bps }));
  }, []);

  const setInitialMarginBps = useCallback((bps: number) => {
    setWizard((prev) => ({ ...prev, initialMarginBps: bps, marginSetByUser: true }));
  }, []);

  const setLpCollateral = useCallback((val: string) => {
    setWizard((prev) => ({ ...prev, lpCollateral: val, lpSetByUser: true }));
  }, []);

  const setInsuranceAmount = useCallback((val: string) => {
    setWizard((prev) => ({ ...prev, insuranceAmount: val }));
  }, []);

  // Launch market (or resume from a stuck slab when resumeFromStep is set)
  const handleLaunch = () => {
    if (!allValid || !oracleSettled || !publicKey) return;
    const { oracleFeed, priceE6 } = getOracleFeedAndPrice();
    // PERC-470 security: block hyperp launch without valid DEX price
    if (wizard.oracleType === "hyperp_ema" && priceE6 === 0n) {
      alert("Cannot create market: no DEX price available for this token. Try again or switch to Admin oracle.");
      return;
    }
    // C-10: block admin/keeper launch if initial oracle price is 0 or unset.
    // InitMarket rejects priceE6=0 on-chain; guard here for a cleaner error.
    if ((wizard.oracleType === "admin" || wizard.oracleType === "keeper") && priceE6 === 0n) {
      alert("Cannot create market: enter a valid initial oracle price greater than 0.");
      return;
    }

    // PERC-470: Map wizard oracle type to CreateMarketParams oracleMode
    // "keeper" = AUTH_MARK oracle with oracle_authority delegated to keeper service
    const oracleMode = wizard.oracleType === "pyth" ? "pyth" as const
      : wizard.oracleType === "hyperp_ema" ? "hyperp" as const
      : wizard.oracleType === "keeper" ? "keeper" as const
      : "admin" as const;

    // For hyperp markets the index asset is the DEX pool's base token (e.g. SOL),
    // not the collateral mint (e.g. USDC). Use baseSymbol/quoteSymbol from the pool
    // result to build a proper symbol ("SOL") and name ("SOL/USDC Perpetual").
    // Fall back to tokenMeta for non-hyperp (Pyth / admin oracle) markets.
    // resolveMarketMetadata: the value the memo and the registration payload both carry; a name
    // with no Latin characters falls back to the symbol, a non-ASCII symbol to the mint's short form.
    const { symbol: marketSymbol, name: marketName } = resolveMarketMetadata({
      symbol: oracleMode === "hyperp" && wizard.dexPool ? wizard.dexPool.baseSymbol : wizard.tokenMeta?.symbol,
      name: oracleMode === "hyperp" && wizard.dexPool
        ? `${wizard.dexPool.baseSymbol}/${wizard.dexPool.quoteSymbol} Perpetual`
        : wizard.tokenMeta?.name,
      mint: wizard.mintAddress,
    });

    const params: CreateMarketParams = {
      mint: new PublicKey(collateralMintAddress),
      initialPriceE6: priceE6,
      lpCollateral: parseHumanAmount(wizard.lpCollateral || "0", decimals),
      insuranceAmount: parseHumanAmount(wizard.insuranceAmount, decimals),
      oracleFeed,
      invert: false,
      tradingFeeBps: wizard.tradingFeeBps,
      initialMarginBps: wizard.initialMarginBps,
      lpExposureBps: clampLpExposureBps(wizard.lpExposureBps),
      // BUG 1 fix: don't override the DEFAULT_SLAB_SIZE fallback — InitMarket always
      // encodes maxPortfolioAssets:14, so the slab MUST be exactly v17MarketAccountLen(14)
      // regardless of anything the wizard used to let the user pick, or InitMarket reverts
      // with InvalidSlabLen (and over-charges rent in the process). v17 has no slab tiers —
      // maxAccounts is deliberately omitted here (create() defaults it).
      slabDataSize: DEFAULT_SLAB_SIZE,
      // P3: vault-owned LP + the creator's junior tranche (= the Liquidity amount).
      p3: wizardP3Params(
        p3WizardEnabled(),
        parseHumanAmount(wizard.lpCollateral || "0", decimals),
        wizard.juniorFloorBps ?? DEFAULT_JUNIOR_FLOOR_BPS,
      ),
      symbol: marketSymbol,
      name: marketName,
      decimals,
      // Base token CA — used by the keeper for pricing + metadata, always distinct from
      // the Sim-USDC collateral mint now. Set unconditionally (previously only set when
      // collateral differed from the entered mint, back when a non-mirrored custom token
      // could BE the collateral itself).
      mainnetCA: wizard.mintAddress,
      oracleMode,
      // PERC-470/#811: Pass DEX pool address for hyperp mode.
      // wizard.dexPool is set when auto-detection finds a pool.
      // For auto-launch, poolInfo may be null while oracleFeed holds the pool address —
      // use oracleFeed as fallback ONLY when it's a valid base58 pubkey (pool address),
      // not a Pyth feed hex64 — prevents confusing on-chain rejection (security LOW fix).
      ...(oracleMode === "hyperp" ? {
        dexPoolAddress: wizard.dexPool?.poolAddress ??
          (isValidBase58Pubkey(wizard.oracleFeed) ? wizard.oracleFeed : undefined),
      } : {}),
      // Keeper oracle: pass mainnet pool address + dex type for keeper registration.
      // The oracleFeed field holds the pool address in keeper mode (same as hyperp).
      ...(oracleMode === "keeper" ? {
        dexPoolAddress: wizard.dexPool?.poolAddress ??
          (isValidBase58Pubkey(wizard.oracleFeed) ? wizard.oracleFeed : undefined),
        dexType: wizard.dexPool?.dexType,
      } : {}),
    };
    // PERC-513: If resuming from a stuck slab, skip slab creation (step 0).
    // The existing slab keypair is already in slabKpRef (loaded from localStorage).
    const gate = gateChainResume();
    if (!gate.ok) return;
    create(applyRecoveredLaunch(params, gate.resume), resumeFromStep ?? undefined);
  };

  // Retry from failed step
  const handleRetry = () => {
    if (!configValid || !publicKey) return;
    // For step > 0, slab address must be known to resume the transaction chain.
    // Step 0 generates a fresh keypair, so slabAddress is not required for step 0 retry.
    // Without this guard, a blockhash-expiry error on step 0 would silently no-op when
    // the user clicks "Retry Step 1" (slabAddress is null until sendTx succeeds).
    if (createState.step > 0 && !createState.slabAddress) return;
    const { oracleFeed, priceE6 } = getOracleFeedAndPrice();

    // PERC-470: Include oracleMode + dexPoolAddress in retry params (fixes #810)
    const oracleMode = wizard.oracleType === "pyth" ? "pyth" as const
      : wizard.oracleType === "hyperp_ema" ? "hyperp" as const
      : wizard.oracleType === "keeper" ? "keeper" as const
      : "admin" as const;

    // Same symbol/name derivation as handleLaunch — hyperp uses DEX base/quote symbols.
    const { symbol: retryMarketSymbol, name: retryMarketName } = resolveMarketMetadata({
      symbol: oracleMode === "hyperp" && wizard.dexPool ? wizard.dexPool.baseSymbol : wizard.tokenMeta?.symbol,
      name: oracleMode === "hyperp" && wizard.dexPool
        ? `${wizard.dexPool.baseSymbol}/${wizard.dexPool.quoteSymbol} Perpetual`
        : wizard.tokenMeta?.name,
      mint: wizard.mintAddress,
    });

    const params: CreateMarketParams = {
      mint: new PublicKey(collateralMintAddress),
      initialPriceE6: priceE6,
      lpCollateral: parseHumanAmount(wizard.lpCollateral || "0", decimals),
      insuranceAmount: parseHumanAmount(wizard.insuranceAmount, decimals),
      oracleFeed,
      invert: false,
      tradingFeeBps: wizard.tradingFeeBps,
      initialMarginBps: wizard.initialMarginBps,
      lpExposureBps: clampLpExposureBps(wizard.lpExposureBps),
      // BUG 1 fix: same rationale as handleLaunch above — always the real v17 slab size.
      slabDataSize: DEFAULT_SLAB_SIZE,
      // P3: vault-owned LP + the creator's junior tranche (= the Liquidity amount).
      p3: wizardP3Params(
        p3WizardEnabled(),
        parseHumanAmount(wizard.lpCollateral || "0", decimals),
        wizard.juniorFloorBps ?? DEFAULT_JUNIOR_FLOOR_BPS,
      ),
      symbol: retryMarketSymbol,
      name: retryMarketName,
      decimals,
      // See handleLaunch's mainnetCA comment — set unconditionally now.
      mainnetCA: wizard.mintAddress,
      oracleMode,
      // PERC-470/#811: Same fallback as handleLaunch — oracleFeed holds pool address
      // when wizard.dexPool is null.
      // Guard: only use oracleFeed as fallback if it's a valid base58 pubkey (pool address).
      ...(oracleMode === "hyperp" ? {
        dexPoolAddress: wizard.dexPool?.poolAddress ??
          (isValidBase58Pubkey(wizard.oracleFeed) ? wizard.oracleFeed : undefined),
      } : {}),
      ...(oracleMode === "keeper" ? {
        dexPoolAddress: wizard.dexPool?.poolAddress ??
          (isValidBase58Pubkey(wizard.oracleFeed) ? wizard.oracleFeed : undefined),
        dexType: wizard.dexPool?.dexType,
      } : {}),
    };
    const gate = gateChainResume();
    if (!gate.ok) return;
    create(applyRecoveredLaunch(params, gate.resume), createState.step);
  };

  // Retry ONLY the keeper-register step for an already-live market (LaunchSuccess's
  // "Retry registration" action — see useCreateMarket.ts's retryKeeperRegistration
  // BUG FIX comment). Deliberately does not touch on-chain state — the market is
  // already fully created; this just re-signs the stateless deployer proof and
  // re-POSTs it. Mirrors the same dexPoolAddress/dexType/symbol derivation used
  // for the "keeper" oracle branch in handleLaunch/handleRetry above.
  const handleRetryKeeperRegistration = useCallback(async () => {
    if (!createState.slabAddress) return;
    const dexPoolAddress = wizard.dexPool?.poolAddress ??
      (isValidBase58Pubkey(wizard.oracleFeed) ? wizard.oracleFeed : undefined);
    if (!dexPoolAddress) return;
    await retryKeeperRegistration({
      slabAddress: createState.slabAddress,
      mainnetCA: wizard.mintAddress,
      dexPoolAddress,
      dexType: wizard.dexPool?.dexType ?? null,
      symbol: resolveMarketMetadata({ symbol: wizard.tokenMeta?.symbol, mint: wizard.mintAddress }).symbol,
    });
  }, [createState.slabAddress, wizard.dexPool, wizard.oracleFeed, wizard.mintAddress, wizard.tokenMeta, retryKeeperRegistration]);

  // Reset wizard completely
  // Issue #1141: Re-apply initialMint from URL param so 'Clear & Start Fresh'
  // doesn't lose the ?mint= address the user navigated here with.
  const handleReset = () => {
    // Keep the in-flight record: Start Over only resets this tab. A market that reached the
    // chain stays recoverable from RecoverSolBanner (RESUME / RECLAIM), as the LaunchProgress
    // recovery copy promises; deleting it stays an explicit Discard on that card. Re-read the
    // records so RESUME on a market started this session finds its keypair in stuckSlabs.
    // `?.` like `stuckSlabs?.find` below: some test mocks of useStuckSlabs omit it.
    refreshStuckSlabs?.();
    resetCreate();
    setWizard({ ...DEFAULT_STATE, mintAddress: initialMint ?? "" });
    setCompletedSteps(new Set());
    // PERC-516: Clear persisted wizard state
    try { localStorage.removeItem(WIZARD_STORAGE_KEY); } catch {}
    setResumeFromStep(null);
  };

  // --- Render ---

  // PERC-516: Clear persisted state on success so a refresh doesn't show stale wizard
  // GH#1761 (legacy): also clear when insuranceMintFailed — kept for backwards compat,
  // never set true by create() anymore (see useCreateMarket.ts's field comment).
  // Success is step 6 (0-indexed steps 0-5: slab/init, oracle, LP, deposit/insurance,
  // Earn vault, stake pool — see STEP_LABELS in useCreateMarket.ts).
  useEffect(() => {
    if ((createState.step >= 6 || createState.insuranceMintFailed) && createState.slabAddress) {
      try {
        localStorage.removeItem(WIZARD_STORAGE_KEY);
        localStorage.removeItem("percolator-pending-slab-keypair");
      } catch {}
      // Clear the in-flight recovery state — market is live, no recovery needed.
      clearInFlightMarket(createState.slabAddress);
    }
  }, [createState.step, createState.insuranceMintFailed, createState.slabAddress]);

  // Show success when all 6 on-chain steps complete (0-5: slab/init, oracle, LP,
  // deposit/insurance, Earn vault, stake pool). GH#1761's insuranceMintFailed
  // fallback is kept for backwards compat but is never set true anymore — the
  // Earn vault / stake pool steps use the same hard-error/retry path as every
  // other step (see useCreateMarket.ts's field comment for why).
  const isSuccess = (createState.step >= 6 || createState.insuranceMintFailed) && !!createState.slabAddress;

  // Success state
  if (isSuccess) {
    return (
      <LaunchSuccess
        tokenSymbol={symbol}
        tradingFeeBps={wizard.tradingFeeBps}
        maxLeverage={maxLeverage}
        marketAddress={createState.slabAddress!}
        txSigs={createState.txSigs}
        onDeployAnother={handleReset}
        mainnetCA={wizard.mintAddress}
        devnetMint={createState.devnetMint}
        insuranceMintFailed={createState.insuranceMintFailed}
        backingSeedFailed={createState.backingSeedFailed}
        keeperDelegated={createState.keeperDelegated}
        keeperMessage={createState.keeperMessage}
        keeperRegistering={createState.keeperRegistering}
        onRetryKeeperRegistration={handleRetryKeeperRegistration}
        priceFeedRequired={createState.priceFeedRequired}
        keeperPhase={createState.keeperPhase ?? null}
      />
    );
  }

  // Launch progress
  if (createState.loading || createState.step > 0 || createState.error) {
    return (
      <>
        {/* A Retry refused by the chain-resume gate must say why here too: this view replaces the main one. */}
        <ChainResumeNotice message={chainResumeError} />
        <LaunchProgress
          state={createState}
          onReset={handleReset}
          onRetry={handleRetry}
        />
      </>
    );
  }

  // Demo launch progress (mock mode only) — fake the 5-step deploy then
  // redirect to the BONK mock trade page.
  if (demoLaunch.active) {
    return (
      <LaunchProgress
        state={{
          step: demoLaunch.step,
          loading: demoLaunch.step < DEMO_STEPS.length,
          error: null,
          slabAddress: demoLaunch.step >= DEMO_STEPS.length
            ? DEMO_BONK_SLAB
            : null,
          txSigs: demoLaunch.txSigs,
          stepLabel: DEMO_STEPS[Math.min(demoLaunch.step, DEMO_STEPS.length - 1)],
        }}
        onReset={() => setDemoLaunch({ active: false, step: 0, txSigs: [] })}
      />
    );
  }

  // Pre-flight readouts for the Control Room panel
  const oracleLabel = !oracleSettled
    ? "Resolving…"
    : wizard.oracleType === "pyth" && wizard.pythFeed
      ? wizard.pythFeed.name
      : wizard.oracleType === "hyperp_ema" && wizard.dexPool
        ? `${wizard.dexPool.pairLabel} (${wizard.dexPool.dexLabel ?? wizard.dexPool.dexId})`
        : wizard.oracleType === "keeper" && wizard.dexPool
          ? `Keeper: ${wizard.dexPool.pairLabel} (${wizard.dexPool.dexLabel ?? wizard.dexPool.dexId})`
          : wizard.oracleType === "keeper" && wizard.oracleFeed
            ? `Keeper: ${wizard.oracleFeed.slice(0, 12)}...`
            : wizard.oracleType === "admin"
              ? "Admin Oracle"
              : wizard.oracleFeed
                ? `${wizard.oracleFeed.slice(0, 12)}...`
                : "Not configured";

  const startPrice = formatMarkPrice(wizard.adminPrice ? Number(wizard.adminPrice) : null);

  const stepLabels: readonly [string, string] = ["Token", "Market"];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* #3267: continue an unfinished launch started on another device, rebuilt from chain. */}
      {resumeSlabParam && resumeFromStep === null && (
        <ResumeFromChainCard
          slab={resumeSlabParam}
          onVerified={(launch, step) => {
            // Only the slab ADDRESS is needed past step 0 (the keypair never left the launching browser).
            restoreSlabAddress(resumeSlabParam);
            setChainResume(launch);
            // Put the verified values in the form the wizard reads, and mark them user-set so detection
            // does not move them (the pinned params above are the final authority).
            setWizard((prev) => ({
              ...prev,
              mintAddress: launch.request.mainnetCA ?? prev.mintAddress,
              tradingFeeBps: launch.tradingFeeBps,
              initialMarginBps: launch.initialMarginBps,
              marginSetByUser: true,
              lpCollateral: atomsToHuman(launch.lpCollateralAtoms, 6),
              lpSetByUser: true,
              ...(launch.lpExposureBps != null ? { lpExposureBps: launch.lpExposureBps } : {}),
              ...(launch.onChainInsuranceAtoms != null && launch.onChainInsuranceAtoms > 0n
                ? { insuranceAmount: atomsToHuman(launch.onChainInsuranceAtoms, 6) }
                : {}),
            }));
            setResumeFromStep(step);
            setResumeSlab(resumeSlabParam);
          }}
        />
      )}

      {/* Stuck slab recovery banner */}
      <RecoverSolBanner
        onReset={handleReset}
        resumingSlab={resumeFromStep !== null ? resumeSlab : null}
        onResume={(slabAddress, fromStep) => {
          // PERC-513 fix: DO NOT call resetCreate() here — that clears slabKpRef
          // and removes the localStorage keypair, making the Continue button a no-op.
          // BUG 7 fix: useCreateMarket's mount effect already hydrates slabKpRef from
          // localStorage in the common case, but hand our own useStuckSlabs()-reconstructed
          // keypair (see above) to the hook too — belt-and-suspenders against any race where
          // the mount effect hasn't run yet (e.g. wallet just connected this render).
          //
          // W7 fix (2026-07-08): search the FULL stuckSlabs list, not just the singular
          // most-recent `stuckSlab` — the mount effect and `stuckSlab` both only ever
          // point at the most-recently-touched in-flight market, but RecoverSolBanner
          // can now surface a RESUME click for ANY of them. Falling back to `stuckSlab`
          // keeps this working even against a test/mocked hook that doesn't supply
          // `stuckSlabs`.
          // A chain resume's guard for another slab must not survive into this local resume, whether or not
          // the keypair below is found (#3267 review).
          clearChainResume?.();
          const matched = stuckSlabs?.find((s) => s.publicKey.toBase58() === slabAddress) ?? stuckSlab;
          if (matched?.keypair && matched.publicKey.toBase58() === slabAddress) {
            restoreSlabKeypair(matched.keypair, slabAddress);
          }
          // A local resume replaces any chain resume: never apply another market's pinned parameters.
          setChainResume(null);
          setChainResumeError(null);
          // Set resumeFromStep so handleLaunch skips slab creation and resumes correctly.
          setResumeFromStep(fromStep);
          setResumeSlab(slabAddress);
        }}
        onReclaimSuccess={() => {
          // Clear wizard localStorage state so the user starts completely fresh
          // after a successful reclaim. Without this the form would repopulate with
          // the old token/oracle/parameter values from the failed attempt.
          try {
            localStorage.removeItem(WIZARD_STORAGE_KEY);
          } catch {
            // localStorage unavailable — non-critical
          }
          setWizard({ ...DEFAULT_STATE });
          setResumeFromStep(null);
          setCompletedSteps(new Set());
          resetCreate();
        }}
      />

      {/* PERC-513: Resume mode indicator — shown when user clicked "Resume Creation" from the banner */}
      {resumeFromStep !== null && (
        <div
          ref={resumeBannerRef}
          className="border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-4 py-3 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2">
            <span className="text-[var(--accent)] text-[12px]">⚡</span>
            <span className="text-[11px] text-[var(--text-secondary)]">
              <span className="font-semibold text-[var(--accent)]">Resume mode</span>
              {" — "}
              {/* W1 fix (2026-07-08): resumeFromStep now carries the real
                  stuckSlab.lastStep (0-6), not just 0 or 1 — reflect that instead of
                  a binary "retry vs. complete" message that was wrong for anything
                  past Step 1 (e.g. resuming after LP init or deposit already landed). */}
              {resumeFromStep === 0
                ? "Re-enter your parameters to retry market initialization."
                : chainResume
                  ? `Rebuilt from the chain and checked against this launch's signed registration. It resumes at step ${resumeFromStep} of 6 and skips what already landed. Continue to review and launch.`
                  : `The market is set up through step ${resumeFromStep} of 6. Re-enter your parameters to resume from where you left off.`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setResumeFromStep(null);
              setChainResume(null);
              setChainResumeError(null);
              resetCreate();
            }}
            className="flex-shrink-0 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors px-2 py-1 border border-[var(--border)]"
          >
            CANCEL
          </button>
        </div>
      )}

      <ChainResumeNotice message={chainResumeError} />

      {/* Progress indicator */}
      <WizardProgress
        currentStep={wizard.step}
        completedSteps={completedSteps}
        stepLabels={stepLabels}
        onStepClick={(step) => {
          // WizardProgress is intentionally arity-agnostic (see its
          // stepLabels doc), so narrow back to this wizard's own step union
          // here rather than re-hard-typing the shared component.
          if (step !== 1 && step !== 2) return;
          if (completedSteps.has(step)) goToStep(step);
        }}
      />

      {/* Step panel */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-5 sm:p-6">
        {/* Step header */}
        <div className="mb-5 pb-4 border-b border-[var(--border)]">
          <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">
            STEP {wizard.step} / {stepLabels.length} — {stepLabels[wizard.step - 1]}
          </p>
        </div>

        {/* Step 1: Token */}
        {wizard.step === 1 && (
          <StepTokenSelect
            mintAddress={wizard.mintAddress}
            onMintChange={setMintAddress}
            onTokenResolved={setTokenMeta}
            onBalanceChange={setWalletBalance}
            onMintNetworkValidChange={setMintExistsOnNetwork}
            onContinue={() => {
              if (!step1CanAdvance) return;
              quickAutoAdvancedRef.current = true;
              applyOracleAndAdvance();
            }}
            canContinue={step1CanAdvance}
            duplicateMarkets={duplicateCheck.duplicates}
          />
        )}

        {/* Step 2: Control Room — auto-resolved price feed + slab, four dials, hold-to-launch */}
        {wizard.step === 2 && (
          <StepControlRoom
            symbol={symbol}
            oracleLabel={oracleLabel}
            startPrice={startPrice}
            slabBytes={wizardSlabBytes(p3WizardEnabled())}
            rentSol={solCostBreakdown.slabRentSol}
            initialMarginBps={wizard.initialMarginBps}
            tradingFeeBps={wizard.tradingFeeBps}
            lpCollateral={wizard.lpCollateral}
            insuranceAmount={wizard.insuranceAmount}
            collateralSymbol={collateralSymbol}
            seedTotal={Number(totalTokensRequired) / 10 ** decimals}
            seedBacking={Number(2n * backingSeedPerDomain(parseHumanAmount(wizard.lpCollateral || "0", decimals))) / 10 ** decimals}
            onMarginBpsChange={setInitialMarginBps}
            onLpCollateralChange={setLpCollateral}
            onInsuranceChange={setInsuranceAmount}
            lpExposureBps={clampLpExposureBps(wizard.lpExposureBps)}
            onLpExposureChange={(bps) => setWizard((prev) => ({ ...prev, lpExposureBps: clampLpExposureBps(bps) }))}
            p3={p3WizardEnabled()}
            // While the lookup is still resolving the readout says "Resolving…", not "No supported pool".
            registrable={registrable || !oracleSettled}
            notRegistrableReason={notRegistrableReason}
            juniorFloorBps={wizard.juniorFloorBps ?? DEFAULT_JUNIOR_FLOOR_BPS}
            onJuniorFloorChange={(bps) => setWizard((prev) => ({ ...prev, juniorFloorBps: bps }))}
            onLaunch={handleLaunch}
            launchDisabled={launchDisabled}
            launchDisabledReason={launchDisabledReason}
            instantLaunch={mockBypass}
            onBack={goBack}
          />
        )}
      </div>
    </div>
  );
};
