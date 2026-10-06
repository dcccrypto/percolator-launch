/*
 * LOCAL ADAPTER PORT, not original code: the v2.2 additions to PERCOLATOR_ERRORS (codes 104-119, 123, 124) verbatim from percolator-sdk
 * feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406) src/abi/errors.ts, lifted into their own table because the installed
 * @percolatorct/sdk 8.0.0 table stops at 122. Delete when @percolatorct/sdk >= 9.0.0 ships. Do not edit here; fix upstream.
 */
import type { ErrorInfo } from "@percolatorct/sdk";

export const PERCOLATOR_ERRORS_V22: Readonly<Record<number, ErrorInfo>> = Object.freeze({
// v2.2 Phase 4 (percolator-prog release/v22-wrapper b4390fe0; waves A #527, B #533, C #530, D #531):
  // explicit discriminants 104..=119 plus 123/124. Each message is ONE calm line for the user; the
  // creator-tooling codes say what to fix. Wording follows the wave docs (Wave A `v22-wave-a-wire.md`,
  // Wave B `v22-band-defaults-and-product-copy.md`, the Rust doc comments) where they give copy.
  104: {
    name: "PriceBandPinned",
    hint: "Price catching up; closing resumes in a few seconds.",
  },
  105: {
    name: "PriceBandConfigInvalid",
    hint: "This market's price-band settings are not valid; check the band width, epoch, pin window and minimum position size.",
  },
  106: {
    name: "HoldingRentConfigInvalid",
    hint: "This market's holding-rent settings are not valid; the rate must be 0 or at least 10, and the kink at most 80%.",
  },
  107: {
    name: "BondTrancheImpaired",
    hint: "Bond deposits are paused while the bond tranche is below par.",
  },
  108: {
    name: "BondCapacityLocked",
    hint: "Withdrawable when the market's open interest is below the capacity your bond backs.",
  },
  109: {
    name: "BondWithdrawCooldown",
    hint: "Your bond withdrawal is still cooling down; try again after the cooldown set for this market.",
  },
  110: {
    name: "BondConfigInvalid",
    hint: "These bond settings, or this bond position, are not valid for this market.",
  },
  111: {
    name: "PriceBandPositionCap",
    hint: "This market is full on this side; try again shortly.",
  },
  112: {
    name: "PriceBandTooNarrow",
    hint: "This market is close-only at this price.",
  },
  113: {
    name: "PriceBandLegBelowMinNotional",
    hint: "Below the minimum position size: trade at least the market minimum, or close fully.",
  },
  114: {
    name: "RescueRefused",
    hint: "This market cannot be recapitalised right now; try again once it has refreshed.",
  },
  115: {
    name: "RescueNavFloor",
    hint: "This market can no longer be recapitalised; it will be wound down.",
  },
  116: {
    name: "InsuranceBackstopRefused",
    hint: "The insurance fund is not available for this right now; nothing was moved.",
  },
  117: {
    name: "RedemptionBelowMinPayout",
    hint: "The exit price moved below your minimum; retry or lower it.",
  },
  118: {
    name: "ExitRequiresLossCurrent",
    hint: "Refreshing positions before your exit; retry shortly.",
  },
  119: {
    name: "LotConfigInvalid",
    hint: "This market's lot size is not valid; choose a lot exponent from 1 to 15 so the launch price is between 10 and 10,000 per lot.",
  },
  123: {
    name: "BondDepositAboveCap",
    hint: "This market's bond tranche is full.",
  },
  124: {
    name: "BondSlippage",
    hint: "The bond price moved past your minimum; retry or lower it.",
  },
  });
