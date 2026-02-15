import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

interface FundingHistoryPoint {
  timestamp: number;      // epoch ms
  rateBpsPerSlot: number;
  hourlyRate: number;
  aprRate: number;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;
    const supabase = getServiceClient();

    // Fetch 7-day historical funding data
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data: history, error } = await supabase
      .from('funding_history')
      .select('timestamp, rate_bps_per_slot, net_lp_pos')
      .eq('market_slab', slab)
      .gte('timestamp', sevenDaysAgo.toISOString())
      .order('timestamp', { ascending: true });

    if (error) {
      console.error('[Funding History API] DB error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch funding history' },
        { status: 500 }
      );
    }

    // Transform DB rows to expected format
    const historyPoints: FundingHistoryPoint[] = (history || []).map((row) => {
      const rateBpsPerSlot = row.rate_bps_per_slot;
      const hourlyRate = (rateBpsPerSlot * 9000) / 100; // 9000 slots/hour, convert bps to percent
      const aprRate = hourlyRate * 24 * 365; // Annualized

      return {
        timestamp: new Date(row.timestamp).getTime(), // Convert to epoch ms
        rateBpsPerSlot,
        hourlyRate,
        aprRate,
      };
    });

    return NextResponse.json({ history: historyPoints });
  } catch (error) {
    console.error('[Funding History API] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
