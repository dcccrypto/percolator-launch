export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getRandomToken } from '@/lib/simulation/tokens';

export async function GET() {
  const token = getRandomToken();
  return NextResponse.json(token);
}
