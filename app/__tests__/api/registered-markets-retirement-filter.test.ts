/**
 * The keeper was the last place a retired market survived.
 *
 * /api/playground/registered-markets is backed by an append-only Vercel Blob, so
 * a market registered by the wizard stays in it forever. The oracle keeper polls
 * this endpoint every 30s and adds anything it doesn't know — which meant that
 * clearing the keeper's local registry.json achieved nothing: this endpoint
 * handed the retired markets straight back on the next poll, and it kept pushing
 * AUTH_MARK prices to slabs that were blocklisted in the UI and deleted from the
 * database.
 *
 * These tests pin the two-stage filter that fixed it, and — importantly — the
 * degradation rule, because getting that backwards would stop the keeper pricing
 * ANY market during a database blip.
 */
import { describe, it, expect } from "vitest";

type Entry = { slabAddress: string };

/**
 * Mirrors the route's filter. Kept deliberately small and pure so the rule is
 * testable without standing up Blob + Supabase.
 */
function applyRetirementFilter(
  all: Entry[],
  blocked: ReadonlySet<string>,
  live: Set<string> | null,
): Entry[] {
  const notBlocked = all.filter((m) => !blocked.has(m.slabAddress));
  return live === null ? notBlocked : notBlocked.filter((m) => live.has(m.slabAddress));
}

const RETIRED = "7FBXdrm1vQ4ktQJjMwurq4cAHkVB1gKoZ7Hx3CAQv6P4";
const NEW = "SoMeFreshlyLaunchedMarket1111111111111111111";

describe("registered-markets retirement filter", () => {
  it("drops a blocklisted market even if the DB still lists it", () => {
    const out = applyRetirementFilter(
      [{ slabAddress: RETIRED }, { slabAddress: NEW }],
      new Set([RETIRED]),
      new Set([RETIRED, NEW]),
    );
    expect(out.map((m) => m.slabAddress)).toEqual([NEW]);
  });

  it("drops a market deleted from the DB without needing it named", () => {
    // The whole point of stage 2: retiring a market should not require also
    // adding it to a list here.
    const out = applyRetirementFilter(
      [{ slabAddress: RETIRED }, { slabAddress: NEW }],
      new Set(),
      new Set([NEW]),
    );
    expect(out.map((m) => m.slabAddress)).toEqual([NEW]);
  });

  it("serves a freshly launched market so the keeper starts pricing it", () => {
    const out = applyRetirementFilter([{ slabAddress: NEW }], new Set(), new Set([NEW]));
    expect(out).toHaveLength(1);
  });

  it("returns EMPTY when the DB is empty — nothing live means nothing to price", () => {
    const out = applyRetirementFilter([{ slabAddress: RETIRED }], new Set(), new Set());
    expect(out).toEqual([]);
  });

  it("degrades to blocklist-only when the DB is unreachable, not to empty", () => {
    // If a DB blip returned an empty set instead of null, the keeper would stop
    // pricing every market. null must mean "skip this filter".
    const out = applyRetirementFilter(
      [{ slabAddress: RETIRED }, { slabAddress: NEW }],
      new Set([RETIRED]),
      null,
    );
    expect(out.map((m) => m.slabAddress)).toEqual([NEW]);
  });
});
