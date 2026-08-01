"use client";

import { FC, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  useCreateMarket,
  DEFAULT_SLAB_SIZE,
  flooredInitialMarginBps,
  type CreateMarketParams,
} from "@/hooks/useCreateMarket";
import { useStuckSlabs } from "@/hooks/useStuckSlabs";
import { clearInFlightMarket } from "@/lib/inFlightMarket";
import { useQuickLaunch } from "@/hooks/useQuickLaunch";
import { type DexPoolResult } from "@/hooks/useDexPoolSearch";
import { parseHumanAmount } from "@/lib/parseAmount";
import { getConfig, getNetwork } from "@/lib/config";
import { toE6, formatMarkPrice } from "@/lib/format";

import { useDuplicateMarket } from "@/hooks/useDuplicateMarket";
import { WizardProgress } from "./WizardProgress";
import { StepTokenSelect } from "./StepTokenSelect";
import { StepControlRoom, leverageToMarginBps, marginBpsToLeverage } from "./StepControlRoom";
import { LaunchProgress } from "./LaunchProgress";
import { LaunchSuccess } from "./LaunchSuccess";
import { RecoverSolBanner } from "./RecoverSolBanner";
// W8 fix: share ONE SOL-cost formula with CostEstimate.tsx's own display so the
// launch gate and the number shown to the user can never drift apart — see that
// file's computeCreateMarketSolCost doc comment.
import { computeCreateMarketSolCost } from "./CostEstimate";
import { isValidBase58Pubkey } from "@/lib/createWizardUtils";
import { isMockMode } from "@/lib/mock-mode";

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
  insuranceAmount: string;
  adminPrice: string | null;
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
  // The dial's leverage range floors to MIN_SAFE_INITIAL_MARGIN_BPS (1500 = 6.67x) —
  // 2000 bps (5x) is the highest default we can promise without it being a lie once
  // create() applies that floor on-chain. See StepControlRoom's MAX_LEVERAGE comment.
  initialMarginBps: 2000,
  lpCollateral: "",
  insuranceAmount: "100",
  adminPrice: null,
};

/**
 * Market Creation Wizard — the "Control Room" flow.
 * Step 1: Token → Step 2: Control Room (auto-resolved price feed + slab size,
 * four dials for leverage/fee/liquidity/insurance, hold-to-launch).
 * There is no mode toggle and no slab-tier picker — v17 has exactly one slab
 * size (max capacity) and oracle detection is always automatic.
 */
