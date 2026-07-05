import type { Metadata } from "next";
import {
  getAllRepos,
  getContributorStats,
  getAllCommitActivity,
  getGoodFirstIssues,
  getAllCIStatuses,
  REPOS,
  type CommitActivityMap,
} from "@/lib/github";
import { DevelopersClient } from "./DevelopersClient";

export const metadata: Metadata = {
  title: "Developers - Percolator",
  description:
    "Open-source repos powering Percolator permissionless perpetuals on Solana. Browse, fork, and contribute.",
  openGraph: {
    title: "Developers - Percolator",
    description:
      "Open-source repos powering Percolator permissionless perpetuals on Solana.",
    type: "website",
  },
};

export default async function DevelopersPage() {
  // Fetch all data in parallel — allSettled ensures one failure never breaks the page
  const [repos, contributorStats, commitActivity, goodFirstIssues, ciStatuses] =
    await Promise.allSettled([
      getAllRepos(),
      getContributorStats(),
      getAllCommitActivity(),
      getGoodFirstIssues(),
      getAllCIStatuses(),
    ]);

  const repoData = repos.status === "fulfilled" ? repos.value : [];
  const isLive = repoData.some(
    (r) => r.stargazers_count > 0 || r.forks_count > 0
  );

  // Compute totalCommits from commitActivity, but ONLY if all repos returned
  // data. GitHub's stats endpoint responds with 202 (cache being built) for
  // repos whose stats are cold — a partial response covers only the repos that
  // were already cached and produces an artificially low number (e.g. 1,272
  // instead of 2,817).  When the coverage check fails, fall back to the value
  // computed by getContributorStats(), which retries 202s and is more reliable.
  const commitActivityData: CommitActivityMap =
    commitActivity.status === "fulfilled" ? commitActivity.value : {};
  const reposCovered = Object.keys(commitActivityData).length;
  const allReposCovered = reposCovered >= REPOS.length;
  const totalCommitsFromActivity = allReposCovered
    ? Object.values(commitActivityData)
        .flat()
        .reduce((sum, w) => sum + (w.total || 0), 0)
    : 0;

  const rawContributorStats =
    contributorStats.status === "fulfilled" ? contributorStats.value : null;
  // Override totalCommits only when commitActivity covered every repo;
  // otherwise trust getContributorStats() to avoid showing a partial count.
  const resolvedContributorStats =
    rawContributorStats && allReposCovered && totalCommitsFromActivity > 0
      ? { ...rawContributorStats, totalCommits: totalCommitsFromActivity }
      : rawContributorStats;

  return (
    <DevelopersClient
      repos={repoData}
      isLive={isLive}
      contributorStats={resolvedContributorStats}
      commitActivity={
        commitActivity.status === "fulfilled" ? commitActivity.value : null
      }
      goodFirstIssues={
        goodFirstIssues.status === "fulfilled" ? goodFirstIssues.value : []
      }
      ciStatuses={
        ciStatuses.status === "fulfilled" ? ciStatuses.value : {}
      }
    />
  );
}
