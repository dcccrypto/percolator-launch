/**
 * Fail-closed state of the PERC holder vote.
 *
 * The vote's real state lives in the private database (perc_vote.poll): with
 * no poll row it is NOT STARTED, and only the admin start endpoint (behind the
 * server-only VOTE_ADMIN_SECRET) can create that row, once. Without the
 * server-side database configuration every vote endpoint answers UNAVAILABLE.
 */
export const VOTE_UNAVAILABLE_MESSAGE = "Vote unavailable. Try again later.";

export const VOTE_UNAVAILABLE = Object.freeze({ status: "unavailable", message: VOTE_UNAVAILABLE_MESSAGE } as const);
