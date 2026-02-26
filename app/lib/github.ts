/**
 * GitHub API helpers for the /developers page.
 * Fetches public repo metadata with Next.js ISR (5-min revalidation).
 */

export interface RepoData {
  name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
  pushed_at?: string;
  html_url: string;
  license?: { spdx_id: string } | null;
  default_branch?: string;
}

/** Aggregate contributor stats across all repos */
export interface ContributorStats {
  totalContributors: number;
  totalCommits: number;
  repoCount: number;
  totalOpenIssues: number;
  isActive: boolean;
}

/** Weekly commit activity for the heatmap */
export interface WeekActivity {
  /** Commits per day: [Sun, Mon, Tue, Wed, Thu, Fri, Sat] */
  days: number[];
  total: number;
  /** Unix timestamp for the start of the week (Sunday) */
  week: number;
}

/** Commit activity data keyed by repo name */
export type CommitActivityMap = Record<string, WeekActivity[]>;

/** Good first issue from GitHub search */
export interface GoodFirstIssue {
  title: string;
  html_url: string;
  repo: string;
  number: number;
  created_at: string;
}

/** CI status for a repo */
export interface RepoCIStatus {
  passing: boolean | null;
}

/** Hardcoded repo list — order determines fallback display order */
export const REPOS = [
  "percolator-launch",
  "percolator",
  "percolator-prog",
  "percolator-matcher",
  "percolator-stake",
  "percolator-sdk",
  "percolator-ops",
  "percolator-mobile",
] as const;

/** Fallback descriptions when GitHub API fails */
export const REPO_DESCRIPTIONS: Record<string, string> = {
  "percolator-launch":
    "Permissionless perpetual futures launcher — deploy a perp market for any Solana token",
  percolator: "Core on-chain program",
  "percolator-prog": "Percolator programs",
  "percolator-matcher":
    "Prediction market matcher program (Solana on-chain)",
  "percolator-stake":
    "Insurance LP staking — PDA admin architecture, Kani formal verification",
  "percolator-sdk":
    "TypeScript SDK for interacting with Percolator on-chain programs",
  "percolator-ops": "AI-powered ops dashboard",
  "percolator-mobile": "Solana Seeker mobile app",
};

/** Fallback languages */
export const REPO_LANGUAGES: Record<string, string> = {
  "percolator-launch": "TypeScript",
  percolator: "Rust",
  "percolator-prog": "Rust",
  "percolator-matcher": "Rust",
  "percolator-stake": "Rust",
  "percolator-sdk": "TypeScript",
  "percolator-ops": "TypeScript",
  "percolator-mobile": "TypeScript",
};

/** Language colour dots (GitHub standard) */
export const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  Rust: "#ce412b",
  JavaScript: "#f1e05a",
};

export const DEFAULT_LANGUAGE_COLOR = "rgba(255,255,255,0.25)";

/** Fetch a single repo's metadata from GitHub */
async function fetchRepo(repo: string): Promise<RepoData | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/dcccrypto/${repo}`,
      { next: { revalidate: 300 } } // ISR: 5-min cache
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/** Fetch all repos, returning live data merged with fallbacks */
export async function getAllRepos(): Promise<RepoData[]> {
  const results = await Promise.allSettled(REPOS.map(fetchRepo));

  return REPOS.map((name, i) => {
    const result = results[i];
    const live =
      result.status === "fulfilled" ? result.value : null;

    if (live) {
      // Merge fallback description when GitHub returns null (e.g. forks)
      return {
        ...live,
        description: live.description || REPO_DESCRIPTIONS[name] || null,
      };
    }

    // Fallback: return static data with a fixed date (avoid misleading "Updated 0m ago")
    return {
      name,
      description: REPO_DESCRIPTIONS[name] ?? null,
      language: REPO_LANGUAGES[name] ?? null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      updated_at: "", // empty signals "no live data available"
      html_url: `https://github.com/dcccrypto/${name}`,
    };
  });
}

