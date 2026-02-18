import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json({ totalOI: 0, longOI: 0, shortOI: 0, history: [] });
}
