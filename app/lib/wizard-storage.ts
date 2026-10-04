/**
 * localStorage key under which CreateMarketWizard persists its form (PERC-516).
 *
 * Shared so every place that clears the wizard's saved form — the wizard's own
 * reset/reclaim paths, and RecoverSolBanner's START NEW MARKET link on
 * /my-markets (#2967), which has no wizard callbacks to call — names the same
 * key. A hard-coded copy could drift and silently stop clearing anything.
 */
export const WIZARD_STORAGE_KEY = "percolator-wizard-state";
