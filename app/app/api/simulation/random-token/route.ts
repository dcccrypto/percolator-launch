import { NextResponse } from "next/server";
import { getRandomToken } from "@/lib/simulation/tokens";

export const dynamic = "force-dynamic";

export async function GET() {
  const token = getRandomToken();
  return NextResponse.json(token);
}
