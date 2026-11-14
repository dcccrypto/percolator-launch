import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getClientIp } from '@/lib/get-client-ip';
import { createUpstashRateLimiter } from '@/lib/upstash-rate-limit';
import { isDevnetV22Enabled } from '@/lib/v22/flag';
import {
  parsePortfolioList,
  REDUCE_EVENTS_LIMIT,
  USER_INITIATED_REDUCE_REASONS,
  toReduceEventView,
  type ReduceEventView,
} from '@/lib/v22/reduce-events';

/**
 * GET /api/trader/:wallet/reduce-events?portfolios=<a,b,...>
 *
 * D2 gate: the positions of this wallet that were reduced without the trader's own order (incl. the LP stop), newest first.
 * The client passes the wallet's portfolio addresses (its own owner scan); the events are public chain data, so the list is
 * not an authorisation. `v22_events` is server-only (RLS, no client grants), hence this route.
 *
 * `available: false` = v2.2 off, or the indexer table cannot be read: the screen says the history is unavailable. Never 500s.
 */
export const dynamic = 'force-dynamic';

const rateLimiter = createUpstashRateLimiter({
  limit: 30,
  windowMs: 60_000,
  prefix: 'rl:trader-reduce-events',
});
const CACHE = { 'Cache-Control': 'private, max-age=15' };

export interface ReduceEventsResponse {
  available: boolean;
  events: ReduceEventView[];
}

const answer = (body: ReduceEventsResponse, status = 200) =>
  NextResponse.json(body, { status, headers: CACHE });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  if (!isDevnetV22Enabled()) return answer({ available: false, events: [] });
  const rl = await rateLimiter.check(getClientIp(request));
  if (!rl.allowed)
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );

  const { wallet } = await params;
  try {
    new PublicKey(wallet);
  } catch {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 });
  }
  const portfolios = parsePortfolioList(new URL(request.url).searchParams.get('portfolios'));
  if (portfolios.length === 0) return answer({ available: true, events: [] });
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY))
    return answer({ available: false, events: [] });

  try {
    const { getServiceClient, getServerNetwork } = await import('@/lib/supabase');
    // v22_events is newer than the generated Database types (indexer migration 20261007120000), so the untyped client.
    const db = getServiceClient() as unknown as SupabaseClient;
    const { data, error } = await db
      .from('v22_events')
      .select(
        'signature, ix_index, inner_index, kind, slab_address, asset_index, actor, amount, detail, slot, block_time',
      )
      .eq('kind', 'reduce_event')
      .eq('network', getServerNetwork())
      .in('actor', portfolios)
      // The trader's own reduces (reasons 1, 7) are not "without your order": filter before the limit so they cannot crowd out the rest.
      .not('detail->>reason', 'in', `(${USER_INITIATED_REDUCE_REASONS.join(',')})`)
      // Postgres puts NULLs first on DESC: rows with no block time go last, then by slot.
      .order('block_time', { ascending: false, nullsFirst: false })
      .order('slot', { ascending: false, nullsFirst: false })
      .limit(REDUCE_EVENTS_LIMIT);
    if (error) {
      console.warn('[reduce-events] v22_events read failed:', error.message);
      return answer({ available: false, events: [] });
    }
    const events = (data ?? [])
      .map((r) => toReduceEventView(r as Record<string, unknown>))
      .filter((v): v is ReduceEventView => v !== null);
    return answer({ available: true, events });
  } catch (err) {
    console.warn('[reduce-events] error:', err instanceof Error ? err.message : String(err));
    return answer({ available: false, events: [] });
  }
}
