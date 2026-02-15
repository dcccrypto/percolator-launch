import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";

// Rate limit: simple in-memory tracker (resets on cold start, good enough for Vercel)
const uploadTimestamps = new Map<string, number>();
const RATE_LIMIT_MS = 30_000; // 1 upload per 30s per slab

// GET /api/markets/[slab]/logo
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("markets")
    .select("logo_url")
    .eq("slab_address", slab)
    .single();

  if (error) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  return NextResponse.json({ logo_url: data.logo_url });
}

// POST /api/markets/[slab]/logo — Upload logo file to Supabase Storage
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;

  // Validate slab address
  try {
    new PublicKey(slab);
  } catch {
    return NextResponse.json({ error: "Invalid slab address" }, { status: 400 });
  }

  // Rate limit
  const lastUpload = uploadTimestamps.get(slab) ?? 0;
  if (Date.now() - lastUpload < RATE_LIMIT_MS) {
    return NextResponse.json({ error: "Rate limited. Try again in 30s." }, { status: 429 });
  }

  const formData = await req.formData();
  const file = formData.get("logo") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided. Use 'logo' field." }, { status: 400 });
  }

  // Only allow safe raster formats — NO SVG (XSS vector)
  const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json(
      { error: `Invalid file type. Allowed: PNG, JPEG, WebP, GIF` },
      { status: 400 }
    );
  }

  // Max 2MB
  if (file.size > 2 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large. Max 2MB." }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Check market exists
  const { data: market, error: marketError } = await supabase
    .from("markets")
    .select("slab_address")
    .eq("slab_address", slab)
    .single();

  if (marketError || !market) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  try {
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : file.type === "image/gif" ? "gif" : "jpg";
    const filePath = `market-logos/${slab}.${ext}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from("logos")
      .upload(filePath, buffer, { contentType: file.type, upsert: true });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
    }

    const { data: urlData } = supabase.storage.from("logos").getPublicUrl(filePath);
    const publicUrl = urlData.publicUrl;

    const { error: updateError } = await supabase
      .from("markets")
      .update({ logo_url: publicUrl })
      .eq("slab_address", slab);

    if (updateError) {
      console.error("DB update error:", updateError);
      return NextResponse.json({ error: `DB update failed: ${updateError.message}` }, { status: 500 });
    }

    uploadTimestamps.set(slab, Date.now());

    return NextResponse.json({ logo_url: publicUrl }, { status: 200 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Failed to process upload" }, { status: 500 });
  }
}
