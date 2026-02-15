import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';

export const dynamic = 'force-dynamic';

type MarketStats = Database['public']['Tables']['market_stats']['Row'];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  try {
    const { slab } = await params;
    const supabase = getServiceClient();

    // Fetch current funding data from market_stats
    const { data: stats, error: statsError } = await supabase
      .from('market_stats')
      .select('funding_rate, net_lp_pos')
      .eq('slab_address', slab)
      .single();

    if (statsError || !stats) {
      console.error('[Funding API] Stats error:', statsError);
      return NextResponse.json(
        { error: 'Market not found' },
        { status: 404 }
      );
    }

    // Extract funding rate (in basis points per slot)
    const currentRateBpsPerSlot = stats.funding_rate || 0;
    
    // Calculate hourly rate percentage
    // 9000 slots per hour * rate in bps / 100 (to convert bps to percent)
    const hourlyRatePercent = (currentRateBpsPerSlot * 9000) / 100;
    
    // Calculate APR
    const aprPercent = hourlyRatePercent * 24 * 365;
    
    // Determine funding direction
    let direction: "long_pays_short" | "short_pays_long" | "neutral";
    if (currentRateBpsPerSlot > 0) {
      direction = "long_pays_short";
    } else if (currentRateBpsPerSlot < 0) {
      direction = "short_pays_long";
    } else {
      direction = "neutral";
    }
    
    // Get net LP position
    const netLpPosition = (stats.net_lp_pos || 0).toString();

    const response = {
      currentRateBpsPerSlot,
      hourlyRatePercent,
      aprPercent,
      direction,
      nextFundingSlot: 0, // Not available from DB
      netLpPosition,
      currentSlot: 0, // Not available from DB
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[Funding API] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
