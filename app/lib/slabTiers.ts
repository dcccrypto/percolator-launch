/**
 * Local re-export of slab tier definitions matching the DEPLOYED v12.19.1
 * mainnet program.
 *
 * The SDK's default `SLAB_TIERS` export still points at V12_17 sizes
 * (because SDK 2.0.9 was shipped against the v12.17 layout). The deployed
 * program rejects mismatched account sizes with InvalidSlabLen (0x4).
 *
 * Every consumer in the launch app should import from here, not from
 * @percolatorct/sdk directly.
 *
 * When the SDK is rebuilt to track v12.19.1 (or whatever later layout we
 * deploy), this file can be deleted and imports pointed back at the SDK's
 * SLAB_TIERS export.
 */

import { SLAB_TIERS_V12_19 } from "@percolatorct/sdk";

export const SLAB_TIERS = SLAB_TIERS_V12_19;
export type SlabTierKey = keyof typeof SLAB_TIERS_V12_19;
