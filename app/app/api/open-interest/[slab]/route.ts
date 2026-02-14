import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;
    const supabase = getServiceClient();

    // Fetch current OI data from market_stats
    const { data: stats, error: statsError } = await supabase
      .from('market_stats')
      .select('total_open_interest, net_lp_pos, lp_sum_abs, lp_max_abs, last_crank_slot')
      .eq('slab_address', slab)
      .single();

    if (statsError || !stats) {
      console.error('[OI API] Stats error:', statsError);
      return NextResponse.json(
        { error: 'Market not found' },
        { status: 404 }
      );
    }

    // Fetch 24h historical data
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const { data: history, error: historyError } = await supabase
      .from('oi_history')
      .select('timestamp, total_oi, net_lp_pos')
      .eq('market_slab', slab)
      .gte('timestamp', oneDayAgo.toISOString())
      .order('timestamp', { ascending: true });

    if (historyError) {
      console.warn('[OI API] History error:', historyError);
    }

    // Calculate long/short split
    // From the backend design: 
    // long_oi = (total_oi - net_lp_pos) / 2
    // short_oi = (total_oi + net_lp_pos) / 2
    // Because: total_oi = long_oi + short_oi and net_lp_pos = short_oi - long_oi (LP is counterparty)
    
    const totalOi = parseFloat((stats as any).total_open_interest || '0');
    const netLpPos = parseFloat((stats as any).net_lp_pos || '0');
    
    const longOi = (totalOi - netLpPos) / 2;
    const shortOi = (totalOi + netLpPos) / 2;

    // Format historical data
    const historicalOi = (history || []).map((h: any) => {
      const total = parseFloat(h.total_oi || '0');
      const netLp = parseFloat(h.net_lp_pos || '0');
      return {
        timestamp: new Date(h.timestamp).getTime(),
        totalOi: total / 1e6, // Convert to USD
        longOi: (total - netLp) / 2 / 1e6,
        shortOi: (total + netLp) / 2 / 1e6,
      };
    });

    const response = {
      totalOi: (stats as any).total_open_interest || '0',
      longOi: (longOi * 1e6).toString(), // Back to e6 format
      shortOi: (shortOi * 1e6).toString(),
      netLpPosition: (stats as any).net_lp_pos || '0',
      historicalOi,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[OI API] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