/** Format "Updated X ago" from ISO date string */
export function timeAgo(dateStr: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ---------------------------------------------------------------------------
// New data fetching for PERC-188: developers page expansion
// ---------------------------------------------------------------------------

const githubHeaders: HeadersInit = {
  Accept: "application/vnd.github.v3+json",
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

/** Fetch contributor stats aggregated across all repos */
export async function getContributorStats(): Promise<ContributorStats> {
  const allLogins = new Set<string>();
  let totalCommits = 0;
  let totalOpenIssues = 0;
  let isActive = false;

  const results = await Promise.allSettled(
    REPOS.map(async (repo) => {
      // Fetch contributor stats (which includes commit counts)
      const res = await fetch(
        `https://api.github.com/repos/dcccrypto/${repo}/stats/contributors`,
        { headers: githubHeaders, next: { revalidate: 600 } }
      );

      // GitHub returns 202 on first request — retry once after 2s
      if (res.status === 202) {
        await new Promise((r) => setTimeout(r, 2000));
        const retry = await fetch(
          `https://api.github.com/repos/dcccrypto/${repo}/stats/contributors`,
          { headers: githubHeaders, next: { revalidate: 600 } }
        );
        if (!retry.ok) return [];
        return retry.json();
      }

      if (!res.ok) return [];
      return res.json();
    })
  );

  // Also fetch repo metadata for open_issues and pushed_at
  const repoResults = await Promise.allSettled(
    REPOS.map((repo) =>
      fetch(`https://api.github.com/repos/dcccrypto/${repo}`, {
        headers: githubHeaders,
        next: { revalidate: 600 },
      }).then((r) => (r.ok ? r.json() : null))
    )
  );

  results.forEach((result) => {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) return;
    result.value.forEach(
      (c: { author?: { login: string }; total: number }) => {
        if (c.author?.login) allLogins.add(c.author.login);
        totalCommits += c.total || 0;
      }
    );
  });

  repoResults.forEach((result) => {
    if (result.status !== "fulfilled" || !result.value) return;
    totalOpenIssues += result.value.open_issues_count || 0;
    if (result.value.pushed_at) {
      const daysSincePush =
        (Date.now() - new Date(result.value.pushed_at).getTime()) /
        (1000 * 60 * 60 * 24);
      if (daysSincePush < 7) isActive = true;
    }
  });

  return {
    totalContributors: allLogins.size,
    totalCommits,
    repoCount: REPOS.length,
    totalOpenIssues,
    isActive,
  };
}

/** Fetch 52-week commit activity for all repos */
export async function getAllCommitActivity(): Promise<CommitActivityMap> {
  const map: CommitActivityMap = {};

  const results = await Promise.allSettled(
    REPOS.map(async (repo) => {
      const res = await fetch(
        `https://api.github.com/repos/dcccrypto/${repo}/stats/commit_activity`,
        { headers: githubHeaders, next: { revalidate: 600 } }
      );

      // GitHub returns 202 on first request — retry once after 2s
      if (res.status === 202) {
        await new Promise((r) => setTimeout(r, 2000));
        const retry = await fetch(
          `https://api.github.com/repos/dcccrypto/${repo}/stats/commit_activity`,
          { headers: githubHeaders, next: { revalidate: 600 } }
        );
        if (!retry.ok) return { repo, data: [] };
        const data = await retry.json();
        return { repo, data: Array.isArray(data) ? data : [] };
      }

      if (!res.ok) return { repo, data: [] };
      const data = await res.json();
      return { repo, data: Array.isArray(data) ? data : [] };
    })
  );

  results.forEach((result) => {
    if (result.status !== "fulfilled") return;
    const { repo, data } = result.value;
    map[repo] = data;
  });

  return map;
}

/** Fetch good first issues across all repos */
export async function getGoodFirstIssues(): Promise<GoodFirstIssue[]> {
  try {
    const res = await fetch(
      `https://api.github.com/search/issues?q=org:dcccrypto+label:"good+first+issue"+state:open&sort=created&order=desc&per_page=6`,
      { headers: githubHeaders, next: { revalidate: 300 } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.items || !Array.isArray(data.items)) return [];

    return data.items.map(
      (item: {
        title: string;
        html_url: string;
        repository_url: string;
        number: number;
        created_at: string;
      }) => ({
        title: item.title,
        html_url: item.html_url,
        repo: item.repository_url.split("/").pop() || "",
        number: item.number,
        created_at: item.created_at,
      })
    );
  } catch {
    return [];
  }
}

/** Fetch CI status for a repo */
export async function getRepoCIStatus(
  repo: string
): Promise<RepoCIStatus> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/dcccrypto/${repo}/actions/runs?per_page=1&status=completed`,
      { headers: githubHeaders, next: { revalidate: 600 } }
    );
    if (!res.ok) return { passing: null };
    const data = await res.json();
    if (!data.workflow_runs || data.workflow_runs.length === 0) {
      return { passing: null };
    }
    return {
      passing: data.workflow_runs[0].conclusion === "success",
    };
  } catch {
    return { passing: null };
  }
}

/** Batch fetch CI status for all repos */
export async function getAllCIStatuses(): Promise<
  Record<string, RepoCIStatus>
> {
  const result: Record<string, RepoCIStatus> = {};
  const results = await Promise.allSettled(
    REPOS.map(async (repo) => ({
      repo,
      status: await getRepoCIStatus(repo),
    }))
  );

  results.forEach((r) => {
    if (r.status === "fulfilled") {
      result[r.value.repo] = r.value.status;
    }
  });

  return result;
}
