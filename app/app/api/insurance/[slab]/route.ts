import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';

export const dynamic = 'force-dynamic';

type MarketStats = Database['public']['Tables']['market_stats']['Row'];
type InsuranceHistory = Database['public']['Tables']['insurance_history']['Row'];

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
      .select('insurance_balance, insurance_fee_revenue, total_open_interest')
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

    // Calculate metrics with proper types
    const insuranceBalance = stats.insurance_balance?.toString() || '0';
    const feeRevenue = stats.insurance_fee_revenue?.toString() || '0';
    const totalRisk = stats.total_open_interest?.toString() || '0';

    // Health ratio: insurance_balance / total_risk
    const healthRatio = parseFloat(totalRisk) > 0 
      ? parseFloat(insuranceBalance) / parseFloat(totalRisk)
      : 0;

    // Daily accumulation rate (estimate from recent growth)
    let dailyAccumulationRate = 0;
    if (history && history.length >= 2) {
      const oldest = history[0];
      const newest = history[history.length - 1];
      const daysDiff = (new Date(newest.timestamp).getTime() - new Date(oldest.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff > 0) {
        const feeDiff = newest.fee_revenue - oldest.fee_revenue;
        dailyAccumulationRate = (feeDiff / daysDiff) / 1e6; // Convert to USD
      }
    }

    // Format historical data
    const historicalBalance = (history || []).map((h) => ({
      timestamp: new Date(h.timestamp).getTime(),
      balance: h.balance / 1e6, // Convert to USD
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
