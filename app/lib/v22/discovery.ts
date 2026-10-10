/**
 * Flag-gated market discovery. The installed SDK 8.0.0 `discoverMarkets` / `getMarketsByAddress` only accept wrapper
 * VERSION 18, so a v2.2 (VERSION 19) market is invisible to every list, route and page built on them. Flag OFF these are
 * the installed functions (same behaviour); flag ON they are the SDK candidate's VERSION-aware ports
 * (lib/v22/sdk/discovery.ts, sdk#406 @ adf8fd0): VERSION 18 and 19 found, an unknown VERSION skipped loudly.
 */
import { discoverMarkets as installedDiscover, getMarketsByAddress as installedByAddress } from "@percolatorct/sdk";
import { isDevnetV22Enabled } from "./flag";
import { discoverMarkets as v22Discover, getMarketsByAddress as v22ByAddress } from "./sdk/discovery";

export type { DiscoveredMarket } from "@percolatorct/sdk";

export const discoverMarkets: typeof installedDiscover = (...a) =>
  isDevnetV22Enabled() ? (v22Discover as unknown as typeof installedDiscover)(...a) : installedDiscover(...a);

export const getMarketsByAddress: typeof installedByAddress = (...a) =>
  isDevnetV22Enabled() ? (v22ByAddress as unknown as typeof installedByAddress)(...a) : installedByAddress(...a);
