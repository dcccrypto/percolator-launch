import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

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

const TABLE = "job_applications";

export async function GET() {
  try {
    const sb = getServiceClient();
    const { data, error } = await (sb.from as any)(TABLE)
      .select("id, name, twitter_handle, discord, telegram, email, desired_role, experience_level, about, portfolio_links, cv_filename, availability, solana_wallet, status, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      if (error.code === "42P01") return NextResponse.json([]);
      throw error;
    }

    return NextResponse.json(data ?? []);
  } catch (err) {
    console.error("GET /api/applications error:", err);
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
        { error: "Rate limited — max 3 applications per hour" },
        { status: 429 }
      );
    }

    const body = await req.json();
    const name = sanitize(String(body.name ?? ""));
    const twitter_handle = sanitize(String(body.twitter_handle ?? "")).replace(/^@/, "");
    const discord = body.discord ? sanitize(String(body.discord)) : null;
    const telegram = body.telegram ? sanitize(String(body.telegram)) : null;
    const email = sanitize(String(body.email ?? ""));
    const desired_role = sanitize(String(body.desired_role ?? ""));
    const experience_level = sanitize(String(body.experience_level ?? ""));
    const about = sanitize(String(body.about ?? ""));
    const portfolio_links = body.portfolio_links ? sanitize(String(body.portfolio_links)) : null;
    const cv_filename = body.cv_filename ? sanitize(String(body.cv_filename)) : null;
    const cv_data = body.cv_data ? String(body.cv_data) : null;
    const availability = sanitize(String(body.availability ?? ""));
    const solana_wallet = body.solana_wallet ? sanitize(String(body.solana_wallet)) : null;

    if (!name || name.length > 100) {
      return NextResponse.json({ error: "Name required (max 100 chars)" }, { status: 400 });
    }
    if (!twitter_handle || twitter_handle.length > 30) {
      return NextResponse.json({ error: "Twitter handle required (max 30 chars)" }, { status: 400 });
    }
    if (!email || email.length > 200 || !email.includes("@")) {
      return NextResponse.json({ error: "Valid email required" }, { status: 400 });
    }
    const validRoles = ["developer", "designer", "community", "marketing", "trader", "other"];
    if (!validRoles.includes(desired_role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    const validLevels = ["junior", "mid", "senior", "lead"];
    if (!validLevels.includes(experience_level)) {
      return NextResponse.json({ error: "Invalid experience level" }, { status: 400 });
    }
    if (!about || about.length > 3000) {
      return NextResponse.json({ error: "About section required (max 3000 chars)" }, { status: 400 });
    }
    const validAvailability = ["full-time", "part-time", "freelance", "contributor"];
    if (!validAvailability.includes(availability)) {
      return NextResponse.json({ error: "Invalid availability" }, { status: 400 });
    }
    // CV size check (~5MB base64 ≈ 6.67MB string)
    if (cv_data && cv_data.length > 7_000_000) {
      return NextResponse.json({ error: "CV too large (max 5MB)" }, { status: 400 });
    }

    const sb = getServiceClient();
    const { error } = await (sb.from as any)(TABLE).insert({
      name,
      twitter_handle,
      discord,
      telegram,
      email,
      desired_role,
      experience_level,
      about,
      portfolio_links,
      cv_filename,
      cv_data,
      availability,
      solana_wallet,
      status: "new",
      ip,
    });

    if (error) throw error;

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("POST /api/applications error:", err);
    return NextResponse.json(
      { error: "Failed to submit application" },
      { status: 500 }
    );
  }
}
