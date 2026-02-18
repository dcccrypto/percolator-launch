import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Testable scenario logic ────────────────────────────────────────────────

const VALID_SCENARIO_TYPES = ["crash", "squeeze", "blackswan", "volatility", "trend"] as const;
type ScenarioType = typeof VALID_SCENARIO_TYPES[number];

const VOTE_THRESHOLD = 3;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const PROPOSAL_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface Scenario {
  id: string;
  scenario_type: ScenarioType;
  proposed_by: string;
  votes: string[];
  vote_count: number;
  status: "voting" | "active" | "completed" | "expired";
  activated_at: string | null;
  expires_at: string | null;
  created_at: string;
}

function isValidScenarioType(type: string): type is ScenarioType {
  return VALID_SCENARIO_TYPES.includes(type as ScenarioType);
}

function canPropose(
  activeScenarios: Scenario[],
  votingScenarios: Scenario[],
  type: ScenarioType,
  now: number
): { allowed: boolean; reason?: string } {
  // Check cooldown from last active scenario
  const lastActive = activeScenarios
    .filter((s) => s.expires_at)
    .sort((a, b) => new Date(b.expires_at!).getTime() - new Date(a.expires_at!).getTime())[0];

  if (lastActive && lastActive.expires_at) {
    const expiresAt = new Date(lastActive.expires_at).getTime();
    if (now < expiresAt + COOLDOWN_MS) {
      return { allowed: false, reason: "Cooldown active" };
    }
  }

  // Check if there's already a voting scenario of same type
  if (votingScenarios.some((s) => s.scenario_type === type)) {
    return { allowed: false, reason: "Duplicate scenario type already voting" };
  }

  // Check if there's an active scenario
  if (activeScenarios.some((s) => s.status === "active")) {
    return { allowed: false, reason: "A scenario is already active" };
  }

  return { allowed: true };
}

function canVote(
  scenario: Scenario,
  voterWallet: string,
  now: number
): { allowed: boolean; reason?: string } {
  if (scenario.status !== "voting") {
    return { allowed: false, reason: "Scenario is not in voting state" };
  }

  if (scenario.votes.includes(voterWallet)) {
    return { allowed: false, reason: "Already voted" };
  }

  const createdAt = new Date(scenario.created_at).getTime();
  if (now > createdAt + PROPOSAL_TTL_MS) {
    return { allowed: false, reason: "Proposal expired" };
  }

  return { allowed: true };
}

function applyVote(scenario: Scenario, voterWallet: string): Scenario {
  const newVotes = [...scenario.votes, voterWallet];
  const newCount = newVotes.length;
  const activated = newCount >= VOTE_THRESHOLD;

  return {
    ...scenario,
    votes: newVotes,
    vote_count: newCount,
    status: activated ? "active" : "voting",
    activated_at: activated ? new Date().toISOString() : null,
    expires_at: activated ? getScenarioExpiry(scenario.scenario_type) : null,
  };
}

function getScenarioDurationMs(type: ScenarioType): number {
  const durations: Record<ScenarioType, number> = {
    crash: 60_000,
    squeeze: 120_000,
    blackswan: 600_000,
    volatility: 300_000,
    trend: 1_800_000,
  };
  return durations[type];
}

function getScenarioExpiry(type: ScenarioType): string {
  return new Date(Date.now() + getScenarioDurationMs(type)).toISOString();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Scenarios: isValidScenarioType", () => {
  it("accepts all valid types", () => {
    for (const type of VALID_SCENARIO_TYPES) {
      expect(isValidScenarioType(type)).toBe(true);
    }
  });

  it("rejects invalid types", () => {
    expect(isValidScenarioType("invalid")).toBe(false);
    expect(isValidScenarioType("")).toBe(false);
    expect(isValidScenarioType("CRASH")).toBe(false);
  });
});

