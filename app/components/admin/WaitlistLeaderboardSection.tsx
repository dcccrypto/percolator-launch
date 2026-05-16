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

function IntegrityRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span
        className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-bold"
        style={{
          color: ok ? "var(--long)" : "var(--short)",
          background: ok ? "rgba(35,196,124,0.12)" : "rgba(238,80,80,0.12)",
          border: `1px solid ${ok ? "rgba(35,196,124,0.4)" : "rgba(238,80,80,0.4)"}`,
        }}
      >
        {ok ? "✓" : "!"}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[var(--text)]">{label}</div>
        <div className="text-[11px] text-[var(--text-muted)] mt-0.5 break-words">
          {detail}
        </div>
      </div>
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
  tier: number;
}

interface WaitlistStats {
  totalSignups: number;
  byMethod: {
    walletOnly: number;
    emailOnly: number;
    walletAndEmail: number;
    withTwitter: number;
  };
  codeAssignment: {
    withCode: number;
    withoutCode: number;
    distinctCodes: number;
    duplicateCodes: { code: string; count: number }[];
    malformedCodes: string[];
  };
  attribution: {
    withReferrer: number;
    withoutReferrer: number;
    topReferrer: { code: string; count: number } | null;
    orphanedReferrers: string[];
  };
  emailNotification: {
    notifiedTotal: number;
    pendingEmailable: number;
    walletOnlyNoEmail: number;
  };
  recency: { last24h: number; last7d: number };
  tierBreakdown?: { tier: number; count: number; label: string }[];
  integrity: {
    selfReferrals: number;
    backfillComplete: boolean;
    codesUnique: boolean;
    allCodesValidShape: boolean;
    noOrphanedReferrers: boolean;
  };
}

function tierLabel(tier: number): string {
  return tier >= 0 && tier <= 25 ? String.fromCharCode(65 + tier) : `t${tier}`;
}

