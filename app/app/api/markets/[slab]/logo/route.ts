import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { PublicKey } from "@solana/web3.js";
import { validateSlabParam } from "@/lib/route-validators";
import { requireAuth, UNAUTHORIZED } from "@/lib/api-auth";
import { detectRasterImage } from "@/lib/raster-image-bytes";

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

  // Validate slab parameter format
  const validation = validateSlabParam(slab);
  if (!validation.valid) {
    return validation.response;
  }
  const validSlab = new PublicKey(validation.slab).toBase58();

  let supabase: ReturnType<typeof getServiceClient> | null = null;
  try {
    supabase = getServiceClient();
  } catch {
    // Supabase unavailable — return null logo gracefully
    return NextResponse.json({ logo_url: null });
  }

  try {
    const { data, error } = await supabase
      .from("markets")
      .select("logo_url")
      .eq("slab_address", validSlab)
      .single();

    if (error) {
      return NextResponse.json({ logo_url: null }, { status: 404 });
    }

    return NextResponse.json({ logo_url: data.logo_url });
  } catch {
    return NextResponse.json({ logo_url: null });
  }
}

// POST /api/markets/[slab]/logo — Upload logo file to Supabase Storage
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  if (!requireAuth(req)) {
    return UNAUTHORIZED;
  }

  const { slab } = await params;

  // Validate slab address
  const validation = validateSlabParam(slab);
  if (!validation.valid) {
    return validation.response;
  }
  const validSlab = new PublicKey(validation.slab).toBase58();

  // Rate limit
  const lastUpload = uploadTimestamps.get(validSlab) ?? 0;
  if (Date.now() - lastUpload < RATE_LIMIT_MS) {
    return NextResponse.json({ error: "Rate limited. Try again in 30s." }, { status: 429 });
  }

  const formData = await req.formData();
  const file = formData.get("logo") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided. Use 'logo' field." }, { status: 400 });
  }

  // Reject declared non-raster types early (SVG, etc.); real format verified by magic bytes below.
  const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/jpg", ""];
  if (file.type && !allowedTypes.includes(file.type)) {
    return NextResponse.json(
      { error: `Invalid file type. Allowed: PNG, JPEG, WebP, GIF` },
      { status: 400 }
    );
  }

  // Max 2MB
  if (file.size > 2 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large. Max 2MB." }, { status: 400 });
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return NextResponse.json({ error: "Storage backend unavailable" }, { status: 503 });
  }

  // Check market exists
  const { data: market, error: marketError } = await supabase
    .from("markets")
    .select("slab_address")
    .eq("slab_address", validSlab)
    .single();

  if (marketError || !market) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const detected = detectRasterImage(buffer);
    if (!detected) {
      return NextResponse.json(
        { error: "Invalid image file. Upload a valid PNG, JPEG, WebP, or GIF (contents do not match)." },
        { status: 400 }
      );
    }

    const filePath = `market-logos/${validSlab}.${detected.ext}`;

    const { error: uploadError } = await supabase.storage
      .from("logos")
      .upload(filePath, buffer, { contentType: detected.contentType, upsert: true });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 500 });
    }

    const { data: urlData } = supabase.storage.from("logos").getPublicUrl(filePath);
    const publicUrl = urlData.publicUrl;

    const { error: updateError } = await supabase
      .from("markets")
      .update({ logo_url: publicUrl })
      .eq("slab_address", validSlab);

    if (updateError) {
      console.error("DB update error:", updateError);
      return NextResponse.json({ error: "Failed to save logo URL. Please try again." }, { status: 500 });
    }

    uploadTimestamps.set(validSlab, Date.now());

    return NextResponse.json({ logo_url: publicUrl }, { status: 200 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Failed to process upload" }, { status: 500 });
  }
}
