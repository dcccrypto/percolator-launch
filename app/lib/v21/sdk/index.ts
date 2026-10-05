/**
 * THE adapter: the only module the app imports Devnet-v2.1 client ABI from.
 *
 * `@percolatorct/sdk` 9.0.0 (percolator-sdk #397 growth-v19, #399 P2b lock exits, plus the #526
 * Earn-allocation additions) is a candidate and not published. Until it is, the files next to this
 * one are verbatim local ports of the candidate branches (growth-v19.ts @ feat/growth-v19 26a360f,
 * p2b-lock-exits.ts @ feat/p2b-lock-exits eb819c5) plus a small local p2b-earn.ts for what the
 * candidate lacks. When 9.0.0 ships: bump the dependency, replace these re-exports with
 * `export * from "@percolatorct/sdk"`, delete the sibling files. Nothing else in the app changes.
 */
export * from "./growth-v19";
export * from "./p2b-lock-exits";
export * from "./p2b-earn";
export * from "./txv1";
