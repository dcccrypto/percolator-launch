/**
 * THE v2.2 adapter: the only module the app imports Devnet-v2.2 client ABI from.
 *
 * Pin: percolator-sdk draft PR #406 (branch `feat/v22-sdk`) @ d98488b (`@percolatorct/sdk` 9.0.0-candidate, NOT published), against the re-cut release candidate
 * (wrapper `release/v22-wrapper-rem` c6ee0b6e, engine bfa3d037). The files next to this one are verbatim local ports of that commit (layout.ts, v22-wire.ts,
 * v22-state.ts, v22-math.ts, v22-stake.ts, v22.ts, slab.ts, v22-lp-share.ts, v22-lp-share-ix.ts, v22-fill-events.ts and the v22 error rows; records/* keep the
 * header of the commit they last changed in: unchanged since ecb6215), with only the imports retargeted at the installed `@percolatorct/sdk` 8.0.0 and the v2.1
 * txv1 port. Same convention as ../../v21/sdk. When 9.0.0 ships: bump the dependency, replace these re-exports with `export * from "@percolatorct/sdk"`, delete the
 * sibling files. Nothing else in the app changes. See docs/V22-APP.md for the pin record and how to re-port.
 *
 * `slab.ts` is exported under its own namespace (`v22Slab`) because it re-declares every v2.1 slab decoder name (the guarded versions).
 */
export * from "./layout";
export * from "./v22-wire";
export * from "./v22-state";
export * from "./v22-math";
export * from "./v22-stake";
export * from "./v22-lot";
export * from "./v22-band";
export * from "./v22";
export * from "./v22-lp-share";
export * from "./v22-lp-share-ix";
export * from "./v22-fill-events";
export * from "./errors-v22";
export * as v22Slab from "./slab";
