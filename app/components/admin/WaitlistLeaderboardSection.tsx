"use client";

import { useState } from "react";
import useSWR from "swr";

const card = "rounded-none bg-[var(--panel-bg)] border border-[var(--border)]";
const labelStyle =
  "text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]";

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className={labelStyle}>{children}</div>
      <div className="flex-1 h-px bg-[var(--border)]" />
    </div>
  );
}

interface AdminLeaderboardEntry {
  rank: number;
  referralCode: string;
  ownerPubkey: string | null;
  ownerEmail: string | null;
  twitterHandle: string | null;
  signupsReferred: number;
  joinedAt: string;
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

function truncatePubkey(pubkey: string | null): string {
  if (!pubkey) return "—";
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

/**
 * Operator view of who's brought in the most waitlist signups.
 *
 * Backed by /api/admin/waitlist/leaderboard (requireAdminSession +
 * service-role read of waitlist_referral_leaderboard()). Returns full
 * identifiers — referral_code, pubkey, email, twitter_handle — so the
 * operator can correlate attribution with on-chain or off-chain
 * activity for that referrer.
 *
 * This is NOT a public-facing leaderboard. Adding one of those needs
 * a sanitisation layer + sign-off on the gamification surface.
 */
export function WaitlistLeaderboardSection() {
  const [limit, setLimit] = useState<10 | 25 | 100>(25);
  const { data, error, isLoading, mutate } = useSWR<{
    leaderboard: AdminLeaderboardEntry[];
  }>("/api/admin/waitlist/leaderboard", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });

  const rows = (data?.leaderboard ?? []).slice(0, limit);
  const totalReferrers = data?.leaderboard.length ?? 0;
  const totalSignupsAttributed = (data?.leaderboard ?? []).reduce(
    (sum, r) => sum + r.signupsReferred,
    0,
  );

  return (
    <div className="mb-8">
      <SectionHeader>Waitlist Referral Leaderboard</SectionHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className={`${card} p-4`}>
          <div className={labelStyle}>Active Referrers</div>
          <div className="text-3xl font-bold mt-1 text-[var(--cyan)]">
            {totalReferrers.toLocaleString()}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            with ≥ 1 invitee
          </div>
        </div>

        <div className={`${card} p-4`}>
          <div className={labelStyle}>Attributed Signups</div>
          <div
            className="text-3xl font-bold mt-1"
            style={{ color: "var(--accent)" }}
          >
            {totalSignupsAttributed.toLocaleString()}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            joined via a code
          </div>
        </div>

        <div className={`${card} p-4`}>
          <div className={labelStyle}>Top Referrer</div>
          <div className="text-xl font-bold mt-1 text-[var(--text)] truncate">
            {rows[0]
              ? rows[0].twitterHandle
                ? `@${rows[0].twitterHandle.replace(/^@/, "")}`
                : rows[0].referralCode
              : "—"}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            {rows[0]
              ? `${rows[0].signupsReferred.toLocaleString()} invites`
              : "no data yet"}
          </div>
        </div>

        <div className={`${card} p-4 flex flex-col`}>
          <div className={labelStyle}>Show</div>
          <div className="mt-1 flex gap-1.5">
            {[10, 25, 100].map((n) => (
              <button
                key={n}
                onClick={() => setLimit(n as 10 | 25 | 100)}
                className={`flex-1 rounded-none border px-2 py-1.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-colors ${
                  limit === n
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-hover)]"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            onClick={() => mutate()}
            className="mt-2 rounded-none border border-[var(--border)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)] hover:text-[var(--text)] hover:border-[var(--border-hover)] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className={card}>
        {error ? (
          <div className="p-4 text-[12px] text-[var(--short)]">
            Failed to load leaderboard.
          </div>
        ) : isLoading && !data ? (
          <div className="p-4 text-[12px] text-[var(--text-muted)]">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-[12px] text-[var(--text-muted)]">
            No referrals attributed yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Rank
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Code
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Twitter
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Pubkey
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Email
                  </th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-[0.12em]">
                    Invites
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Joined
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.referralCode}
                    className="border-b border-[var(--border)]/40 last:border-b-0"
                  >
                    <td className="px-3 py-2 font-mono text-[var(--text-muted)]">
                      #{row.rank}
                    </td>
                    <td className="px-3 py-2 font-mono font-bold text-[var(--text)]">
                      {row.referralCode}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--text-secondary)]">
                      {row.twitterHandle ? (
                        <a
                          href={`https://x.com/${row.twitterHandle.replace(/^@/, "")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-[var(--accent)] hover:underline"
                        >
                          @{row.twitterHandle.replace(/^@/, "")}
                        </a>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--text-secondary)]">
                      {row.ownerPubkey ? (
                        <a
                          href={`https://solscan.io/account/${row.ownerPubkey}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-[var(--accent)] hover:underline"
                          title={row.ownerPubkey}
                        >
                          {truncatePubkey(row.ownerPubkey)}
                        </a>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--text-secondary)]">
                      {row.ownerEmail ?? (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold text-[var(--accent)]">
                      {row.signupsReferred.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--text-muted)]">
                      {formatDate(row.joinedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
