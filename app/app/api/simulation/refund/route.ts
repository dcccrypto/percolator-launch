export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { SimulationManager } from '@/lib/simulation/SimulationManager';

/**
 * POST /api/simulation/refund
 * 
 * Ends the simulation and cleans up the session.
 * Since all SOL was spent on rent-exempt accounts (which the user owns),
 * the user can reclaim rent by closing accounts later.
 * 
 * Request body: { payerPublicKey: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { payerPublicKey } = body;

    if (!payerPublicKey) {
      return NextResponse.json({ error: 'payerPublicKey is required' }, { status: 400 });
    }

    const manager = SimulationManager.getInstance();
    const session = manager.getSelfServiceSession(payerPublicKey);

    if (!session) {
      return NextResponse.json(
        { error: 'No simulation session found.' },
        { status: 404 }
      );
    }

    // Stop the simulation if running
    const state = manager.getState();
    if (state.running && state.slabAddress === session.slabAddress) {
      manager.stop();
    }

    // Clean up server-side session (remove keypairs from memory)
    manager.removeSelfServiceSession(payerPublicKey);

    return NextResponse.json({
      success: true,
      message: 'Simulation ended. Market accounts remain on-chain. Close the slab account to reclaim rent.',
      slabAddress: session.slabAddress,
    });
  } catch (error) {
    console.error('Refund error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Failed to process refund', details: message }, { status: 500 });
  }
}
