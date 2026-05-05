/** Chart drawing tools — type definitions, validation, and persistence
 *  envelope. Pure data layer; no React, no DOM, no chart-library dependency.
 *
 *  Time convention: `time` is milliseconds since epoch, matching Date.now()
 *  and the rest of the chart code's internal format. Conversion to
 *  lightweight-charts' UTCTimestamp (seconds) happens at the rendering
 *  boundary in chart-coords.ts (commit 2). Keeping the math layer in ms
 *  removes a class of unit-confusion bugs.
 */

/** A single anchor point on the chart — used as endpoints by trend lines
 *  and rectangles. Drawings persist anchors in price/time space (NOT pixel
 *  coordinates) so they stay glued to the same bar across pan, zoom, and
 *  timeframe changes. */
export interface PricePoint {
  /** Milliseconds since epoch. */
  time: number;
  /** Price in the chart's quote units (USDC for SOL/USDC perp, etc.). */
  price: number;
}

/** All drawing kinds supported in v1. Adding a new kind is a four-step
 *  diff: append the variant here, append `isDrawing` validation, append
 *  `renderConfig` branch in the overlay, append the toolbar button. The
 *  exhaustive switch + assertNever in the renderer catches the missing
 *  branch at compile time. */
export type Drawing =
  | { id: string; kind: "trend"; p1: PricePoint; p2: PricePoint }
  | { id: string; kind: "horizontal"; price: number }
  | { id: string; kind: "rectangle"; p1: PricePoint; p2: PricePoint };

/** Discriminator helper — every kind in the Drawing union. */
export type DrawingKind = Drawing["kind"];

/** Single source of truth for the kinds the runtime validator accepts.
 *  Typed as `Record<DrawingKind, true>` so adding a kind to the Drawing
 *  union forces a compile error here (missing key). The previous
 *  hand-maintained `Set<DrawingKind>` could silently desync from the
 *  union and drop user-stored entries on read. */
const VALID_KIND_TABLE: Record<DrawingKind, true> = {
  trend: true,
  horizontal: true,
  rectangle: true,
};

/** Active drawing tool from the user's toolbar. `pointer` is the default
 *  (select / delete existing drawings). The other values match Drawing
 *  kinds for the creation flow. Persisted separately from drawings
 *  themselves (different key — drawings are per-slab; tool selection is
 *  global so the user's tool of choice survives across markets). */
export type DrawingTool = "pointer" | "trend" | "horizontal" | "rectangle";

/** Distribute Omit over a discriminated union — built-in Omit collapses
 *  to common keys via `keyof`, dropping per-variant fields like `p1` and
 *  `price`. The conditional-type trick forces per-variant distribution. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Shape accepted by `addDrawing` — the same as Drawing minus the `id`
 *  field, which the hook generates via crypto.randomUUID() so callers
 *  can't accidentally collide ids. Distributive so each variant retains
 *  its per-kind fields. */
export type DrawingInput = DistributiveOmit<Drawing, "id">;

/** Versioned storage envelope. Bumping the version triggers a migration
 *  path in mergeDrawings; v1 readers see future-version blobs and fall
 *  back to defaults rather than crash-parsing. */
export interface DrawingsStorage {
  version: number;
  drawings: Drawing[];
}

/** Current storage envelope version. Bump ONLY for backwards-INCOMPATIBLE
 *  changes (renaming or removing a field, changing units, restructuring
 *  the discriminator). Additive changes — adding an optional field to a
 *  variant, adding a new kind — do NOT need a version bump because
 *  isDrawing's tolerant validation accepts older payloads unchanged.
 *  Reserving bumps for breaking changes lets v1 readers see additive v1
 *  payloads from newer clients without losing the entire drawings list
 *  to a version mismatch. */
export const DRAWINGS_STORAGE_VERSION = 1;

/** Per-slab cap on persisted drawings. Picked at 100 because:
 *  - Far above any realistic single-trader workflow (< 20 typical).
 *  - Well below localStorage's 5-10 MB per-origin limit even at
 *    ~200 bytes per drawing.
 *  - Bounded enough that mergeDrawings' linear scan stays sub-ms. */
export const MAX_DRAWINGS_PER_SLAB = 100;

// =====================================================================
// Validation
// =====================================================================

/** Strict runtime check for the PricePoint shape. Both fields must be
 *  finite numbers — NaN, Infinity, and missing values fail. */
