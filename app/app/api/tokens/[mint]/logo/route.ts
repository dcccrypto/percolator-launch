import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";

const uploadTimestamps = new Map<string, number>();
const RATE_LIMIT_MS = 30_000;

// GET — retrieve logo for a token mint
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mint: string }> }
) {
  const { mint } = await params;

  try {
    new PublicKey(mint);
  } catch {
    return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Check all possible extensions
  const extensions = ["png", "jpg", "webp", "gif"];
  for (const ext of extensions) {
    const filePath = `token-logos/${mint}.${ext}`;
    const { data } = supabase.storage.from("logos").getPublicUrl(filePath);
    // Try a HEAD-like check by listing
    const { data: files } = await supabase.storage.from("logos").list("token-logos", {
      search: `${mint}.${ext}`,
      limit: 1,
    });
    if (files && files.length > 0) {
      return NextResponse.json({ logo_url: data.publicUrl });
    }
  }

  return NextResponse.json({ logo_url: null });
}

// POST — upload logo for a token mint (no market required)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ mint: string }> }
) {
  const { mint } = await params;

  try {
    new PublicKey(mint);
  } catch {
    return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
  }

  // Rate limit
  const lastUpload = uploadTimestamps.get(mint) ?? 0;
  if (Date.now() - lastUpload < RATE_LIMIT_MS) {
    return NextResponse.json({ error: "Rate limited. Try again in 30s." }, { status: 429 });
  }

  const formData = await req.formData();
  const file = formData.get("logo") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided. Use 'logo' field." }, { status: 400 });
  }

  const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json({ error: "Invalid file type. Allowed: PNG, JPEG, WebP, GIF" }, { status: 400 });
  }

  if (file.size > 2 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large. Max 2MB." }, { status: 400 });
  }

  const supabase = getServiceClient();

  try {
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : file.type === "image/gif" ? "gif" : "jpg";
    const filePath = `token-logos/${mint}.${ext}`;

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

    // If a market already exists for this mint, update its logo_url too
    await supabase
      .from("markets")
      .update({ logo_url: publicUrl })
      .eq("mint_address", mint);

    uploadTimestamps.set(mint, Date.now());

    return NextResponse.json({ logo_url: publicUrl }, { status: 200 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Failed to process upload" }, { status: 500 });
  }
}