export const CreateMarketWizard: FC<{ initialMint?: string }> = ({ initialMint }) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { state: createState, create, reset: resetCreate, restoreSlabKeypair, retryKeeperRegistration } = useCreateMarket();
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
  const { stuckSlab, stuckSlabs } = useStuckSlabs();

  // PERC-516: Persist wizard state to localStorage so form survives page refresh.
  // This fixes the "Continue button does nothing" bug — without persisted state,
  // allValid is false after refresh because all fields are empty.
  const WIZARD_STORAGE_KEY = "percolator-wizard-state";
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
          // DexPoolResult is a plain object, survives JSON
          dexPool: parsed.dexPool ?? null,
          pythFeed: parsed.pythFeed ?? null,
          tokenMeta: parsed.tokenMeta ?? null,
          // initialMint prop overrides persisted mint
          mintAddress: initialMint ?? parsed.mintAddress ?? "",
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

  // SOL balance for the Control Room's launch gate.
  // In mock mode (?mock=1), force a funded-looking value (8.5 SOL) so
  // captures don't show "Insufficient SOL" regardless of the connected
  // wallet's real balance.
  const [solBalance, setSolBalance] = useState<number | null>(null);
  useEffect(() => {
    if (isMockMode()) { setSolBalance(8.5); return; }
    if (!publicKey || !connection) { setSolBalance(null); return; }
    let cancelled = false;
    connection.getBalance(publicKey).then((lamports) => {
      if (!cancelled) setSolBalance(lamports / 1_000_000_000);
    }).catch(() => { if (!cancelled) setSolBalance(null); });
    return () => { cancelled = true; };
  }, [publicKey, connection]);

  // Apply auto-detected defaults to the dials (fee, margin, collateral, price)
  useEffect(() => {
    if (!quickLaunch.config) return;
    setWizard((prev) => ({
      ...prev,
      tradingFeeBps: quickLaunch.config!.tradingFeeBps,
      // Normalise through the dial's own quantisation so the number ON the dial is
      // exactly the number written on-chain. quick-launch still supplies 1000 bps
      // ("10x"); create() floors that to MIN_SAFE_INITIAL_MARGIN_BPS (1500 = 6.67x),
      // but the dial snaps to 0.5x and can only render 6.5x — so storing either the
      // raw 1000 or a plain floor of 1500 would display 6.5x while actually creating
      // a 6.67x market. Round-tripping bps → leverage → bps lands on 1538 bps, which
      // IS 6.5x. Same class of lie as the old "10x" readout; closed here.
      initialMarginBps: leverageToMarginBps(
        marginBpsToLeverage(quickLaunch.config!.initialMarginBps),
      ),
      lpCollateral: quickLaunch.config!.lpCollateral,
      // Apply detected oracle price as adminPrice (used if oracle ends up admin)
      adminPrice: quickLaunch.config!.initialPrice || prev.adminPrice,
    }));
  }, [quickLaunch.config]);

  // Derived values
  const mintValid = isValidBase58Pubkey(wizard.mintAddress) && wizard.mintAddress.length >= 32;
  // BUG 16 fix: use the FLOORED margin (what create() actually enforces on-chain via
  // MIN_SAFE_INITIAL_MARGIN_BPS) so the success screen advertises real leverage, not the
  // raw requested value the dial produced.
  const maxLeverage = Math.floor(10000 / flooredInitialMarginBps(wizard.initialMarginBps));
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
  const totalTokensRequired = useMemo((): bigint => {
    const lpRaw = parseHumanAmount(wizard.lpCollateral || "0", decimals);
    const insRaw = parseHumanAmount(wizard.insuranceAmount, decimals);
    return lpRaw + insRaw;
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
  const step1CanAdvance = step1Valid && !duplicateCheck.checking && duplicateCheck.duplicates.length === 0;

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
  const solCostBreakdown = useMemo(() => computeCreateMarketSolCost(), []);
  const requiredSol = solCostBreakdown.totalSolCost;
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
      const dexPrice = wizard.dexPool?.priceUsd;
      if (!dexPrice || dexPrice <= 0) {
        // Security: don't default to $1 — require a real price for hyperp mode
        return { oracleFeed: "0".repeat(64), priceE6: 0n };
      }
      const priceE6 = toE6(dexPrice);
      return { oracleFeed: "0".repeat(64), priceE6 };
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
    const price = parseFloat(wizard.adminPrice ?? "");
    const priceE6 = Number.isFinite(price) && price > 0 ? toE6(price) : 0n;
    return { oracleFeed: "0".repeat(64), priceE6 };
  };

  // Pyth doesn't rely on a client-computed priceE6 (the on-chain feed supplies it), so it's
  // always "ready." Hyperp/admin/keeper all need a nonzero detected price before launching.
  const { priceE6: currentPriceE6 } = getOracleFeedAndPrice();
  const oraclePriceValid = wizard.oracleType === "pyth" ? true : currentPriceE6 !== 0n;

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
  const resolvedOracleType: "pyth" | "hyperp_ema" | "admin" | "keeper" =
    quickLaunch.oracleType === "pyth" && quickLaunch.pythFeedId
      ? "pyth"
      : quickLaunch.oracleType === "hyperp_ema" && quickLaunch.dexPoolAddress
        ? isDevnet
          ? "keeper"
          : "hyperp_ema"
        : "admin";
  const registrable = !isDevnet || resolvedOracleType === "keeper";
  const notRegistrableReason = registrable
    ? null
    : (quickLaunch.error ??
      "This token has no supported DEX pool (Pump.fun or Meteora), so the keeper " +
        "cannot price it. A market launched now would never be listed or priced. " +
        "Pick a token that trades on a supported pool.");


  const allValid =
    // Never let an unregistrable market reach the launch button.
    registrable &&
    step1Valid &&
    paramsValid &&
    oraclePriceValid &&
    (skipTokenBalanceCheck || (hasTokens && hasSufficientTokensForSeed)) &&
    (mockBypass || hasSufficientSol);

  const launchDisabled = !allValid || !publicKey;
  const launchDisabledReason: string | undefined = !publicKey
    ? "Connect wallet"
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
              ? "Waiting on price feed"
              : !mockBypass && !hasSufficientSol
                ? `Need ~${requiredSol.toFixed(3)} SOL`
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
    setWizard((prev) => {
      const base = { ...prev, step: 2 as WizardStep };
      if (quickLaunch.oracleType === "pyth" && quickLaunch.pythFeedId) {
        return {
          ...base,
          oracleType: "pyth" as const,
          oracleFeed: quickLaunch.pythFeedId,
          adminPrice: quickLaunch.adminPrice,
        };
      }
      // PERC-470: Hyperp EMA — auto-detected DEX pool as oracle (mainnet only)
      // On devnet: DEX pool detected → use keeper oracle instead (AUTH_MARK, keeper pushes from mainnet)
      if (quickLaunch.oracleType === "hyperp_ema" && quickLaunch.dexPoolAddress) {
        // Devnet playground: keeper oracle delegates oracle_authority to our keeper service
        // which reads the mainnet DEX pool and pushes prices via PushAuthMark.
        if (isDevnet) {
          return {
            ...base,
            oracleType: "keeper" as const,
            oracleFeed: quickLaunch.dexPoolAddress,
            adminPrice: quickLaunch.adminPrice,
            dexPool: quickLaunch.poolInfo ?? null,
          };
        }
        return {
          ...base,
          oracleType: "hyperp_ema" as const,
          oracleFeed: quickLaunch.dexPoolAddress,
          adminPrice: quickLaunch.adminPrice,
          dexPool: quickLaunch.poolInfo ?? null,
        };
      }
      // Admin oracle — devnet-only or unknown token
      return {
        ...base,
        oracleType: "admin" as const,
        oracleFeed: "",
        adminPrice: quickLaunch.adminPrice,
      };
    });
  }, [quickLaunch, isDevnet]);

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
    setWizard((prev) => ({ ...prev, mintAddress: mint }));
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
    setWizard((prev) => ({ ...prev, initialMarginBps: bps }));
  }, []);

  const setLpCollateral = useCallback((val: string) => {
    setWizard((prev) => ({ ...prev, lpCollateral: val }));
  }, []);

  const setInsuranceAmount = useCallback((val: string) => {
    setWizard((prev) => ({ ...prev, insuranceAmount: val }));
  }, []);

  // Launch market (or resume from a stuck slab when resumeFromStep is set)
  const handleLaunch = () => {
    if (!allValid || !publicKey) return;
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
    const marketSymbol = oracleMode === "hyperp" && wizard.dexPool
      ? wizard.dexPool.baseSymbol
      : (wizard.tokenMeta?.symbol ?? "UNKNOWN");
    const marketName = oracleMode === "hyperp" && wizard.dexPool
      ? `${wizard.dexPool.baseSymbol}/${wizard.dexPool.quoteSymbol} Perpetual`
      : (wizard.tokenMeta?.name ?? "Unknown Token");

    const params: CreateMarketParams = {
      mint: new PublicKey(collateralMintAddress),
      initialPriceE6: priceE6,
      lpCollateral: parseHumanAmount(wizard.lpCollateral || "0", decimals),
      insuranceAmount: parseHumanAmount(wizard.insuranceAmount, decimals),
      oracleFeed,
      invert: false,
      tradingFeeBps: wizard.tradingFeeBps,
      initialMarginBps: wizard.initialMarginBps,
      // BUG 1 fix: don't override the DEFAULT_SLAB_SIZE fallback — InitMarket always
      // encodes maxPortfolioAssets:14, so the slab MUST be exactly v17MarketAccountLen(14)
      // regardless of anything the wizard used to let the user pick, or InitMarket reverts
      // with InvalidSlabLen (and over-charges rent in the process). v17 has no slab tiers —
      // maxAccounts is deliberately omitted here (create() defaults it).
      slabDataSize: DEFAULT_SLAB_SIZE,
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
        dexType: wizard.dexPool?.dexId ?? "raydium-clmm",
      } : {}),
    };
    // PERC-513: If resuming from a stuck slab, skip slab creation (step 0).
    // The existing slab keypair is already in slabKpRef (loaded from localStorage).
    create(params, resumeFromStep ?? undefined);
  };

  // Retry from failed step
  const handleRetry = () => {
    if (!allValid || !publicKey) return;
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
    const retryMarketSymbol = oracleMode === "hyperp" && wizard.dexPool
      ? wizard.dexPool.baseSymbol
      : (wizard.tokenMeta?.symbol ?? "UNKNOWN");
    const retryMarketName = oracleMode === "hyperp" && wizard.dexPool
      ? `${wizard.dexPool.baseSymbol}/${wizard.dexPool.quoteSymbol} Perpetual`
      : (wizard.tokenMeta?.name ?? "Unknown Token");

    const params: CreateMarketParams = {
      mint: new PublicKey(collateralMintAddress),
      initialPriceE6: priceE6,
      lpCollateral: parseHumanAmount(wizard.lpCollateral || "0", decimals),
      insuranceAmount: parseHumanAmount(wizard.insuranceAmount, decimals),
      oracleFeed,
      invert: false,
      tradingFeeBps: wizard.tradingFeeBps,
      initialMarginBps: wizard.initialMarginBps,
      // BUG 1 fix: same rationale as handleLaunch above — always the real v17 slab size.
      slabDataSize: DEFAULT_SLAB_SIZE,
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
        dexType: wizard.dexPool?.dexId ?? "raydium-clmm",
      } : {}),
    };
    create(params, createState.step);
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
      dexType: wizard.dexPool?.dexId ?? "raydium-clmm",
      symbol: wizard.tokenMeta?.symbol ?? "UNKNOWN",
    });
  }, [createState.slabAddress, wizard.dexPool, wizard.oracleFeed, wizard.mintAddress, wizard.tokenMeta, retryKeeperRegistration]);

  // Reset wizard completely
  // Issue #1141: Re-apply initialMint from URL param so 'Clear & Start Fresh'
  // doesn't lose the ?mint= address the user navigated here with.
  const handleReset = () => {
    // Clear in-flight recovery state for the slab the user is abandoning, if any.
    if (createState.slabAddress) {
      clearInFlightMarket(createState.slabAddress);
    }
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
        devnetAirdropAmount={createState.devnetAirdropAmount}
        devnetAirdropSymbol={createState.devnetAirdropSymbol}
        devnetMintError={createState.devnetMintError}
        insuranceMintFailed={createState.insuranceMintFailed}
        keeperDelegated={createState.keeperDelegated}
        keeperMessage={createState.keeperMessage}
        keeperRegistering={createState.keeperRegistering}
        onRetryKeeperRegistration={handleRetryKeeperRegistration}
      />
    );
  }

  // Launch progress
  if (createState.loading || createState.step > 0 || createState.error) {
    return (
      <LaunchProgress
        state={createState}
        onReset={handleReset}
        onRetry={handleRetry}
      />
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
  const oracleLabel =
    wizard.oracleType === "pyth" && wizard.pythFeed
      ? wizard.pythFeed.name
      : wizard.oracleType === "hyperp_ema" && wizard.dexPool
        ? `${wizard.dexPool.pairLabel} (${wizard.dexPool.dexId})`
        : wizard.oracleType === "keeper" && wizard.dexPool
          ? `Keeper: ${wizard.dexPool.pairLabel} (${wizard.dexPool.dexId})`
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
      {/* Stuck slab recovery banner */}
      <RecoverSolBanner
        onReset={handleReset}
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
          const matched = stuckSlabs?.find((s) => s.publicKey.toBase58() === slabAddress) ?? stuckSlab;
          if (matched?.keypair && matched.publicKey.toBase58() === slabAddress) {
            restoreSlabKeypair(matched.keypair, slabAddress);
          }
          // Set resumeFromStep so handleLaunch skips slab creation and resumes correctly.
          setResumeFromStep(fromStep);
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
        <div className="border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-4 py-3 flex items-center justify-between gap-3">
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
                : `Slab is initialized (through step ${resumeFromStep} of 6). Re-enter your parameters to resume from where you left off.`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setResumeFromStep(null);
              resetCreate();
            }}
            className="flex-shrink-0 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors px-2 py-1 border border-[var(--border)]"
          >
            CANCEL
          </button>
        </div>
      )}

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
            slabBytes={DEFAULT_SLAB_SIZE}
            rentSol={solCostBreakdown.slabRentSol}
            initialMarginBps={wizard.initialMarginBps}
            tradingFeeBps={wizard.tradingFeeBps}
            lpCollateral={wizard.lpCollateral}
            insuranceAmount={wizard.insuranceAmount}
            collateralSymbol={collateralSymbol}
            onMarginBpsChange={setInitialMarginBps}
            onLpCollateralChange={setLpCollateral}
            onInsuranceChange={setInsuranceAmount}
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