function isPricePoint(value: unknown): value is PricePoint {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.time === "number" &&
    Number.isFinite(p.time) &&
    typeof p.price === "number" &&
    Number.isFinite(p.price)
  );
}

/** Strict runtime check that a value is a well-formed Drawing. Intentionally
 *  rejects unknown `kind` values rather than throwing — readers of older
 *  app versions can encounter newer kinds and we'd rather drop them than
 *  crash the chart.
 *
 *  Also rejects entries carrying prototype-related own keys. `JSON.parse`
 *  intentionally treats `__proto__` as an own string property, NOT a
 *  prototype slot, so it doesn't pollute at parse time. But any future
 *  consumer that spreads a drawing into an object literal
 *  (`{ ...drawing, ...overrides }`) would re-apply the own `__proto__`
 *  key as the actual prototype. Defusing here means every spread site in
 *  the rendering pipeline can stay simple. */
export function isDrawing(value: unknown): value is Drawing {
  if (value === null || typeof value !== "object") return false;
  if (
    Object.hasOwn(value, "__proto__") ||
    Object.hasOwn(value, "constructor") ||
    Object.hasOwn(value, "prototype")
  ) {
    return false;
  }
  const d = value as Record<string, unknown>;
  if (typeof d.id !== "string" || d.id.length === 0) return false;
  if (typeof d.kind !== "string") return false;
  if (!Object.hasOwn(VALID_KIND_TABLE, d.kind)) return false;
  switch (d.kind as DrawingKind) {
    case "trend":
    case "rectangle":
      return isPricePoint(d.p1) && isPricePoint(d.p2);
    case "horizontal":
      return typeof d.price === "number" && Number.isFinite(d.price);
    default: {
      // Compile-error guard: if a future kind is added to the Drawing
      // union without a case here, `_exhaustive: never` fails to type-
      // check because `d.kind` (post-narrowing) still has the unhandled
      // variant. VALID_KIND_TABLE above also fails to type-check on the
      // missing key, so two independent compile-time failure points
      // cover the four-step diff promised in the docs.
      const _exhaustive: never = d.kind as never;
      return false;
    }
  }
}

// =====================================================================
// Tolerant deserializer
// =====================================================================

/** Parse the raw localStorage payload into a clean Drawing[]. Tolerant
 *  by design — malformed entries are silently dropped rather than
 *  rejected wholesale, so a single corrupted drawing doesn't lose the
 *  user's whole set.
 *
 *  Failure modes handled:
 *  - Non-object payloads (string, number, null) → []
 *  - Missing or future-version envelope → []
 *  - `drawings` field not an array → []
 *  - Individual entries that fail isDrawing → dropped (other entries kept)
 *  - More than MAX_DRAWINGS_PER_SLAB entries → trimmed to the cap
 *
 *  Bare-array reads (a previous version of this format that wasn't
 *  envelope-wrapped) are ALSO accepted defensively — if `parsed` is an
 *  array directly, we treat it as a v1 drawings list. This lets a
 *  hypothetical pre-envelope user upgrade without losing data, and
 *  matches the indicator-registry's tolerant pattern. */
export function mergeDrawings(parsed: unknown): Drawing[] {
  if (parsed === null || typeof parsed !== "object") return [];

  let raw: unknown;
  if (Array.isArray(parsed)) {
    // Bare-array legacy / defensive path. No version field — accept and
    // let isDrawing filter individual entries.
    raw = parsed;
  } else {
    const envelope = parsed as Record<string, unknown>;
    // Strict equality on the version field. A missing, non-numeric, or
    // wrong-numeric version drops the whole list — the current reader
    // must not guess at envelope shapes it doesn't recognize. NaN never
    // equals DRAWINGS_STORAGE_VERSION so it's correctly dropped here.
    if (envelope.version !== DRAWINGS_STORAGE_VERSION) {
      return [];
    }
    raw = envelope.drawings;
  }

  if (!Array.isArray(raw)) return [];

  const result: Drawing[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    if (!isDrawing(entry)) continue;
    if (seenIds.has(entry.id)) continue; // dedupe; first wins
    seenIds.add(entry.id);
    result.push(entry);
    if (result.length >= MAX_DRAWINGS_PER_SLAB) break;
  }
  return result;
}
