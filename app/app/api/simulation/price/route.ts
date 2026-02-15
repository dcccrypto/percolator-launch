import { NextRequest, NextResponse } from 'next/server';
import { Connection } from '@solana/web3.js';
import { pushOraclePrice, loadOracleKeypair } from '@/lib/simulation/solana';
import { requireAuth, UNAUTHORIZED } from '@/lib/api-auth';
import { getConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface SetPriceRequest {
  slabAddress: string;
  priceE6: number;
}

/**
 * POST /api/simulation/price
 * Body: { slabAddress, priceE6 }
 * 
 * Manually set oracle price for a slab (sends PushOraclePrice instruction).
 * Can be used independently of simulation mode.
 */
export async function POST(request: NextRequest) {
  if (!requireAuth(request)) return UNAUTHORIZED;
  try {
    const keypair = loadOracleKeypair();
    if (!keypair) {
      return NextResponse.json(
        {
          error: 'Oracle keypair not configured',
          details: 'Set SIMULATION_ORACLE_KEYPAIR environment variable',
        },
        { status: 503 }
      );
    }
    
    const body: SetPriceRequest = await request.json();
    
    if (!body.slabAddress) {
      return NextResponse.json(
        { error: 'slabAddress is required' },
        { status: 400 }
      );
    }
    
    if (typeof body.priceE6 !== 'number' || body.priceE6 <= 0) {
      return NextResponse.json(
        { error: 'priceE6 must be a positive number' },
        { status: 400 }
      );
    }
    
    const config = getConfig();
    const connection = new Connection(config.rpcUrl, 'confirmed');
    
    const signature = await pushOraclePrice(
      connection,
      keypair,
      body.slabAddress,
      body.priceE6
    );
    
    return NextResponse.json({
      success: true,
      message: 'Oracle price updated',
      slabAddress: body.slabAddress,
      priceE6: body.priceE6,
      priceUSDC: body.priceE6 / 1e6,
      signature,
      explorer: `${config.explorerUrl}/tx/${signature}?cluster=${config.network}`,
    });
  } catch (error) {
    console.error('Set price error:', error);
    return NextResponse.json(
      {
        error: 'Failed to set oracle price',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