describe("Scenarios: canPropose", () => {
  const NOW = Date.now();

  it("allows proposal when no active or voting scenarios", () => {
    const result = canPropose([], [], "crash", NOW);
    expect(result.allowed).toBe(true);
  });

  it("rejects during cooldown", () => {
    const active = makeScenario({
      status: "active",
      expires_at: new Date(NOW - 60_000).toISOString(), // expired 1 min ago, but cooldown is 5 min
    });
    const result = canPropose([active], [], "crash", NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Cooldown");
  });

  it("allows after cooldown expires", () => {
    const completed = makeScenario({
      status: "completed" as any,
      expires_at: new Date(NOW - 6 * 60 * 1000).toISOString(), // expired 6 min ago
    });
    const result = canPropose([completed], [], "crash", NOW);
    expect(result.allowed).toBe(true);
  });

  it("rejects duplicate scenario type in voting", () => {
    const voting = makeScenario({ scenario_type: "crash", status: "voting" });
    const result = canPropose([], [voting], "crash", NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Duplicate");
  });

  it("allows different type when another is voting", () => {
    const voting = makeScenario({ scenario_type: "crash", status: "voting" });
    const result = canPropose([], [voting], "squeeze", NOW);
    expect(result.allowed).toBe(true);
  });

  it("rejects when a scenario is active", () => {
    const active = makeScenario({
      status: "active",
      expires_at: new Date(NOW + 60_000).toISOString(), // still active
    });
    const result = canPropose([active], [], "crash", NOW);
    expect(result.allowed).toBe(false);
  });
});

describe("Scenarios: canVote", () => {
  const NOW = Date.now();

  it("allows voting on valid proposal", () => {
    const scenario = makeScenario({ status: "voting", created_at: new Date(NOW - 60_000).toISOString() });
    const result = canVote(scenario, "voter1", NOW);
    expect(result.allowed).toBe(true);
  });

  it("rejects voting on non-voting scenario", () => {
    const scenario = makeScenario({ status: "active" });
    const result = canVote(scenario, "voter1", NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in voting");
  });

  it("rejects double voting", () => {
    const scenario = makeScenario({
      status: "voting",
      votes: ["voter1"],
      created_at: new Date(NOW - 60_000).toISOString(),
    });
    const result = canVote(scenario, "voter1", NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Already voted");
  });

  it("rejects expired proposal", () => {
    const scenario = makeScenario({
      status: "voting",
      created_at: new Date(NOW - 6 * 60 * 1000).toISOString(), // 6 min ago
    });
    const result = canVote(scenario, "voter1", NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("allows vote just before expiry", () => {
    const scenario = makeScenario({
      status: "voting",
      created_at: new Date(NOW - 4 * 60 * 1000).toISOString(), // 4 min ago (1 min left)
    });
    const result = canVote(scenario, "voter1", NOW);
    expect(result.allowed).toBe(true);
  });
});

describe("Scenarios: applyVote", () => {
  it("adds voter to votes array", () => {
    const scenario = makeScenario({ votes: ["a"], vote_count: 1, status: "voting" });
    const result = applyVote(scenario, "b");
    expect(result.votes).toEqual(["a", "b"]);
    expect(result.vote_count).toBe(2);
    expect(result.status).toBe("voting");
  });

  it("activates at threshold (3 votes)", () => {
    const scenario = makeScenario({ votes: ["a", "b"], vote_count: 2, status: "voting" });
    const result = applyVote(scenario, "c");
    expect(result.vote_count).toBe(3);
    expect(result.status).toBe("active");
    expect(result.activated_at).toBeTruthy();
    expect(result.expires_at).toBeTruthy();
  });

  it("does not activate below threshold", () => {
    const scenario = makeScenario({ votes: [], vote_count: 0, status: "voting" });
    const result = applyVote(scenario, "a");
    expect(result.status).toBe("voting");
    expect(result.activated_at).toBeNull();
  });

  it("sets correct expiry for crash scenario", () => {
    const before = Date.now();
    const scenario = makeScenario({ votes: ["a", "b"], vote_count: 2, scenario_type: "crash" });
    const result = applyVote(scenario, "c");
    const expiryTime = new Date(result.expires_at!).getTime();
    // Crash = 60s
    expect(expiryTime).toBeGreaterThanOrEqual(before + 55_000);
    expect(expiryTime).toBeLessThanOrEqual(before + 65_000);
  });

  it("sets correct expiry for trend scenario", () => {
    const before = Date.now();
    const scenario = makeScenario({ votes: ["a", "b"], vote_count: 2, scenario_type: "trend" });
    const result = applyVote(scenario, "c");
    const expiryTime = new Date(result.expires_at!).getTime();
    // Trend = 1800s = 30 min
    expect(expiryTime).toBeGreaterThanOrEqual(before + 1_795_000);
    expect(expiryTime).toBeLessThanOrEqual(before + 1_805_000);
  });
});

describe("Scenarios: getScenarioDurationMs", () => {
  it("crash = 60s", () => expect(getScenarioDurationMs("crash")).toBe(60_000));
  it("squeeze = 120s", () => expect(getScenarioDurationMs("squeeze")).toBe(120_000));
  it("blackswan = 600s", () => expect(getScenarioDurationMs("blackswan")).toBe(600_000));
  it("volatility = 300s", () => expect(getScenarioDurationMs("volatility")).toBe(300_000));
  it("trend = 1800s", () => expect(getScenarioDurationMs("trend")).toBe(1_800_000));
});

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "test-id",
    scenario_type: "crash",
    proposed_by: "proposer1",
    votes: [],
    vote_count: 0,
    status: "voting",
    activated_at: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
