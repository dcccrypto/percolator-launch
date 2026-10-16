/**
 * Fired on `window` the moment a registration lands, so every list on this page (the markets page,
 * the landing rail) refetches past the CDN's 10 s + 60 s stale window instead of showing the market
 * a poll or two late (hooks/useAllMarketStats.ts). Other visitors still see it on their next poll.
 *
 * A leaf module so the listeners (on the landing page and every market list) don't import the
 * keeper-registration client, and the SDK under it, just for this name. Dispatched by
 * lib/keeper-register-client.ts announceMarketRegistered, which re-exports it.
 */
export const MARKET_REGISTERED_EVENT = "perc:market-registered";
