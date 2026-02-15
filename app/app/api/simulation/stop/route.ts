import { NextRequest, NextResponse } from 'next/server';
import { SimulationManager } from '@/lib/simulation/SimulationManager';
import { requireAuth, UNAUTHORIZED } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/simulation/stop
 * 
 * Stops the currently running simulation.
 */
export async function POST(request: NextRequest) {
  if (!requireAuth(request)) return UNAUTHORIZED;
  try {
    const manager = SimulationManager.getInstance();
    const state = manager.getState();
    
    if (!state.running) {
      return NextResponse.json(
        { error: 'No simulation is currently running' },
        { status: 400 }
      );
    }
    
    const finalState = {
      slabAddress: state.slabAddress,
      finalPriceE6: state.currentPriceE6,
      uptime: Date.now() - state.startedAt,
      updatesCount: state.updatesCount,
      sessionId: state.sessionId,
    };
    
    manager.stop();
    
    return NextResponse.json({
      success: true,
      message: 'Simulation stopped',
      finalState,
    });
  } catch (error) {
    console.error('Simulation stop error:', error);
    return NextResponse.json(
      {
        error: 'Failed to stop simulation',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
