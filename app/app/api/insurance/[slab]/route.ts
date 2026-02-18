import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json({ balance: 0, healthRatio: 0, lifetimePremiums: 0 });
}
