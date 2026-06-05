import { NextResponse } from "next/server";
import { getWaitlistServiceSupabase } from "@/lib/waitlist/supabase";
import { requireAdminSession } from "@/lib/admin-session";
import { DISPOSABLE_EMAIL_DOMAINS } from "@/lib/waitlist/disposable-domains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/waitlist/stats
 *
 * Comprehensive integrity report for the waitlist + referral system.
 * Designed to answer:
 *   - did the SQL backfill assign a code to every row?
 *   - are codes unique?
 *   - how many signups have / haven't been notified yet?
 *   - what does the wallet/email breakdown look like?
 *   - how many signups arrived via someone's invite link?
 *
 * Service-role reads only — anon path stays revoked. Admin session
 * required.
 */
export async function GET(req: Request) {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return auth.response;

  try {
    const supabase = getWaitlistServiceSupabase();

    // Pull the whole table. PostgREST silently caps a bare .select() at 1000
    // rows (the `max-rows` default), which previously froze TOTAL SIGNUPS at
    // 1,000 once the table grew past it and made every referred_by_code in
    // the truncated tail look like an orphan. Page with .range() until the
    // server returns a short page. The list is currently low thousands —
    // when it grows enough that this loop matters, push the aggregation
    // down into a Postgres RPC instead of pulling all rows.
    type Row = {
      id: string;
      pubkey: string | null;
      email: string | null;
      referral_code: string | null;
      referred_by_code: string | null;
      referral_code_emailed_at: string | null;
      twitter_handle: string | null;
      created_at: string;
      tier: number | null;
      ip_hash: string | null;
    };
    const PAGE_SIZE = 1000;
    const all: Row[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("waitlist")
        .select(
          "id, pubkey, email, referral_code, referred_by_code, referral_code_emailed_at, twitter_handle, created_at, tier, ip_hash",
        )
        .order("created_at", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        console.error("[admin/waitlist/stats] select error", error);
        return NextResponse.json(
          { error: "Failed to read waitlist" },
          { status: 500 },
        );
      }
      const batch = (data ?? []) as Row[];
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }

    // ── Tier breakdown (A = 0, B = 1, ...) ────────────────────────────
    // Computed from the row data so it stays in sync with whatever the
    // table actually says. tier defaults to 0 in the DB, so pre-migration
    // rows count as A.
    const tierCounts = new Map<number, number>();
    for (const r of all) {
      const t = typeof r.tier === "number" ? r.tier : 0;
      tierCounts.set(t, (tierCounts.get(t) ?? 0) + 1);
    }
    const tierBreakdown = Array.from(tierCounts.entries())
      .sort(([a], [b]) => a - b)
      .map(([tier, count]) => ({
        tier,
        count,
        label: tier >= 0 && tier <= 25 ? String.fromCharCode(65 + tier) : `t${tier}`,
      }));

    // ── Totals + breakdown by signup method ────────────────────────────
    const totalSignups = all.length;
    let walletOnly = 0;
    let emailOnly = 0;
    let walletAndEmail = 0;
    let withTwitter = 0;
    for (const r of all) {
      const hasW = !!r.pubkey;
      const hasE = !!r.email;
      if (hasW && hasE) walletAndEmail++;
      else if (hasW) walletOnly++;
      else if (hasE) emailOnly++;
      if (r.twitter_handle && r.twitter_handle.trim() !== "") withTwitter++;
    }

    // ── Referral code assignment (was the backfill complete?) ──────────
    let withCode = 0;
    let withoutCode = 0;
    const codeSeen = new Map<string, number>();
    const malformedCodes: string[] = [];
    for (const r of all) {
      if (r.referral_code) {
        withCode++;
        codeSeen.set(r.referral_code, (codeSeen.get(r.referral_code) ?? 0) + 1);
        // Crockford base32, 8 chars, uppercase. Catches any drift.
        if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(r.referral_code)) {
          malformedCodes.push(r.referral_code);
        }
      } else {
        withoutCode++;
      }
    }
    const distinctCodes = codeSeen.size;
    const duplicateCodes: { code: string; count: number }[] = [];
    for (const [code, count] of codeSeen) {
      if (count > 1) duplicateCodes.push({ code, count });
    }

    // ── Attribution: did this row come in via someone's invite? ───────
    let withReferrer = 0;
    let withoutReferrer = 0;
    const referredByCount = new Map<string, number>();
    const orphanedReferrers: string[] = []; // referred_by_code that isn't anyone's referral_code
    const validCodes = new Set(codeSeen.keys());
    for (const r of all) {
      if (r.referred_by_code) {
        withReferrer++;
        referredByCount.set(
          r.referred_by_code,
          (referredByCount.get(r.referred_by_code) ?? 0) + 1,
        );
        if (!validCodes.has(r.referred_by_code)) {
          orphanedReferrers.push(r.referred_by_code);
        }
      } else {
        withoutReferrer++;
      }
    }
    // Top referrer
    let topReferrer: { code: string; count: number } | null = null;
    for (const [code, count] of referredByCount) {
      if (!topReferrer || count > topReferrer.count) {
        topReferrer = { code, count };
      }
    }

    // ── Email-notification state ───────────────────────────────────────
    let notifiedTotal = 0; // referral_code_emailed_at IS NOT NULL
    let pendingEmailable = 0; // has email AND code AND not yet emailed
    let walletOnlyNoEmail = 0; // no email column — nothing to send to
    for (const r of all) {
      if (r.referral_code_emailed_at) {
        notifiedTotal++;
        continue;
      }
      if (!r.email) {
        walletOnlyNoEmail++;
      } else if (r.referral_code) {
        pendingEmailable++;
      }
    }

    // ── Recency + 30-day growth buckets ────────────────────────────────
    // Daily UTC buckets so the operator dashboard can plot signup velocity
    // alongside the 24h/7d numbers above.
    const now = Date.now();
    const ms24h = 24 * 60 * 60 * 1000;
    const ms7d = 7 * 24 * 60 * 60 * 1000;
    let last24h = 0;
    let last7d = 0;
    const dailyCounts = new Map<string, number>(); // YYYY-MM-DD → new signups that day
    const toDayKey = (ms: number): string => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };
    for (const r of all) {
      const t = new Date(r.created_at).getTime();
      if (Number.isFinite(t)) {
        if (now - t <= ms24h) last24h++;
        if (now - t <= ms7d) last7d++;
        const key = toDayKey(t);
        dailyCounts.set(key, (dailyCounts.get(key) ?? 0) + 1);
      }
    }
    // Build a contiguous daily series from the first signup (capped to
    // 180 days back) up through today. The chart's range selector slices
    // this on the client. Emitting cumulative server-side avoids re-summing
    // in the UI and keeps the chart truthful if the client filters the
    // visible window — the cumulative reflects the FULL list at each day,
    // not just signups since the visible-window start.
    const MAX_WINDOW_DAYS = 180;
    const todayUtcMidnight = new Date();
    todayUtcMidnight.setUTCHours(0, 0, 0, 0);
    let firstSignupMs = todayUtcMidnight.getTime();
    for (const r of all) {
      const t = new Date(r.created_at).getTime();
      if (Number.isFinite(t) && t < firstSignupMs) firstSignupMs = t;
    }
    const firstSignupDayMs = new Date(firstSignupMs).setUTCHours(0, 0, 0, 0);
    const startDayMs = Math.max(
      firstSignupDayMs,
      todayUtcMidnight.getTime() - (MAX_WINDOW_DAYS - 1) * ms24h,
    );
    // Anything older than the visible-window start is the pre-window total.
    let cumulativeBefore = 0;
    for (const r of all) {
      const t = new Date(r.created_at).getTime();
      if (Number.isFinite(t) && t < startDayMs) cumulativeBefore++;
    }
    let running = cumulativeBefore;
    const dailyGrowth: { date: string; count: number; cumulative: number }[] = [];
    for (let dayMs = startDayMs; dayMs <= todayUtcMidnight.getTime(); dayMs += ms24h) {
      const key = toDayKey(dayMs);
      const count = dailyCounts.get(key) ?? 0;
      running += count;
      dailyGrowth.push({ date: key, count, cumulative: running });
    }

    // ── Self-referral check (defense-in-depth, app prevents it but
    //    a DB-level CHECK constraint isn't in place yet). ─────────────
    let selfReferrals = 0;
    for (const r of all) {
      if (
        r.referral_code &&
        r.referred_by_code &&
        r.referral_code === r.referred_by_code
      ) {
        selfReferrals++;
      }
    }

    // ── Spam / quality signals ────────────────────────────────────────
    // We only have public-ish fields to work with (no IPs / UAs), so we
    // squeeze as many independent signals out of email shape, twitter
    // shape, and timing as possible. Each one would have a different
    // failure mode for a botnet — a single bypass would still trip
    // others. The frontend shows them as a panel; operator judges.
    //
    // The disposable-domain list is now imported from a shared module
    // so the signup route can reject at the door using the SAME list
    // we surface here — without sharing, the two lists would inevitably
    // drift and the admin counts would stop matching what the route
    // blocks. New entries to lib/waitlist/disposable-domains.ts
    // automatically flow through to both surfaces.
    // bot-style handle: 6+ trailing digits that aren't just a calendar year.
    const BOT_HANDLE = /^([a-z][a-z_]{1,})(\d{6,})$/i;
    const isYearLike = (d: string): boolean =>
      d.length === 4 && /^(19|20)\d{2}$/.test(d);

    const emailDomainCount = new Map<string, number>();
    const localPartDomains = new Map<string, Set<string>>(); // local → distinct domains
    let disposableEmails = 0;
    const disposableDomainSet = new Set<string>();
    let botHandleMatches = 0;
    const botHandleSample: string[] = [];
    const minuteBuckets = new Map<number, number>(); // unix-minute → count
    const referrerMinute = new Map<string, Map<number, number>>(); // code → minute → count
    const referrerHour = new Map<string, Map<number, number>>(); // code → hour → count
    // IP-based aggregates. ip_hash is a salted SHA-256 written by the
    // signup route — same hash from the same source IP under the same
    // salt, so it's safe to use as a group-by key without ever surfacing
    // the raw IP here. NULL rows pre-date IP capture or arrived through
    // a forwarding-header-stripping proxy.
    const ipHashCount = new Map<string, number>(); // ip_hash → total signups
    const ipHashReferrers = new Map<string, Set<string>>(); // ip_hash → distinct referrer codes
    const ipHashHour = new Map<string, Map<number, number>>(); // ip_hash → hour → count
    let withoutIp = 0; // rows where ip_hash is NULL

    for (const r of all) {
      // Email signals
      if (r.email) {
        const e = r.email.toLowerCase().trim();
        const at = e.lastIndexOf("@");
        if (at > 0 && at < e.length - 1) {
          const local = e.slice(0, at);
          const domain = e.slice(at + 1);
          emailDomainCount.set(domain, (emailDomainCount.get(domain) ?? 0) + 1);
          if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
            disposableEmails++;
            disposableDomainSet.add(domain);
          }
          // Strip the +tag suffix so "alice+1@x" and "alice+2@x" collapse.
          const localBase = local.split("+")[0]!;
          if (localBase.length >= 3) {
            let set = localPartDomains.get(localBase);
            if (!set) {
              set = new Set();
              localPartDomains.set(localBase, set);
            }
            set.add(domain);
          }
        }
      }
      // Twitter handle signals
      if (r.twitter_handle) {
        const h = r.twitter_handle.replace(/^@/, "").trim();
        const m = BOT_HANDLE.exec(h);
        if (m && !isYearLike(m[2]!)) {
          botHandleMatches++;
          if (botHandleSample.length < 8) botHandleSample.push(h);
        }
      }
      // Timing buckets
      const t = new Date(r.created_at).getTime();
      const hour = Number.isFinite(t) ? Math.floor(t / 3_600_000) : null;
      if (Number.isFinite(t)) {
        const minute = Math.floor(t / 60_000);
        minuteBuckets.set(minute, (minuteBuckets.get(minute) ?? 0) + 1);
        if (r.referred_by_code) {
          const code = r.referred_by_code;
          let mMap = referrerMinute.get(code);
          if (!mMap) {
            mMap = new Map();
            referrerMinute.set(code, mMap);
          }
          mMap.set(minute, (mMap.get(minute) ?? 0) + 1);
          let hMap = referrerHour.get(code);
          if (!hMap) {
            hMap = new Map();
            referrerHour.set(code, hMap);
          }
          hMap.set(hour!, (hMap.get(hour!) ?? 0) + 1);
        }
      }
      // IP signals
      if (r.ip_hash) {
        ipHashCount.set(r.ip_hash, (ipHashCount.get(r.ip_hash) ?? 0) + 1);
        if (r.referred_by_code) {
          let s = ipHashReferrers.get(r.ip_hash);
          if (!s) {
            s = new Set();
            ipHashReferrers.set(r.ip_hash, s);
          }
          s.add(r.referred_by_code);
        }
        if (hour !== null) {
          let h = ipHashHour.get(r.ip_hash);
          if (!h) {
            h = new Map();
            ipHashHour.set(r.ip_hash, h);
          }
          h.set(hour, (h.get(hour) ?? 0) + 1);
        }
      } else {
        withoutIp++;
      }
    }

    // Top non-mainstream domains (a healthy waitlist is gmail/outlook/yahoo
    // heavy; an unusual domain leading the chart is a red flag).
    const topEmailDomains = Array.from(emailDomainCount.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([domain, count]) => ({ domain, count }));

    // Worst single-minute and 5-minute spikes across the whole table.
    let worstMinute: { minute: number; count: number } | null = null;
    for (const [minute, count] of minuteBuckets) {
      if (!worstMinute || count > worstMinute.count) worstMinute = { minute, count };
    }
    // For 5-min: slide a 5-min window over the sorted minute keys.
    const sortedMinutes = Array.from(minuteBuckets.keys()).sort((a, b) => a - b);
    let worst5Min: { startMinute: number; count: number } | null = null;
    for (let i = 0; i < sortedMinutes.length; i++) {
      const start = sortedMinutes[i]!;
      let sum = 0;
      for (let j = i; j < sortedMinutes.length; j++) {
        const m = sortedMinutes[j]!;
        if (m > start + 4) break;
        sum += minuteBuckets.get(m) ?? 0;
      }
      if (!worst5Min || sum > worst5Min.count) {
        worst5Min = { startMinute: start, count: sum };
      }
    }

    // Worst referrer velocity — for every referrer, find their busiest hour;
    // surface the global champion. Real influencers peak in the dozens; a
    // bot army shows 100+ in a single hour.
    let worstReferrerHour: { code: string; hour: number; count: number } | null = null;
    for (const [code, hMap] of referrerHour) {
      for (const [hour, count] of hMap) {
        if (!worstReferrerHour || count > worstReferrerHour.count) {
          worstReferrerHour = { code, hour, count };
        }
      }
    }

    // local-part appearing across 3+ different email domains = same handle
    // signing up via multiple throwaway providers.
    const crossDomainLocals: { local: string; domains: number }[] = [];
    for (const [local, domains] of localPartDomains) {
      if (domains.size >= 3) {
        crossDomainLocals.push({ local, domains: domains.size });
      }
    }
    crossDomainLocals.sort((a, b) => b.domains - a.domains);

    // ── IP signal post-loop aggregation ───────────────────────────────
    // Top-8 IPs by signup count. We surface the ip_hash (12 hex chars are
    // plenty to disambiguate in the UI; full 64-char hex is included for
    // the operator to cross-reference against a raw lookup query). The
    // raw ip_address column is intentionally NOT pulled into this route
    // — analytics stays hash-only so PII doesn't show up in the admin
    // dashboard.
    const topIps = Array.from(ipHashCount.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([ipHash, count]) => ({ ipHash, count }));

    // IPs spanning ≥3 distinct referrer codes — a single source running
    // signups across multiple "friends" of different referrers is a
    // strong cluster signal, especially when paired with a high
    // ipHashCount value.
    const crossReferrerIps: { ipHash: string; referrers: number }[] = [];
    for (const [ipHash, refs] of ipHashReferrers) {
      if (refs.size >= 3) {
        crossReferrerIps.push({ ipHash, referrers: refs.size });
      }
    }
    crossReferrerIps.sort((a, b) => b.referrers - a.referrers);

    // Worst single-IP single-hour velocity. Mirror of worstReferrerHour
    // but keyed on IP — catches the case where one bot host fires many
    // signups in a window even if it rotated referrer codes.
    let worstIpHour: { ipHash: string; hour: number; count: number } | null = null;
    for (const [ipHash, hMap] of ipHashHour) {
      for (const [hour, count] of hMap) {
        if (!worstIpHour || count > worstIpHour.count) {
          worstIpHour = { ipHash, hour, count };
        }
      }
    }

    const toIsoMinute = (m: number): string =>
      new Date(m * 60_000).toISOString().replace(":00.000Z", "Z");
    const toIsoHour = (h: number): string =>
      new Date(h * 3_600_000).toISOString().replace(":00:00.000Z", "Z");

    const spam = {
      email: {
        disposableCount: disposableEmails,
        disposableDomains: Array.from(disposableDomainSet).sort(),
        topDomains: topEmailDomains,
        crossDomainLocalParts: crossDomainLocals.slice(0, 8),
      },
      twitter: {
        botPatternCount: botHandleMatches,
        sample: botHandleSample,
      },
      velocity: {
        worstMinute: worstMinute
          ? { at: toIsoMinute(worstMinute.minute), count: worstMinute.count }
          : null,
        worst5Min: worst5Min
          ? { startAt: toIsoMinute(worst5Min.startMinute), count: worst5Min.count }
          : null,
        worstReferrerHour: worstReferrerHour
          ? {
              code: worstReferrerHour.code,
              at: toIsoHour(worstReferrerHour.hour),
              count: worstReferrerHour.count,
            }
          : null,
      },
      ip: {
        distinctIps: ipHashCount.size,
        withoutIp,
        topIps,
        crossReferrerIps: crossReferrerIps.slice(0, 8),
        worstIpHour: worstIpHour
          ? {
              ipHash: worstIpHour.ipHash,
              at: toIsoHour(worstIpHour.hour),
              count: worstIpHour.count,
            }
          : null,
      },
    };

    return NextResponse.json({
      totalSignups,
      byMethod: { walletOnly, emailOnly, walletAndEmail, withTwitter },
      codeAssignment: {
        withCode,
        withoutCode,
        distinctCodes,
        duplicateCodes,
        malformedCodes,
      },
      attribution: {
        withReferrer,
        withoutReferrer,
        topReferrer,
        orphanedReferrers,
      },
      emailNotification: {
        notifiedTotal,
        pendingEmailable,
        walletOnlyNoEmail,
      },
      recency: { last24h, last7d },
      growth: { days: dailyGrowth },
      spam,
      tierBreakdown,
      integrity: {
        selfReferrals,
        backfillComplete: withoutCode === 0,
        codesUnique: duplicateCodes.length === 0,
        allCodesValidShape: malformedCodes.length === 0,
        noOrphanedReferrers: orphanedReferrers.length === 0,
      },
    });
  } catch (err) {
    console.error("[admin/waitlist/stats] unexpected", err);
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
  }
}
