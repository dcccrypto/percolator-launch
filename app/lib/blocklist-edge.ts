// EDGE-PURE blocklist — imported ONLY by middleware.ts.
//
// This used to be a hand-maintained SECOND COPY of every blocked address,
// kept in sync with lib/blocklist.ts by a test. It no longer is: both files
// import the same array from lib/blocklist-data.ts, so there is exactly ONE
// place to add an address and drift is impossible by construction.
//
// The isolation requirement that forced the duplication still holds, and
// blocklist-data.ts is what satisfies it: that module is pure data (zero
// imports, zero side effects, no `process.env`), so the Edge bundle stays
// clean. Importing lib/blocklist.ts here would NOT — it layers env-var
// overrides on top and is pulled in by many Node-runtime route handlers,
// which co-bundles Node-only code and makes Vercel's deploy-time Edge
// validator reject the build:
//   The Edge Function "middleware" is referencing unsupported modules
//
// Env-var overrides are intentionally still omitted here — the API-layer
// blocklist (lib/blocklist.ts) applies those.
import { HARDCODED_BLOCKED_SLABS } from "./blocklist-data";

export const BLOCKED_SLAB_ADDRESSES: ReadonlySet<string> = new Set<string>(
  HARDCODED_BLOCKED_SLABS,
);
