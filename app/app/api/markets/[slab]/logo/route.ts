import { NextRequest, NextResponse } from "next/server";
import { requireAuth, UNAUTHORIZED } from "@/lib/api-auth";
import { getServiceClient } from "@/lib/supabase";
import { PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";

// GET /api/markets/[slab]/logo - Get logo URL for a market
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
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  return NextResponse.json({ logo_url: data.logo_url });
}

// PUT /api/markets/[slab]/logo - Update logo URL for a market
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  if (!requireAuth(req)) return UNAUTHORIZED;

  const { slab } = await params;
  const body = await req.json();
  const { logo_url } = body;

  if (!logo_url || typeof logo_url !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid logo_url" },
      { status: 400 }
    );
  }

  // Validate slab address format
  try {
    new PublicKey(slab);
  } catch {
    return NextResponse.json(
      { error: "Invalid slab address" },
      { status: 400 }
    );
  }

  // Validate URL format (basic check)
  try {
    new URL(logo_url);
  } catch {
    return NextResponse.json(
      { error: "Invalid logo_url format. Must be a valid URL." },
      { status: 400 }
    );
  }

  const supabase = getServiceClient();

  // Update logo_url
  const { data, error } = await supabase
    .from("markets")
    .update({ logo_url })
    .eq("slab_address", slab)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ market: data }, { status: 200 });
}

// POST /api/markets/[slab]/logo/upload - Upload logo file to Supabase Storage
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  if (!requireAuth(req)) return UNAUTHORIZED;

  const { slab } = await params;

  // Validate slab address format
  try {
    new PublicKey(slab);
  } catch {
    return NextResponse.json(
      { error: "Invalid slab address" },
      { status: 400 }
    );
  }

  // Get the uploaded file from form data
  const formData = await req.formData();
  const file = formData.get("logo") as File | null;

  if (!file) {
    return NextResponse.json(
      { error: "No file provided. Use 'logo' field name." },
      { status: 400 }
    );
  }

  // Validate file type
  const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/svg+xml"];
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json(
      { error: `Invalid file type. Allowed: ${allowedTypes.join(", ")}` },
      { status: 400 }
    );
  }

  // Validate file size (max 5MB)
  const maxSize = 5 * 1024 * 1024; // 5MB
  if (file.size > maxSize) {
    return NextResponse.json(
      { error: "File too large. Maximum size is 5MB." },
      { status: 400 }
    );
  }

  const supabase = getServiceClient();

  // Check if market exists
  const { data: market, error: marketError } = await supabase
    .from("markets")
    .select("slab_address")
    .eq("slab_address", slab)
    .single();

  if (marketError || !market) {
    return NextResponse.json(
      { error: "Market not found" },
      { status: 404 }
    );
  }

  try {
    // Get file extension
    const ext = file.name.split(".").pop() || "png";
    const fileName = `${slab}.${ext}`;
    const filePath = `market-logos/${fileName}`;

    // Convert File to ArrayBuffer and then to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from("logos")
      .upload(filePath, buffer, {
        contentType: file.type,
        upsert: true, // Replace existing file if it exists
      });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      return NextResponse.json(
        { error: `Failed to upload file: ${uploadError.message}` },
        { status: 500 }
      );
    }

    // Get public URL
    const { data: urlData } = supabase
      .storage
      .from("logos")
      .getPublicUrl(filePath);

    const publicUrl = urlData.publicUrl;

    // Update market with logo URL
    const { data: updatedMarket, error: updateError } = await supabase
      .from("markets")
      .update({ logo_url: publicUrl })
      .eq("slab_address", slab)
      .select()
      .single();

    if (updateError) {
      console.error("Database update error:", updateError);
      return NextResponse.json(
        { error: `Failed to update market: ${updateError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: "Logo uploaded successfully",
      logo_url: publicUrl,
      market: updatedMarket,
    }, { status: 200 });

  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Failed to process upload" },
      { status: 500 }
    );
  }
}
