/**
 * Public launch state of the PERC allocation checker and holder vote.
 *
 * These are compile-time constants on purpose. Nothing (env var, request,
 * header, cookie, storage) can publish allocations or open the vote. The
 * source checker keeps its data and vote log in local files, which Vercel
 * serverless cannot hold durably, so the backend is deferred to a separate,
 * approved enabling change. Until then every write fails closed.
 */
export const ALLOCATION_UNAVAILABLE_MESSAGE = "Validated allocation data unavailable";
export const VOTE_UNAVAILABLE_MESSAGE = "Vote unavailable";

export const ALLOCATION_STATUS = Object.freeze({ published: false, data: "unavailable" } as const);
export const VOTE_STATUS = Object.freeze({ state: "UNAVAILABLE", open: false } as const);