function tierColor(tier: number): string {
  // A = solid accent, B = cyan, C = amber, D+ = dim.
  if (tier === 0) return "var(--accent)";
  if (tier === 1) return "var(--cyan)";
  if (tier === 2) return "#fbbf24";
  return "var(--text-secondary)";
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

  // Pending referral-code email backfill for legacy email-path signups
  // who never received their code (the security review intentionally
  // prevents the duplicate-email signup path from echoing the code).
  const { data: backfill, mutate: refreshBackfill } = useSWR<{
    pending: number;
  }>("/api/admin/waitlist/backfill-emails", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });

  // Full integrity report — verifies the schema backfill assigned codes
  // to every row, codes are unique, no orphan referred_by_code values,
  // and shows the wallet/email/twitter breakdown.
  const { data: stats } = useSWR<WaitlistStats>(
    "/api/admin/waitlist/stats",
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: true },
  );
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null);

  const rows = (data?.leaderboard ?? []).slice(0, limit);
  const totalReferrers = data?.leaderboard.length ?? 0;
  const totalSignupsAttributed = (data?.leaderboard ?? []).reduce(
    (sum, r) => sum + r.signupsReferred,
    0,
  );

  const runBackfill = async () => {
    if (backfillBusy) return;
    const pending = backfill?.pending ?? 0;
    if (pending === 0) return;
    const ok = window.confirm(
      `Send referral-code emails to ${pending} pending recipient${
        pending === 1 ? "" : "s"
      }? This is rate-limited at ~4/sec and may take multiple clicks if there are more than 80 pending.`,
    );
    if (!ok) return;

    setBackfillBusy(true);
    setBackfillStatus("Sending…");
    try {
      let totalSent = 0;
      let totalFailed = 0;
      // Loop until no pending rows remain or an update-flag failure halts
      // the run (which the server mirrors from the CLI script — re-running
      // after a flag-failure would double-email those users).
      while (true) {
        const res = await fetch("/api/admin/waitlist/backfill-emails", {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            body.error || `Backfill failed with HTTP ${res.status}`,
          );
        }
        const json = (await res.json()) as {
          processed: number;
          sent: number;
          failed: number;
          updateFailed: number;
          remaining: number;
        };
        totalSent += json.sent;
        totalFailed += json.failed;
        if (json.updateFailed > 0) {
          throw new Error(
            "A row was emailed but its flag could not be updated — manual reconciliation required before retrying.",
          );
        }
        setBackfillStatus(
          `Sent ${totalSent} so far · ${json.remaining} remaining`,
        );
        if (json.remaining === 0 || json.processed === 0) break;
      }
      setBackfillStatus(
        `Done. Sent ${totalSent}${
          totalFailed > 0 ? `, ${totalFailed} failed` : ""
        }.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBackfillStatus(`Failed: ${msg}`);
    } finally {
      setBackfillBusy(false);
      refreshBackfill();
    }
  };

  return (
    <div className="mb-8">
      <SectionHeader>Waitlist Health</SectionHeader>

      {/* Integrity check — answers "did the SQL backfill run, are
          codes unique, is anything orphaned?". Hidden until first
          fetch resolves so we never flash misleading zeroes. */}
      {stats ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Total Signups</div>
              <div className="text-3xl font-bold mt-1 text-[var(--text)]">
                {stats.totalSignups.toLocaleString()}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-1">
                +{stats.recency.last24h} in 24h · +{stats.recency.last7d} in 7d
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Code Coverage</div>
              <div
                className="text-3xl font-bold mt-1"
                style={{
                  color: stats.integrity.backfillComplete
                    ? "var(--cyan)"
                    : "var(--short)",
                }}
              >
                {stats.codeAssignment.withCode}/{stats.totalSignups}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-1">
                {stats.integrity.backfillComplete
                  ? "every row has a code ✓"
                  : `${stats.codeAssignment.withoutCode} missing — backfill incomplete`}
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Attributed Signups</div>
              <div
                className="text-3xl font-bold mt-1"
                style={{ color: "var(--accent)" }}
              >
                {stats.attribution.withReferrer}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-1">
                {stats.attribution.withoutReferrer.toLocaleString()} pre-invite (grandfathered)
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Email Notification</div>
              <div className="text-3xl font-bold mt-1 text-[var(--text)]">
                {stats.emailNotification.notifiedTotal}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-1">
                {stats.emailNotification.pendingEmailable > 0
                  ? `${stats.emailNotification.pendingEmailable} pending · ${stats.emailNotification.walletOnlyNoEmail} wallet-only`
                  : `${stats.emailNotification.walletOnlyNoEmail} wallet-only (no email)`}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Wallet Only</div>
              <div className="text-2xl font-bold mt-1 text-[var(--text)]">
                {stats.byMethod.walletOnly.toLocaleString()}
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Email Only</div>
              <div className="text-2xl font-bold mt-1 text-[var(--text)]">
                {stats.byMethod.emailOnly.toLocaleString()}
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Wallet + Email</div>
              <div className="text-2xl font-bold mt-1 text-[var(--text)]">
                {stats.byMethod.walletAndEmail.toLocaleString()}
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>With Twitter Handle</div>
              <div className="text-2xl font-bold mt-1 text-[var(--text)]">
                {stats.byMethod.withTwitter.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Referral tier breakdown — A = the 126 pre-invite roots, B = referred by A, etc. */}
          {stats.tierBreakdown && stats.tierBreakdown.length > 0 && (
            <div className={`${card} p-4 mb-4`}>
              <div className={`${labelStyle} mb-3`}>Referral Tiers</div>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
                {stats.tierBreakdown.map(({ tier, count, label }) => (
                  <div
                    key={tier}
                    className="rounded-none border border-[var(--border)]/60 bg-[var(--bg)]/40 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em]"
                        style={{
                          color: tierColor(tier),
                          borderColor: `${tierColor(tier)}66`,
                          backgroundColor: `${tierColor(tier)}14`,
                        }}
                      >
                        {label}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
                        tier {tier}
                      </span>
                    </div>
                    <div
                      className="mt-1 font-mono text-[18px] font-bold text-[var(--text)]"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {count.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-[var(--text-muted)]">
                Tier = generation in the referral tree. A = pre-invite roots (the 126
                grandfathered signups), B = referred by an A, C = referred by a B, etc.
              </p>
            </div>
          )}

          {/* Integrity checks — green tick or red flag for each invariant */}
          <div className={`${card} p-4 mb-4`}>
            <div className={`${labelStyle} mb-3`}>Integrity Checks</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[12.5px]">
              <IntegrityRow
                ok={stats.integrity.backfillComplete}
                label="Every row has a referral_code"
                detail={
                  stats.integrity.backfillComplete
                    ? `${stats.codeAssignment.withCode} of ${stats.totalSignups}`
                    : `${stats.codeAssignment.withoutCode} rows missing a code — re-run the SQL backfill`
                }
              />
              <IntegrityRow
                ok={stats.integrity.codesUnique}
                label="All referral codes are unique"
                detail={
                  stats.integrity.codesUnique
                    ? `${stats.codeAssignment.distinctCodes} distinct codes`
                    : `${stats.codeAssignment.duplicateCodes.length} duplicate(s): ${stats.codeAssignment.duplicateCodes
                        .slice(0, 5)
                        .map((d) => `${d.code}(×${d.count})`)
                        .join(", ")}`
                }
              />
              <IntegrityRow
                ok={stats.integrity.allCodesValidShape}
                label="All codes match Crockford base32 × 8"
                detail={
                  stats.integrity.allCodesValidShape
                    ? "no malformed codes"
                    : `${stats.codeAssignment.malformedCodes.length} bad: ${stats.codeAssignment.malformedCodes.slice(0, 5).join(", ")}`
                }
              />
              <IntegrityRow
                ok={stats.integrity.noOrphanedReferrers}
                label="Every referred_by_code points at a real code"
                detail={
                  stats.integrity.noOrphanedReferrers
                    ? "no orphans"
                    : `${stats.attribution.orphanedReferrers.length} orphan(s): ${stats.attribution.orphanedReferrers.slice(0, 5).join(", ")}`
                }
              />
              <IntegrityRow
                ok={stats.integrity.selfReferrals === 0}
                label="No self-referrals"
                detail={
                  stats.integrity.selfReferrals === 0
                    ? "clean"
                    : `${stats.integrity.selfReferrals} row(s) reference their own code`
                }
              />
            </div>
          </div>
        </>
      ) : (
        <div className={`${card} p-4 mb-4 text-[12px] text-[var(--text-muted)]`}>
          Loading waitlist health…
        </div>
      )}

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

      {/* Pending email backfill — legacy email signups who haven't been
          notified of their code. Hidden when the queue is empty. */}
      {(backfill?.pending ?? 0) > 0 || backfillStatus ? (
        <div className={`${card} p-4 mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between`}>
          <div className="flex-1">
            <div className={labelStyle}>Email backfill pending</div>
            <div className="mt-1 text-[13px] text-[var(--text-secondary)]">
              {(backfill?.pending ?? 0) > 0
                ? `${backfill?.pending.toLocaleString()} email-path signup${
                    backfill?.pending === 1 ? "" : "s"
                  } never received their referral code.`
                : "All caught up — no pending backfill."}
              {backfillStatus ? (
                <span className="ml-2 font-mono text-[11px] text-[var(--text-muted)]">
                  · {backfillStatus}
                </span>
              ) : null}
            </div>
          </div>
          <button
            onClick={runBackfill}
            disabled={backfillBusy || (backfill?.pending ?? 0) === 0}
            className="shrink-0 rounded-none border border-[var(--accent)]/60 bg-[var(--accent)]/[0.12] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--text)] transition-colors hover:bg-[var(--accent)]/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {backfillBusy ? "Sending…" : "Send referral emails"}
          </button>
        </div>
      ) : null}

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
                    Tier
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
                    <td className="px-3 py-2">
                      <span
                        className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em]"
                        style={{
                          color: tierColor(row.tier ?? 0),
                          borderColor: `${tierColor(row.tier ?? 0)}66`,
                          backgroundColor: `${tierColor(row.tier ?? 0)}14`,
                        }}
                      >
                        {tierLabel(row.tier ?? 0)}
                      </span>
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
