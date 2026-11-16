/**
 * Wire limits shared by /api/markets/health and its client hook. Kept apart from
 * `market-health.ts` (slab decoders + copy, server-only in practice) so the
 * client hook does not drag the decoders into the /markets first-load bundle.
 */
export const MAX_HEALTH_SLABS = 50;
