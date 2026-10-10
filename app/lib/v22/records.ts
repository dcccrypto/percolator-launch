/**
 * Flag-gated adapter for the market / portfolio RECORD decoders whose geometry the SDK candidate (percolator-sdk#406 @ ecb6215)
 * made VERSION-keyed. The installed @percolatorct/sdk 8.0.0 and the v2.1 ports in ../v21/sdk bake in v2.1 numbers
 * (592 + 758 + 2325 * i ...), which silently misread a v2.2 market (group 806, stride 2661, portfolio 10,603).
 *
 *  - Flag OFF (`NEXT_PUBLIC_DEVNET_V22` unset): every export is the function the app used before (installed SDK or v2.1 port).
 *  - Flag ON: every export is the layout-aware vendored port (./sdk/records/*): the layout comes from the account's VERSION,
 *    never from its length, and an unknown VERSION throws the typed `UnknownLayoutError`.
 *
 * Only the pairs that exist in both worlds are gated. The v2.2-only readers (`readPotEngineRecordsP2b`,
 * `decodeBackingDomainLedgerP2b`) are re-exported from the port under `v22Records`.
 */
import {
  assetVaultLpAccountOffsetP3 as oldAssetVaultLpAccountOffsetP3,
  decodeAssetRiskLimitsP1 as oldDecodeAssetRiskLimitsP1,
  decodeAssetVaultLpDrawP3 as oldDecodeAssetVaultLpDrawP3,
  decodeAssetVaultLpP3 as oldDecodeAssetVaultLpP3,
  decodeResolvedPayoutReceiptP3 as oldDecodeResolvedPayoutReceiptP3,
  decodeTerminalInsuranceCapacity as oldDecodeTerminalInsuranceCapacity,
  decodeVaultLpStateP3 as oldDecodeVaultLpStateP3,
  listOpenResolvedReceiptsP3 as oldListOpenResolvedReceiptsP3,
  parseBackingBucketsV17 as oldParseBackingBucketsV17,
  parseLpRedemption as oldParseLpRedemption,
  parseLpVaultRegistry as oldParseLpVaultRegistry,
  readAssetPricesP3 as oldReadAssetPricesP3,
} from "@percolatorct/sdk";
import { assetGrowthAccountOffsetV19 as oldAssetGrowthAccountOffsetV19, decodeAssetGrowthV19 as oldDecodeAssetGrowthV19, decodeAdlEpisode as oldDecodeAdlEpisode } from "../v21/sdk";
import { isDevnetV22Enabled } from "./flag";
import * as Growth from "./sdk/records/growth-v19";
import * as Limits from "./sdk/records/risk-limits-p1";
import * as Lock from "./sdk/records/p2b-lock-exits";
import * as Earn from "./sdk/records/p2b-earn";
import * as P3 from "./sdk/records/p3-vault-lp";
import * as Bucket from "./sdk/records/backing-bucket";
import * as Wind from "./sdk/records/stake-wind-down";
import * as Slab from "./sdk/slab";

export { UnknownLayoutError } from "./sdk";
export const v22Records = Object.freeze({
  readPotEngineRecordsP2b: Earn.readPotEngineRecordsP2b,
  decodeBackingDomainLedgerP2b: Earn.decodeBackingDomainLedgerP2b,
  decodeVaultLpExtV19: Earn.decodeVaultLpExtV19,
});

const on = isDevnetV22Enabled;

export const decodeAssetGrowthV19: typeof Growth.decodeAssetGrowthV19 = (d, i) => (on() ? Growth.decodeAssetGrowthV19(d, i) : oldDecodeAssetGrowthV19(d, i));
export const assetGrowthAccountOffsetV19 = (i: number, layout?: Parameters<typeof Growth.assetGrowthAccountOffsetV19>[1]): number =>
  on() ? Growth.assetGrowthAccountOffsetV19(i, layout) : oldAssetGrowthAccountOffsetV19(i);
export const decodeAdlEpisode: typeof Lock.decodeAdlEpisode = (d, i) => (on() ? Lock.decodeAdlEpisode(d, i) : oldDecodeAdlEpisode(d, i));
export const decodeAssetRiskLimitsP1: typeof Limits.decodeAssetRiskLimitsP1 = (d, i) => (on() ? Limits.decodeAssetRiskLimitsP1(d, i) : oldDecodeAssetRiskLimitsP1(d, i));
export const assetVaultLpAccountOffsetP3 = (i: number, layout?: Parameters<typeof P3.assetVaultLpAccountOffsetP3>[1]): number =>
  on() ? P3.assetVaultLpAccountOffsetP3(i, layout) : oldAssetVaultLpAccountOffsetP3(i);
export const readAssetPricesP3: typeof P3.readAssetPricesP3 = (d, i) => (on() ? P3.readAssetPricesP3(d, i) : oldReadAssetPricesP3(d, i));
export const decodeAssetVaultLpP3: typeof oldDecodeAssetVaultLpP3 = (d, i) => (on() ? P3.decodeAssetVaultLpP3(d, i) : oldDecodeAssetVaultLpP3(d, i));
export const decodeAssetVaultLpDrawP3: typeof P3.decodeAssetVaultLpDrawP3 = (d, i) => (on() ? P3.decodeAssetVaultLpDrawP3(d, i) : oldDecodeAssetVaultLpDrawP3(d, i));
export const decodeVaultLpStateP3: typeof P3.decodeVaultLpStateP3 = (d) => (on() ? P3.decodeVaultLpStateP3(d) : oldDecodeVaultLpStateP3(d));
export const decodeResolvedPayoutReceiptP3: typeof P3.decodeResolvedPayoutReceiptP3 = (d) => (on() ? P3.decodeResolvedPayoutReceiptP3(d) : oldDecodeResolvedPayoutReceiptP3(d));
export const listOpenResolvedReceiptsP3: typeof P3.listOpenResolvedReceiptsP3 = (c, p, m, layout) =>
  on() ? P3.listOpenResolvedReceiptsP3(c, p, m, layout ?? undefined) : oldListOpenResolvedReceiptsP3(c, p, m);
export const parseBackingBucketsV17: typeof Bucket.parseBackingBucketsV17 = (d) => (on() ? Bucket.parseBackingBucketsV17(d) : oldParseBackingBucketsV17(d));
export const decodeTerminalInsuranceCapacity: typeof Wind.decodeTerminalInsuranceCapacity = (d, i) => (on() ? Wind.decodeTerminalInsuranceCapacity(d, i) : oldDecodeTerminalInsuranceCapacity(d, i));

/**
 * Review F5: the installed SDK 8.0.0 `parseLpVaultRegistry` / `parseLpRedemption` assert wrapper VERSION 18, but a v2.2
 * program stamps 19 on every account kind, so the Earn rail could not read its own vault. Flag on: the vendored port
 * (VERSION-keyed via `resolveLayout`: 18 and 19 accepted, anything else a typed `UnknownLayoutError`; the redemption
 * body is the same first 112 bytes, 128 B on a v2.2-form request). Flag off: the installed function, unchanged.
 * Return types are the installed ones (the ports return the same shape).
 */
export const parseLpVaultRegistry: typeof oldParseLpVaultRegistry = (d) => (on() ? Slab.parseLpVaultRegistry(d) : oldParseLpVaultRegistry(d));
export const parseLpRedemption: typeof oldParseLpRedemption = (d) => (on() ? Slab.parseLpRedemption(d) : oldParseLpRedemption(d));
