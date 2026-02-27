"use client";

import { FC, useState, useMemo, useCallback, useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useCreateMarket, type CreateMarketParams } from "@/hooks/useCreateMarket";
import { useQuickLaunch } from "@/hooks/useQuickLaunch";
import { type DexPoolResult } from "@/hooks/useDexPoolSearch";
import { parseHumanAmount, formatHumanAmount } from "@/lib/parseAmount";
import { SLAB_TIERS, type SlabTierKey } from "@percolator/sdk";

import { ModeSelector } from "./ModeSelector";
import { WizardProgress } from "./WizardProgress";
import { StepTokenSelect } from "./StepTokenSelect";
import { StepOracleSelect } from "./StepOracleSelect";
import { StepParameters } from "./StepParameters";
import { StepReview } from "./StepReview";
import { LaunchProgress } from "./LaunchProgress";
import { LaunchSuccess } from "./LaunchSuccess";
import { RecoverSolBanner } from "./RecoverSolBanner";
import { isValidBase58Pubkey, isValidHex64 } from "@/lib/createWizardUtils";

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
  oracleType: "pyth",
  oracleFeed: "",
  dexPool: null,
  pythFeed: null,
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

  // Apply quick launch defaults to parameters
  useEffect(() => {
    if (wizard.mode !== "quick" || !quickLaunch.config) return;
    setWizard((prev) => ({
      ...prev,
      tradingFeeBps: quickLaunch.config!.tradingFeeBps,
      initialMarginBps: quickLaunch.config!.initialMarginBps,
      lpCollateral: quickLaunch.config!.lpCollateral,
    }));
  }, [quickLaunch.config, wizard.mode]);

  // Derived values
  const mintValid = isValidBase58Pubkey(wizard.mintAddress) && wizard.mintAddress.length >= 32;
  const maxLeverage = Math.floor(10000 / wizard.initialMarginBps);
  const feeConflict = wizard.tradingFeeBps >= wizard.initialMarginBps;
  const hasTokens = wizard.walletBalance !== null && wizard.walletBalance > 0n;
  const decimals = wizard.tokenMeta?.decimals ?? 6;
  const symbol = wizard.tokenMeta?.symbol ?? "Token";

  // Step validation
  const step1Valid = mintValid && wizard.tokenMeta !== null && (wizard.tokenMeta.decimals <= 12);
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
  const hasSufficientSol = solBalance !== null && solBalance >= 0.5;
  const allValid = step1Valid && step2Valid && step3Valid && hasTokens && hasSufficientSol;

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
    setWizard((prev) => ({
      ...prev,
      step: Math.max(1, prev.step - 1) as WizardStep,
    }));
  }, []);

  // Mode change
  const handleModeChange = useCallback(
    (mode: "quick" | "manual") => {
      setWizard((prev) => ({
        ...prev,
        mode,
        // Reset oracle fields when switching
        oracleType: "pyth",
        oracleFeed: "",
        dexPool: null,
        pythFeed: null,
      }));
    },
    []
  );

  // Updaters (memoized to avoid unnecessary re-renders in children)
  const setMintAddress = useCallback((mint: string) => {
    setWizard((prev) => ({ ...prev, mintAddress: mint }));
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
      try {
        const pk = new PublicKey(wizard.oracleFeed);
        const hex = Array.from(pk.toBytes())
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        return { oracleFeed: hex, priceE6: 0n };
      } catch {
        return { oracleFeed: "0".repeat(64), priceE6: 1_000_000n };
      }
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
    const tier = SLAB_TIERS[wizard.slabTier];

    const params: CreateMarketParams = {
      mint: new PublicKey(wizard.mintAddress),
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
    };
    create(params);
  };

  // Retry from failed step
  const handleRetry = () => {
    if (!allValid || !publicKey || !createState.slabAddress) return;
    const { oracleFeed, priceE6 } = getOracleFeedAndPrice();
    const tier = SLAB_TIERS[wizard.slabTier];

    const params: CreateMarketParams = {
      mint: new PublicKey(wizard.mintAddress),
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
    };
    create(params, createState.step);
  };

  // Reset wizard completely
  const handleReset = () => {
    resetCreate();
    setWizard({ ...DEFAULT_STATE });
    setCompletedSteps(new Set());
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
        onStepClick={(step) => {
          if (completedSteps.has(step)) goToStep(step);
        }}
      />

      {/* Step panel */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-5 sm:p-6">
        {/* Step header */}
        <div className="mb-5 pb-4 border-b border-[var(--border)]">
          <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
            STEP {wizard.step} / 4 —{" "}
            {wizard.step === 1
              ? "Token"
              : wizard.step === 2
                ? "Oracle"
                : wizard.step === 3
                  ? "Parameters"
                  : "Review"}
          </p>
        </div>

        {/* Step 1: Token */}
        {wizard.step === 1 && (
          <StepTokenSelect
            mintAddress={wizard.mintAddress}
            onMintChange={setMintAddress}
            onTokenResolved={setTokenMeta}
            onBalanceChange={setWalletBalance}
            onContinue={() => advanceStep(1)}
            canContinue={step1Valid}
          />
        )}

        {/* Step 2: Oracle */}
        {wizard.step === 2 && (
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
            hasTokens={hasTokens}
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
