import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = 'force-dynamic';

// Simple in-memory rate limiter (resets on cold start — fine for serverless)
const rateMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + 3600_000 });
    return false;
  }
  if (entry.count >= 5) return true;
  entry.count++;
  return false;
}

function sanitize(str: string): string {
  return str.replace(/[<>]/g, "").trim();
}

const TABLE = "ideas";

async function ensureTable() {
  const sb = getServiceClient();
  // Try a simple query — if it fails, table doesn't exist
  const { error } = await (sb.from as any)(TABLE).select("id").limit(1);
  if (error?.code === "42P01") {
    // table doesn't exist — create it via raw SQL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb.rpc as any)("exec_sql", {
      query: `
        CREATE TABLE IF NOT EXISTS public.ideas (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          handle text NOT NULL,
          idea text NOT NULL,
          contact text,
          ip text,
          created_at timestamptz DEFAULT now()
        );
        ALTER TABLE public.ideas ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "ideas_read" ON public.ideas FOR SELECT USING (true);
      `,
    });
  }
}

export async function GET() {
  try {
    const sb = getServiceClient();
    const { data, error } = await (sb.from as any)(TABLE)
      .select("id, handle, idea, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      // Table might not exist yet
      if (error.code === "42P01") return NextResponse.json([]);
      throw error;
    }

    return NextResponse.json(data ?? []);
  } catch (err) {
    console.error("GET /api/ideas error:", err);
    return NextResponse.json([], { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";

    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Rate limited — max 5 ideas per hour" },
        { status: 429 }
      );
    }

    const body = await req.json();
    const handle = sanitize(String(body.handle ?? ""));
    const idea = sanitize(String(body.idea ?? ""));
    const contact = body.contact ? sanitize(String(body.contact)) : null;

    if (!handle || handle.length > 30) {
      return NextResponse.json(
        { error: "Handle required (max 30 chars)" },
        { status: 400 }
      );
    }
    if (!idea || idea.length > 500) {
      return NextResponse.json(
        { error: "Idea required (max 500 chars)" },
        { status: 400 }
      );
    }

    await ensureTable();

    const sb = getServiceClient();
    const { error } = await (sb.from as any)(TABLE)
      .insert({ handle, idea, contact, ip });

    if (error) throw error;

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("POST /api/ideas error:", err);
    return NextResponse.json(
      { error: "Failed to submit idea" },
      { status: 500 }
    );
  }
}
