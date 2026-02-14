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

    // Fetch current insurance data from market_stats
    const { data: stats, error: statsError } = await supabase
      .from('market_stats')
      .select('insurance_balance, insurance_fee_revenue, total_open_interest, last_crank_slot')
      .eq('slab_address', slab)
      .single();

    if (statsError || !stats) {
      console.error('[Insurance API] Stats error:', statsError);
      return NextResponse.json(
        { error: 'Market not found' },
        { status: 404 }
      );
    }

    // Fetch 7-day historical data
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data: history, error: historyError } = await supabase
      .from('insurance_history')
      .select('timestamp, balance, fee_revenue')
      .eq('market_slab', slab)
      .gte('timestamp', sevenDaysAgo.toISOString())
      .order('timestamp', { ascending: true });

    if (historyError) {
      console.warn('[Insurance API] History error:', historyError);
    }

    // Calculate metrics
    const insuranceBalance = (stats as any).insurance_balance || '0';
    const feeRevenue = (stats as any).insurance_fee_revenue || '0';
    const totalRisk = (stats as any).total_open_interest || '0';

    // Health ratio: insurance_balance / total_risk
    const healthRatio = parseFloat(totalRisk) > 0 
      ? parseFloat(insuranceBalance) / parseFloat(totalRisk)
      : 0;

    // Daily accumulation rate (estimate from recent growth)
    let dailyAccumulationRate = 0;
    if (history && history.length >= 2) {
      const oldest = history[0] as any;
      const newest = history[history.length - 1] as any;
      const daysDiff = (new Date(newest.timestamp).getTime() - new Date(oldest.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > 0) {
        const feeDiff = parseFloat(newest.fee_revenue || '0') - parseFloat(oldest.fee_revenue || '0');
        dailyAccumulationRate = (feeDiff / daysDiff) / 1e6; // Convert to USD
      }
    }

    // Format historical data
    const historicalBalance = (history || []).map((h: any) => ({
      timestamp: new Date(h.timestamp).getTime(),
      balance: parseFloat(h.balance || '0') / 1e6, // Convert to USD
    }));

    const response = {
      balance: insuranceBalance,
      feeRevenue,
      dailyAccumulationRate,
      coverageRatio: healthRatio,
      totalRisk,
      historicalBalance,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[Insurance API] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
