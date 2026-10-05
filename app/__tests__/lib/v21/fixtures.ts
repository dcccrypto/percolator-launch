/** Shared fixtures for the Devnet v2.1 tests (not a test file). */
import { ASSET_GROWTH_FIELD_OFF, assetGrowthAccountOffsetV19 } from "@/lib/v21/sdk";

export interface GrowthRecordInit {
  cLaunch?: bigint;
  lambda?: number;
  launch?: number;
  tier?: number;
  ceil?: number;
  kink?: number;
  gap?: number;
  version?: number;
  util?: number;
}

/** A market account (kind 1) long enough to hold asset 0's growth record, with that record set. */
export function marketRaw(init: GrowthRecordInit | null, hlockByte = 0): Uint8Array {
  const raw = new Uint8Array(4_000);
  raw[10] = 1; // KIND_MARKET
  raw[592 + 621] = hlockByte; // market-group bankruptcy_hlock_active
  if (init) {
    const d = { cLaunch: 5_000_000_000n, lambda: 10_000, launch: 550, tier: 1_000, ceil: 550, kink: 5_000, gap: 500, version: 1, util: 0, ...init };
    const off = assetGrowthAccountOffsetV19(0);
    const v = new DataView(raw.buffer);
    const F = ASSET_GROWTH_FIELD_OFF;
    v.setBigUint64(off + F.cLaunchAtoms, d.cLaunch, true);
    v.setUint32(off + F.lambdaBps, d.lambda, true);
    v.setUint16(off + F.lLaunchX100, d.launch, true);
    v.setUint16(off + F.lTierX100, d.tier, true);
    v.setUint16(off + F.ceilX100, d.ceil, true);
    v.setUint16(off + F.kinkBps, d.kink, true);
    v.setUint16(off + F.rGapBps, d.gap, true);
    raw[off + F.version] = d.version;
    v.setUint16(off + F.utilFeeMaxBps, d.util, true);
  }
  return raw;
}

/** $1 asset, 10% IMR (tier 10x), LP capital 100 USDC (N_cap = 100e6 Q at 1x). */
export const ENGINE = {
  initialMarginBps: 1_000n,
  effectivePriceE6: 1_000_000n,
  oiEffLongQ: 30_000_000n,
  oiEffShortQ: 10_000_000n,
  tradeFeeBaseBps: 30n,
  maxTradingFeeBps: 630n,
};
export const LP = { capital: 100_000_000n, pnl: 0n, feeCredits: 0n };

import * as C from "@/lib/limits/constants";

/** A bound LP-vault registry account (kind, bound flag, domain). */
export function registryBytes(opts: { bound: boolean; domain?: number }): Uint8Array {
  const d = new Uint8Array(C.LP_VAULT_REGISTRY_ACCOUNT_LEN);
  d[C.HEADER_KIND_OFF] = C.KIND_LP_VAULT_REGISTRY;
  d[C.REG_VAULT_LP_BOUND_FLAG] = opts.bound ? 1 : 0;
  new DataView(d.buffer).setUint16(C.REG_DOMAIN, opts.domain ?? 0, true);
  return d;
}

/** A vault-LP state account pointing at `lpPortfolio`. */
export function vaultLpStateBytes(lpPortfolio: Uint8Array): Uint8Array {
  const d = new Uint8Array(C.VAULT_LP_STATE_ACCOUNT_LEN);
  d[C.HEADER_KIND_OFF] = C.KIND_VAULT_LP_STATE;
  d[C.VS.version] = C.VAULT_LP_STATE_VERSION;
  new DataView(d.buffer).setUint16(C.VS.juniorFloorBps, 2_000, true);
  d.set(lpPortfolio, C.VS.lpPortfolio);
  return d;
}
