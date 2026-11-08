/**
 * Public launch state of the PERC holder vote.
 *
 * These are compile-time constants on purpose. Nothing (env var, request,
 * header, cookie, storage) can open the vote. The vote backend is deferred to
 * a separate, approved enabling change; until then every write fails closed.
 *
 * (The allocation checker's state comes from its server-side database
 * configuration; see server-config.ts. Without it the checker is unavailable.)
 */
export const VOTE_UNAVAILABLE_MESSAGE = "Vote unavailable";

export const VOTE_STATUS = Object.freeze({ state: "UNAVAILABLE", open: false } as const);
