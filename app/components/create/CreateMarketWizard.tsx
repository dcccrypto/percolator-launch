"use client";

import { FC, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useCreateMarket, MIN_INIT_MARKET_SEED, type CreateMarketParams } from "@/hooks/useCreateMarket";
import { useQuickLaunch } from "@/hooks/useQuickLaunch";
import { type DexPoolResult } from "@/hooks/useDexPoolSearch";
import { parseHumanAmount, formatHumanAmount } from "@/lib/parseAmount";
import { SLAB_TIERS, type SlabTierKey } from "@percolator/sdk";
import { getNetwork } from "@/lib/config";

import { ModeSelector } from "./ModeSelector";
import { WizardProgress } from "./WizardProgress";
import { StepTokenSelect } from "./StepTokenSelect";
import { StepOracleSelect } from "./StepOracleSelect";
import { StepParameters } from "./StepParameters";
import { StepReview } from "./StepReview";
import { LaunchProgress } from "./LaunchProgress";
import { LaunchSuccess } from "./LaunchSuccess";
import { RecoverSolBanner } from "./RecoverSolBanner";
import { SlabTierPicker } from "./SlabTierPicker";
import { isValidBase58Pubkey, isValidHex64 } from "@/lib/createWizardUtils";
import { useToast } from "@/hooks/useToast";

type WizardStep = 1 | 2 | 3 | 4;

interface WizardState {
  mode: "quick" | "manual";
  step: WizardStep;
  // Step 1
  mintAddress: string;
  tokenMeta: { name: string; symbol: string; decimals: number } | null;
  walletBalance: bigint | null;
  // Step 2
  oracleType: "pyth" | "hyperp_ema" | "admin";
  oracleFeed: string;
  dexPool: DexPoolResult | null;
  pythFeed: { id: string; name: string } | null;
  // Step 3
  slabTier: SlabTierKey;
  tradingFeeBps: number;
  initialMarginBps: number;
  lpCollateral: string;
  insuranceAmount: string;
  adminPrice: string | null;
}

const DEFAULT_STATE: WizardState = {
  mode: "quick",
  step: 1,
  mintAddress: "",
  tokenMeta: null,
  walletBalance: null,
  oracleType: "admin",
  oracleFeed: "",
  dexPool: null,
  pythFeed: null,
  // Quick mode defaults to small — cheapest tier for quick testing.
  // Manual mode users can choose their own tier (defaults to large in the picker).
  slabTier: "small",
  tradingFeeBps: 30,
  initialMarginBps: 1000,
  lpCollateral: "",
  insuranceAmount: "100",
  adminPrice: "1.000000",
};

/**
 * Market Creation Wizard — Linear 4-step flow.
 * Step 1: Token → Step 2: Oracle → Step 3: Parameters → Step 4: Review
 * Supports Quick Launch and Manual modes.
 */
