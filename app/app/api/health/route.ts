import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { Connection } from "@solana/web3.js";
import { getConfig } from "@/lib/config";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — Extended health check for monitoring
 */
export async function GET() {
  const start = Date.now();
  const checks: Record<string, { status: "ok" | "error"; latencyMs?: number; error?: string }> = {};

  try {
    const t0 = Date.now();
    const supabase = getServiceClient();
    const { error } = await supabase.from("markets").select("slab_address", { count: "exact", head: true });
    checks.supabase = error
      ? { status: "error", error: error.message, latencyMs: Date.now() - t0 }
      : { status: "ok", latencyMs: Date.now() - t0 };
  } catch (e) {
    checks.supabase = { status: "error", error: e instanceof Error ? e.message : "Unknown" };
  }

  try {
    const t0 = Date.now();
    const cfg = getConfig();
    const conn = new Connection(cfg.rpcUrl, "confirmed");
    const slot = await conn.getSlot();
    checks.solanaRpc = { status: slot > 0 ? "ok" : "error", latencyMs: Date.now() - t0 };
  } catch (e) {
    checks.solanaRpc = { status: "error", error: e instanceof Error ? e.message : "Unknown" };
  }

  const allOk = Object.values(checks).every((c) => c.status === "ok");

  return NextResponse.json(
    {
      status: allOk ? "healthy" : "degraded",
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
      uptime: process.uptime(),
      checks,
      totalLatencyMs: Date.now() - start,
    },
    { status: allOk ? 200 : 503 }
  );
}
