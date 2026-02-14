import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = 'force-dynamic';

const rateMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + 3600_000 });
    return false;
  }
  if (entry.count >= 3) return true;
  entry.count++;
  return false;
}

function sanitize(str: string): string {
  return str.replace(/[<>]/g, "").trim();
}

const TABLE = "bug_reports";

export async function GET() {
  try {
    const sb = getServiceClient();
    const { data, error } = await (sb.from as any)(TABLE)
      .select("id, twitter_handle, title, description, severity, page, bounty_wallet, transaction_wallet, page_url, status, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      if (error.code === "42P01") return NextResponse.json([]);
      throw error;
    }

    return NextResponse.json(data ?? []);
  } catch (err) {
    console.error("GET /api/bugs error:", err);
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
        { error: "Rate limited — max 3 bug reports per hour" },
        { status: 429 }
      );
    }

    const body = await req.json();
    const twitter_handle = sanitize(String(body.twitter_handle ?? ""));
    const title = sanitize(String(body.title ?? ""));
    const description = sanitize(String(body.description ?? ""));
    const severity = sanitize(String(body.severity ?? "medium"));
    const page = sanitize(String(body.page ?? ""));
    const steps_to_reproduce = sanitize(String(body.steps_to_reproduce ?? ""));
    const expected_behavior = sanitize(String(body.expected_behavior ?? ""));
    const actual_behavior = sanitize(String(body.actual_behavior ?? ""));
    const bounty_wallet = body.bounty_wallet ? sanitize(String(body.bounty_wallet)) : null;
    const transaction_wallet = body.transaction_wallet ? sanitize(String(body.transaction_wallet)) : null;
    const page_url = body.page_url ? sanitize(String(body.page_url)) : null;
    const browser = body.browser ? sanitize(String(body.browser)) : null;

    if (!twitter_handle || twitter_handle.length > 30) {
      return NextResponse.json(
        { error: "Twitter handle required (max 30 chars)" },
        { status: 400 }
      );
    }
    if (!title || title.length > 120) {
      return NextResponse.json(
        { error: "Title required (max 120 chars)" },
        { status: 400 }
      );
    }
    if (!description || description.length > 2000) {
      return NextResponse.json(
        { error: "Description required (max 2000 chars)" },
        { status: 400 }
      );
    }
    if (!["low", "medium", "high", "critical"].includes(severity)) {
      return NextResponse.json(
        { error: "Invalid severity" },
        { status: 400 }
      );
    }

    const sb = getServiceClient();
    const { error } = await (sb.from as any)(TABLE).insert({
      twitter_handle,
      title,
      description,
      severity,
      page,
      steps_to_reproduce: steps_to_reproduce || null,
      expected_behavior: expected_behavior || null,
      actual_behavior: actual_behavior || null,
      bounty_wallet,
      transaction_wallet,
      page_url: page_url || null,
      browser,
      ip,
    });

    if (error) throw error;

    // Discord notification handled by bot poller (polls /api/bugs every 30s)
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("POST /api/bugs error:", err);
    return NextResponse.json(
      { error: "Failed to submit bug report" },
      { status: 500 }
    );
  }
}
