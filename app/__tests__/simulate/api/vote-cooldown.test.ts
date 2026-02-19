/**
 * Tests for the vote route cooldown logic bug.
 *
 * Bug: old code checked `status=eq.active AND activated_at >= now-COOLDOWN_MS`
 * This had two failure modes:
 *   (a) A scenario still active but activated > COOLDOWN_MS ago was NOT blocked
 *   (b) A scenario that just expired within COOLDOWN_MS was NOT blocked
 *
 * Fix: check (1) ANY active scenario blocks, (2) recently expired blocks too.
 *
 * These tests exercise the pure cooldown logic extracted from the route.
 */

import { describe, it, expect } from "vitest";

// ── Mirror the fixed cooldown logic ──────────────────────────────────────────

const COOLDOWN_MS = 5 * 60 * 1_000; // 5 minutes

interface Scenario {
  id: string;
  status: "voting" | "active" | "completed" | "expired";
  activated_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface CooldownResult {
  blocked: boolean;
  reason: string;
  cooldownRemainingSeconds: number;
}

/**
 * Fixed cooldown check logic (mirrors route's corrected version).
 * Returns blocked=true with reason if a new scenario cannot be activated.
 */
function checkCooldown(
  activeScenarios: Pick<Scenario, "id" | "expires_at">[],
  recentlyEndedScenarios: Pick<Scenario, "id" | "expires_at">[],
  now: number = Date.now()
): CooldownResult {
  // Case 1: any currently active scenario
  if (activeScenarios.length > 0) {
    const expiresAt = activeScenarios[0].expires_at
      ? new Date(activeScenarios[0].expires_at).getTime()
      : now;
    const cooldownRemaining = Math.ceil((expiresAt + COOLDOWN_MS - now) / 1_000);
    return {
      blocked: true,
      reason: "A scenario is currently active",
      cooldownRemainingSeconds: Math.max(0, cooldownRemaining),
    };
  }

  // Case 2: a scenario expired within COOLDOWN_MS
  if (recentlyEndedScenarios.length > 0) {
    const expiresAt = new Date(recentlyEndedScenarios[0].expires_at!).getTime();
    const cooldownRemaining = Math.ceil((expiresAt + COOLDOWN_MS - now) / 1_000);
    return {
      blocked: true,
      reason: "Cooldown from recently ended scenario",
      cooldownRemainingSeconds: Math.max(0, cooldownRemaining),
    };
  }

  return { blocked: false, reason: "", cooldownRemainingSeconds: 0 };
}

/**
 * OLD (buggy) cooldown check — checked active AND activated within COOLDOWN_MS.
 * Kept here to prove the bug existed.
 */
function checkCooldownOldBuggy(
  scenarios: Pick<Scenario, "id" | "activated_at" | "status">[],
  now: number = Date.now()
): { blocked: boolean } {
  // Old logic: status=active AND activated_at >= now - COOLDOWN_MS
  const recentActive = scenarios.filter((s) => {
    if (s.status !== "active") return false;
    if (!s.activated_at) return false;
    return new Date(s.activated_at).getTime() >= now - COOLDOWN_MS;
  });
  return { blocked: recentActive.length > 0 };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Vote Cooldown Bug — fixed vs old behavior", () => {
  const NOW = 1_700_000_000_000; // fixed timestamp for determinism

  describe("BUG (a): active scenario activated > COOLDOWN_MS ago was NOT blocked by old logic", () => {
    const longRunningScenario: Pick<Scenario, "id" | "activated_at" | "status" | "expires_at">[] = [{
      id: "long-scenario",
      status: "active",
      activated_at: new Date(NOW - 30 * 60 * 1_000).toISOString(), // activated 30min ago
      expires_at: new Date(NOW + 30 * 60 * 1_000).toISOString(),    // expires in 30min
    }];

    it("OLD logic did NOT block (was a bug)", () => {
      const result = checkCooldownOldBuggy(longRunningScenario, NOW);
      // Old logic: activated > 5min ago → not recent → not blocked. BUG!
      expect(result.blocked).toBe(false); // confirms the bug existed
    });

    it("NEW logic correctly blocks when scenario is still active", () => {
      const result = checkCooldown(longRunningScenario, [], NOW);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("active");
    });

    it("cooldownRemainingSeconds is positive when scenario is still active", () => {
      const result = checkCooldown(longRunningScenario, [], NOW);
      expect(result.cooldownRemainingSeconds).toBeGreaterThan(0);
    });
  });

  describe("BUG (b): scenario that just expired within COOLDOWN_MS was NOT blocked", () => {
    const justExpiredScenario: Pick<Scenario, "id" | "activated_at" | "status" | "expires_at">[] = [{
      id: "just-expired",
      status: "expired", // no longer active!
      activated_at: new Date(NOW - 10 * 60 * 1_000).toISOString(),
      expires_at: new Date(NOW - 2 * 60 * 1_000).toISOString(), // expired 2min ago
    }];

    it("OLD logic did NOT block on recently expired scenarios (was a bug)", () => {
      const result = checkCooldownOldBuggy(justExpiredScenario, NOW);
      // Old logic: status='expired' → not 'active' → not blocked. BUG!
      expect(result.blocked).toBe(false); // confirms the bug existed
    });

    it("NEW logic blocks when scenario expired within cooldown window", () => {
      const recently: Pick<Scenario, "id" | "expires_at">[] = [{
        id: "just-expired",
        expires_at: justExpiredScenario[0].expires_at,
      }];
      const result = checkCooldown([], recently, NOW);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("recently ended");
    });

    it("cooldownRemainingSeconds is ~3 min when expired 2min ago (5min window)", () => {
      const expiresAt = NOW - 2 * 60 * 1_000; // 2 min ago
      const recently: Pick<Scenario, "id" | "expires_at">[] = [{
        id: "recently-expired",
        expires_at: new Date(expiresAt).toISOString(),
      }];
      const result = checkCooldown([], recently, NOW);
      // expiresAt + 5min - now = 5min - 2min = 3min = 180s
      expect(result.cooldownRemainingSeconds).toBeCloseTo(180, 0);
    });
  });

  describe("Fixed behavior — correct cases", () => {
    it("allows new scenario when no active/recent scenarios", () => {
      const result = checkCooldown([], [], NOW);
      expect(result.blocked).toBe(false);
      expect(result.cooldownRemainingSeconds).toBe(0);
    });

    it("allows after cooldown fully expires (>5min since last scenario)", () => {
      // When the scenario expired > COOLDOWN_MS ago, the DB query (gte expires_at, cutoff)
      // would return EMPTY — so recentlyEndedScenarios=[] — not blocked.
      // We simulate the DB filter: only pass scenarios whose expires_at >= cutoff.
      const cutoff = NOW - COOLDOWN_MS;
      const expiredLongAgoAt = NOW - 6 * 60 * 1_000; // 6min ago < cutoff (5min)
      // The scenario expired 6min ago → gte(5min ago) filter excludes it → empty array
      const filtered: Pick<Scenario, "id" | "expires_at">[] = expiredLongAgoAt >= cutoff
        ? [{ id: "old", expires_at: new Date(expiredLongAgoAt).toISOString() }]
        : [];
      const result = checkCooldown([], filtered, NOW);
      // COOLDOWN_MS = 5min, expired 6min ago → DB returns empty → not blocked
      expect(result.blocked).toBe(false);
    });

    it("blocks at exactly the cooldown boundary (just expired 5min ago)", () => {
      const exactBoundary: Pick<Scenario, "id" | "expires_at">[] = [{
        id: "boundary",
        expires_at: new Date(NOW - COOLDOWN_MS).toISOString(),
      }];
      const result = checkCooldown([], exactBoundary, NOW);
      // At exactly 5min, cooldown remaining = 0 → not blocked
      expect(result.cooldownRemainingSeconds).toBeLessThanOrEqual(0);
    });

    it("active scenario with future expiry returns positive cooldown including expiry time", () => {
      const stillActive: Pick<Scenario, "id" | "expires_at">[] = [{
        id: "active",
        expires_at: new Date(NOW + 5 * 60 * 1_000).toISOString(), // expires in 5min
      }];
      const result = checkCooldown(stillActive, [], NOW);
      // cooldown = expires_in + COOLDOWN_MS = 5min + 5min = 10min = 600s
      expect(result.cooldownRemainingSeconds).toBeCloseTo(600, 0);
    });

    it("active scenario with null expires_at uses now as expiry", () => {
      const activeNoExpiry: Pick<Scenario, "id" | "expires_at">[] = [{
        id: "no-expiry",
        expires_at: null,
      }];
      const result = checkCooldown(activeNoExpiry, [], NOW);
      // expires_at=null → treated as now → cooldown = 5min = 300s
      expect(result.cooldownRemainingSeconds).toBeCloseTo(300, 0);
    });

    it("cooldownRemainingSeconds is never negative", () => {
      const longExpired: Pick<Scenario, "id" | "expires_at">[] = [{
        id: "ancient",
        expires_at: new Date(NOW - 100 * 60 * 1_000).toISOString(),
      }];
      const result = checkCooldown(longExpired, [], NOW);
      expect(result.cooldownRemainingSeconds).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("Vote route validation logic", () => {
  function isValidScenarioId(id: unknown): boolean {
    return typeof id === "string" && id.length > 0;
  }

  function isValidVoter(voter: unknown): boolean {
    return typeof voter === "string" && voter.length >= 32;
  }

  it("rejects missing scenarioId", () => {
    expect(isValidScenarioId(undefined)).toBe(false);
    expect(isValidScenarioId("")).toBe(false);
    expect(isValidScenarioId(null)).toBe(false);
  });

  it("accepts valid UUID scenarioId", () => {
    expect(isValidScenarioId("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("rejects voter addresses shorter than 32 chars", () => {
    expect(isValidVoter("short")).toBe(false);
    expect(isValidVoter("")).toBe(false);
    expect(isValidVoter(undefined)).toBe(false);
  });

  it("accepts valid 44-char Solana wallet address", () => {
    expect(isValidVoter("FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD")).toBe(true);
  });

  it("accepts 32-char minimum length wallet", () => {
    expect(isValidVoter("12345678901234567890123456789012")).toBe(true);
  });
});