export const CreateMarketWizard: FC<{ initialMint?: string }> = ({ initialMint }) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { state: createState, create, reset: resetCreate } = useCreateMarket();

  const [wizard, setWizard] = useState<WizardState>(() => ({
    ...DEFAULT_STATE,
    mintAddress: initialMint ?? "",
  }));
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());

  // Quick launch auto-detection for parameters
  const quickMintForHook = wizard.mode === "quick" && wizard.mintAddress.length >= 32 ? wizard.mintAddress : null;
  const quickLaunch = useQuickLaunch(quickMintForHook);

  // On-chain mint network validation (set by StepTokenSelect)
  const [mintExistsOnNetwork, setMintExistsOnNetwork] = useState(false);
  // Devnet mirror mint address (different from mainnet CA entered by user)
  const [devnetMintAddress, setDevnetMintAddress] = useState<string | null>(null);

  // SOL balance for cost check in review step
  const [solBalance, setSolBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!publicKey || !connection) { setSolBalance(null); return; }
    let cancelled = false;
    connection.getBalance(publicKey).then((lamports) => {
      if (!cancelled) setSolBalance(lamports / 1_000_000_000);
    }).catch(() => { if (!cancelled) setSolBalance(null); });
    return () => { cancelled = true; };
  }, [publicKey, connection]);

  // Apply quick launch defaults to parameters (fee, margin, collateral, price)
  useEffect(() => {
    if (wizard.mode !== "quick" || !quickLaunch.config) return;
    setWizard((prev) => ({
      ...prev,
      tradingFeeBps: quickLaunch.config!.tradingFeeBps,
      initialMarginBps: quickLaunch.config!.initialMarginBps,
      lpCollateral: quickLaunch.config!.lpCollateral,
      // Apply detected oracle price as adminPrice (used if oracle ends up admin)
      adminPrice: quickLaunch.config!.initialPrice || prev.adminPrice,
    }));
  }, [quickLaunch.config, wizard.mode]);

  // Derived values
  const mintValid = isValidBase58Pubkey(wizard.mintAddress) && wizard.mintAddress.length >= 32;
  const maxLeverage = Math.floor(10000 / wizard.initialMarginBps);
  const feeConflict = wizard.tradingFeeBps >= wizard.initialMarginBps;
  const hasTokens = wizard.walletBalance !== null && wizard.walletBalance > 0n;
  const hasSufficientTokensForSeed = wizard.walletBalance !== null && wizard.walletBalance >= MIN_INIT_MARKET_SEED;
  const decimals = wizard.tokenMeta?.decimals ?? 6;
  const symbol = wizard.tokenMeta?.symbol ?? "Token";

  // Step validation
  const step1Valid = mintValid && wizard.tokenMeta !== null && (wizard.tokenMeta.decimals <= 12) && mintExistsOnNetwork;
  const step2Valid = (() => {
    if (wizard.oracleType === "admin") return true;
    if (wizard.oracleType === "pyth") return isValidHex64(wizard.oracleFeed);
    if (wizard.oracleType === "hyperp_ema") return isValidBase58Pubkey(wizard.oracleFeed);
    return false;
  })();
  const step3Valid =
    wizard.tradingFeeBps >= 1 &&
    wizard.tradingFeeBps <= 1000 &&
    wizard.initialMarginBps >= 100 &&
    !feeConflict &&
    parseFloat(wizard.lpCollateral || "0") > 0 &&
    parseFloat(wizard.insuranceAmount) >= 100;
  // Calculate actual SOL required based on slab tier (matching CostEstimate logic)
  const requiredSol = useMemo(() => {
    const tier = SLAB_TIERS[wizard.slabTier];
    const RENT_PER_BYTE = 6960;
    const RENT_OVERHEAD_BYTES = 128;
    const LAMPORTS_PER_SOL = 1_000_000_000;
    const TX_FEE_ESTIMATE_SOL = 0.025;
    const slabRentSol = Math.ceil((tier.dataSize + RENT_OVERHEAD_BYTES) * RENT_PER_BYTE) / LAMPORTS_PER_SOL;
    const tokenAccountRentSol = (165 * 3 + 82 * 2) * RENT_PER_BYTE / LAMPORTS_PER_SOL;
    return slabRentSol + tokenAccountRentSol + TX_FEE_ESTIMATE_SOL;
  }, [wizard.slabTier]);
  const hasSufficientSol = solBalance !== null && solBalance >= requiredSol;
  // On devnet, tokens are auto-airdropped after market creation — skip token balance checks
  const isDevnet = getNetwork() === "devnet";
  const allValid = step1Valid && step2Valid && step3Valid && (isDevnet || (hasTokens && hasSufficientTokensForSeed)) && hasSufficientSol;

  // Quick Launch auto-advance: step 1 → step 2 when token is resolved and params ready
  const quickAutoAdvancedRef = useRef(false);
  useEffect(() => {
    if (wizard.mode !== "quick") { quickAutoAdvancedRef.current = false; return; }
    if (quickAutoAdvancedRef.current) return;
    if (wizard.step !== 1) return;
    if (!step1Valid) return;
    if (quickLaunch.loading) return;
    if (!quickLaunch.config) return;

    quickAutoAdvancedRef.current = true;
    setCompletedSteps((prev) => new Set(prev).add(1));
    setWizard((prev) => ({ ...prev, step: 2 as WizardStep }));
  }, [wizard.mode, wizard.step, step1Valid, quickLaunch.loading, quickLaunch.config]);

  // Quick Launch: step 2 is slab selection (NOT oracle).
  // Oracle is resolved from useQuickLaunch and applied when user clicks Continue.
  // No auto-advance from step 2 — user must explicitly choose a slab tier.

  // Navigation
  const goToStep = useCallback((step: WizardStep) => {
    setWizard((prev) => ({ ...prev, step }));
  }, []);

  const advanceStep = useCallback(
    (fromStep: WizardStep) => {
      setCompletedSteps((prev) => new Set(prev).add(fromStep));
      if (fromStep < 4) {
        setWizard((prev) => ({ ...prev, step: (fromStep + 1) as WizardStep }));
      }
    },
    []
  );

  const goBack = useCallback(() => {
    setWizard((prev) => {
      // In quick mode, step 4 (review) goes back to step 2 (slab) — skip oracle step
      if (prev.mode === "quick" && prev.step === 4) {
        return { ...prev, step: 2 as WizardStep };
      }
      return { ...prev, step: Math.max(1, prev.step - 1) as WizardStep };
    });
  }, []);

  // Quick Launch: user confirms slab tier → apply oracle from hook → jump to review (step 4)
  const handleQuickSlabContinue = useCallback(() => {
    setCompletedSteps((prev) => {
      const next = new Set(prev);
      next.add(2);
      next.add(3); // oracle step auto-completed in quick mode
      return next;
    });
    setWizard((prev) => {
      const base = { ...prev, step: 4 as WizardStep };
      if (quickLaunch.oracleType === "pyth" && quickLaunch.pythFeedId) {
        return {
          ...base,
          oracleType: "pyth" as const,
          oracleFeed: quickLaunch.pythFeedId,
          adminPrice: quickLaunch.adminPrice,
        };
      }
      // PERC-470: Hyperp EMA — auto-detected DEX pool as oracle
      if (quickLaunch.oracleType === "hyperp_ema" && quickLaunch.dexPoolAddress) {
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
  }, [quickLaunch]);

  // Mode change
  const handleModeChange = useCallback(
    (mode: "quick" | "manual") => {
      setWizard((prev) => ({
        ...prev,
        mode,
        // Reset oracle fields when switching
        oracleType: mode === "quick" ? "admin" : "pyth",
        oracleFeed: "",
        dexPool: null,
        pythFeed: null,
        // Reset slab tier to mode-appropriate default
        slabTier: mode === "quick" ? "small" : "large",
      }));
    },
    []
  );

  // Updaters (memoized to avoid unnecessary re-renders in children)
  const setMintAddress = useCallback((mint: string) => {
    setWizard((prev) => ({ ...prev, mintAddress: mint }));
    // Reset network validation and devnet mirror when mint changes
    setMintExistsOnNetwork(false);
    setDevnetMintAddress(null);
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

  const setOracleType = useCallback(
    (oracleType: "pyth" | "hyperp_ema" | "admin") => {
      setWizard((prev) => ({ ...prev, oracleType }));
    },
    []
  );

  const setOracleFeed = useCallback((feed: string) => {
    setWizard((prev) => ({ ...prev, oracleFeed: feed }));
  }, []);

  const setDexPool = useCallback((pool: DexPoolResult | null) => {
    setWizard((prev) => ({ ...prev, dexPool: pool }));
  }, []);

  const setPythFeed = useCallback(
    (feed: { id: string; name: string } | null) => {
      setWizard((prev) => ({ ...prev, pythFeed: feed }));
    },
    []
  );

  const setSlabTier = useCallback((tier: SlabTierKey) => {
    setWizard((prev) => ({ ...prev, slabTier: tier }));
  }, []);

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

  const setAdminPrice = useCallback((val: string) => {
    setWizard((prev) => ({ ...prev, adminPrice: val }));
  }, []);

  // Build oracle feed for create
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
      const priceE6 = BigInt(Math.round(dexPrice * 1_000_000));
      return { oracleFeed: "0".repeat(64), priceE6 };
    }
    // Admin oracle
    const price = parseFloat(wizard.adminPrice ?? "1");
    const priceE6 = BigInt(Math.round((isNaN(price) ? 1 : price) * 1_000_000));
    return { oracleFeed: "0".repeat(64), priceE6 };
  };

  // Launch market
  const handleLaunch = () => {
    if (!allValid || !publicKey) return;
    const { oracleFeed, priceE6 } = getOracleFeedAndPrice();
    // PERC-470 security: block hyperp launch without valid DEX price
    if (wizard.oracleType === "hyperp_ema" && priceE6 === 0n) {
      alert("Cannot create market: no DEX price available for this token. Try again or switch to Admin oracle.");
      return;
    }
    const tier = SLAB_TIERS[wizard.slabTier];
    // On devnet, use the mirror mint for on-chain ops; keep mainnet CA for metadata
    const effectiveMint = devnetMintAddress ?? wizard.mintAddress;

    // PERC-470: Map wizard oracle type to CreateMarketParams oracleMode
    const oracleMode = wizard.oracleType === "pyth" ? "pyth" as const
      : wizard.oracleType === "hyperp_ema" ? "hyperp" as const
      : "admin" as const;

    const params: CreateMarketParams = {
      mint: new PublicKey(effectiveMint),
      initialPriceE6: priceE6,
      lpCollateral: parseHumanAmount(wizard.lpCollateral || "0", decimals),
      insuranceAmount: parseHumanAmount(wizard.insuranceAmount, decimals),
      oracleFeed,
      invert: false,
      tradingFeeBps: wizard.tradingFeeBps,
      initialMarginBps: wizard.initialMarginBps,
      maxAccounts: tier.maxAccounts,
      slabDataSize: tier.dataSize,
      symbol: wizard.tokenMeta?.symbol ?? "UNKNOWN",
      name: wizard.tokenMeta?.name ?? "Unknown Token",
      decimals,
      mainnetCA: wizard.mintAddress !== effectiveMint ? wizard.mintAddress : undefined,
      oracleMode,
      // PERC-470/#811: Pass DEX pool address for hyperp mode.
      // wizard.dexPool is set when the user selects a pool from the UI.
      // For Quick Launch, poolInfo may be null while oracleFeed holds the pool address —
      // use oracleFeed as fallback so the pool address is never silently dropped.
      ...(oracleMode === "hyperp" ? {
        dexPoolAddress: wizard.dexPool?.poolAddress ?? wizard.oracleFeed,
      } : {}),
    };
    create(params);
  };

  // Retry from failed step
  const handleRetry = () => {
    if (!allValid || !publicKey || !createState.slabAddress) return;
    const { oracleFeed, priceE6 } = getOracleFeedAndPrice();
    const tier = SLAB_TIERS[wizard.slabTier];
    const effectiveMint = devnetMintAddress ?? wizard.mintAddress;

    // PERC-470: Include oracleMode + dexPoolAddress in retry params (fixes #810)
    const oracleMode = wizard.oracleType === "pyth" ? "pyth" as const
      : wizard.oracleType === "hyperp_ema" ? "hyperp" as const
      : "admin" as const;

    const params: CreateMarketParams = {
      mint: new PublicKey(effectiveMint),
      initialPriceE6: priceE6,
      lpCollateral: parseHumanAmount(wizard.lpCollateral || "0", decimals),
      insuranceAmount: parseHumanAmount(wizard.insuranceAmount, decimals),
      oracleFeed,
      invert: false,
      tradingFeeBps: wizard.tradingFeeBps,
      initialMarginBps: wizard.initialMarginBps,
      maxAccounts: tier.maxAccounts,
      slabDataSize: tier.dataSize,
      symbol: wizard.tokenMeta?.symbol ?? "UNKNOWN",
      name: wizard.tokenMeta?.name ?? "Unknown Token",
      decimals,
      mainnetCA: wizard.mintAddress !== effectiveMint ? wizard.mintAddress : undefined,
      oracleMode,
      // PERC-470/#811: Same fallback as handleLaunch — oracleFeed holds pool address
      // for Quick Launch when wizard.dexPool is null.
      ...(oracleMode === "hyperp" ? {
        dexPoolAddress: wizard.dexPool?.poolAddress ?? wizard.oracleFeed,
      } : {}),
    };
    create(params, createState.step);
  };

  // Reset wizard completely
  const handleReset = () => {
    resetCreate();
    setWizard({ ...DEFAULT_STATE });
    setCompletedSteps(new Set());
    setDevnetMintAddress(null);
  };

  // --- Render ---

  // Success state
  if (createState.step >= 5 && createState.slabAddress) {
    return (
      <LaunchSuccess
        tokenSymbol={symbol}
        tradingFeeBps={wizard.tradingFeeBps}
        maxLeverage={maxLeverage}
        slabLabel={SLAB_TIERS[wizard.slabTier].label}
        marketAddress={createState.slabAddress}
        txSigs={createState.txSigs}
        onDeployAnother={handleReset}
        mainnetCA={wizard.mintAddress}
        devnetMint={createState.devnetMint}
        devnetAirdropAmount={createState.devnetAirdropAmount}
        devnetAirdropSymbol={createState.devnetAirdropSymbol}
        devnetMintError={createState.devnetMintError}
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

  // Oracle label for review
  const oracleLabel =
    wizard.oracleType === "pyth" && wizard.pythFeed
      ? wizard.pythFeed.name
      : wizard.oracleType === "hyperp_ema" && wizard.dexPool
        ? `${wizard.dexPool.pairLabel} (${wizard.dexPool.dexId})`
        : wizard.oracleType === "admin"
          ? "Admin Oracle"
          : wizard.oracleFeed
            ? `${wizard.oracleFeed.slice(0, 12)}...`
            : "Not configured";

  const detectedPrice = wizard.dexPool?.priceUsd ?? undefined;

  // Wallet balance display for step 3
  const walletBalanceDisplay =
    wizard.walletBalance !== null && wizard.tokenMeta
      ? formatHumanAmount(wizard.walletBalance, wizard.tokenMeta.decimals)
      : null;

  // Step labels — Quick Launch skips Oracle (step 2 auto-resolved), so relabel it
  const stepLabels: readonly [string, string, string, string] =
    wizard.mode === "quick"
      ? ["Token", "Oracle ✓", "Slab Tier", "Review"]
      : ["Token", "Oracle", "Parameters", "Review"];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Stuck slab recovery banner */}
      <RecoverSolBanner
        onResume={(slabAddress) => {
          // The stuck slab's keypair is already in localStorage —
          // useCreateMarket will pick it up. Just trigger a retry from step 1.
          resetCreate();
          // Start the wizard at step 1 so user can fill in parameters
        }}
      />

      {/* Mode Selector */}
      <ModeSelector mode={wizard.mode} onModeChange={handleModeChange} />

      {/* Progress indicator */}
      <WizardProgress
        currentStep={wizard.step}
        completedSteps={completedSteps}
        stepLabels={stepLabels}
        onStepClick={(step) => {
          if (completedSteps.has(step)) goToStep(step);
        }}
      />

      {/* Step panel */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-5 sm:p-6">
        {/* Step header */}
        <div className="mb-5 pb-4 border-b border-[var(--border)]">
          <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
            STEP {wizard.step} / 4 — {stepLabels[wizard.step - 1]}
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
            onDevnetMintResolved={setDevnetMintAddress}
            onContinue={() => advanceStep(1)}
            canContinue={step1Valid}
          />
        )}

        {/* Step 2: Quick mode = Slab Tier selection; Manual mode = Oracle */}
        {wizard.step === 2 && wizard.mode === "quick" && (
          <div className="space-y-6">
            <div>
              <p className="text-[11px] text-[var(--text-secondary)] mb-4">
                Choose your market size. Larger slabs support more concurrent traders but cost more SOL to deploy.
              </p>
              <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)] mb-3">
                Slab Tier
              </label>
              <SlabTierPicker value={wizard.slabTier} onChange={setSlabTier} />
            </div>
            {/* Oracle detection status */}
            {quickLaunch.loading ? (
              <p className="text-[10px] text-[var(--text-dim)]">⏳ Detecting oracle...</p>
            ) : quickLaunch.oracleType === "pyth" && quickLaunch.pythFeedId ? (
              <p className="text-[10px] text-[var(--long)]">
                ✓ Pyth oracle detected — price feed will be used automatically
              </p>
            ) : quickLaunch.oracleType === "hyperp_ema" && quickLaunch.dexPoolAddress ? (
              <p className="text-[10px] text-[var(--long)]">
                ✓ DEX pool detected — permissionless on-chain pricing (no keeper needed)
              </p>
            ) : (
              <p className="text-[10px] text-[var(--text-dim)]">
                ℹ Admin oracle — you&apos;ll control pricing (devnet token)
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={goBack}
                className="border border-[var(--border)] bg-transparent px-5 py-3 text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hud-btn-corners hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
              >
                ← BACK
              </button>
              <button
                type="button"
                onClick={handleQuickSlabContinue}
                className="flex-1 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15]"
              >
                CONTINUE →
              </button>
            </div>
          </div>
        )}
        {wizard.step === 2 && wizard.mode === "manual" && (
          <StepOracleSelect
            mintAddress={wizard.mintAddress}
            mintValid={mintValid}
            tokenSymbol={wizard.tokenMeta?.symbol ?? null}
            mode={wizard.mode}
            oracleType={wizard.oracleType}
            onOracleTypeChange={setOracleType}
            oracleFeed={wizard.oracleFeed}
            onOracleFeedChange={setOracleFeed}
            onDexPoolDetected={setDexPool}
            onPythDetected={setPythFeed}
            onContinue={() => advanceStep(2)}
            onBack={goBack}
            canContinue={step2Valid}
          />
        )}

        {/* Step 3: Parameters */}
        {wizard.step === 3 && (
          <StepParameters
            mode={wizard.mode}
            slabTier={wizard.slabTier}
            onSlabTierChange={setSlabTier}
            tradingFeeBps={wizard.tradingFeeBps}
            onTradingFeeChange={setTradingFeeBps}
            initialMarginBps={wizard.initialMarginBps}
            onInitialMarginChange={setInitialMarginBps}
            lpCollateral={wizard.lpCollateral}
            onLpCollateralChange={setLpCollateral}
            insuranceAmount={wizard.insuranceAmount}
            onInsuranceAmountChange={setInsuranceAmount}
            adminPrice={wizard.adminPrice}
            onAdminPriceChange={setAdminPrice}
            isAdminOracle={wizard.oracleType === "admin"}
            tokenSymbol={symbol}
            walletBalance={walletBalanceDisplay}
            onContinue={() => advanceStep(3)}
            onBack={goBack}
            canContinue={step3Valid}
          />
        )}

        {/* Step 4: Review */}
        {wizard.step === 4 && (
          <StepReview
            tokenSymbol={symbol}
            tokenName={wizard.tokenMeta?.name ?? "Unknown Token"}
            mintAddress={wizard.mintAddress}
            tokenDecimals={decimals}
            priceUsd={detectedPrice}
            oracleType={wizard.oracleType}
            oracleLabel={oracleLabel}
            slabTier={wizard.slabTier}
            tradingFeeBps={wizard.tradingFeeBps}
            initialMarginBps={wizard.initialMarginBps}
            lpCollateral={wizard.lpCollateral}
            insuranceAmount={wizard.insuranceAmount}
            walletConnected={!!publicKey}
            walletBalanceSol={solBalance}
            hasSufficientBalance={hasSufficientSol}
            requiredSol={requiredSol}
            hasTokens={hasTokens}
            hasSufficientTokensForSeed={hasSufficientTokensForSeed}
            feeConflict={feeConflict}
            onBack={goBack}
            onLaunch={handleLaunch}
            canLaunch={allValid && !!publicKey}
          />
        )}
      </div>
    </div>
  );
};
