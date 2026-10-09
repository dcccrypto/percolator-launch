/**
 * GET /api/earn-share/<market>/image: the share token's icon (the `image` of the metadata JSON): a square 512 x 512 PNG, the market token's logo
 * with a Percolator badge in a corner, or the Percolator mark alone when the token has no usable logo. A stable URL (wallets cache by URL).
 *
 * The logo is creator-supplied content: it is fetched through the guards in lib/v22/earn-share-image.ts and RE-ENCODED by the renderer, served
 * from this origin. This route never redirects to a third-party URL. Same validation as the JSON route (canonical key + a wrapper-owned
 * registry PDA, else 404), v2.2 only.
 */
import { ImageResponse } from "next/og";
import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { getServiceClient } from "@/lib/supabase";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { parseMarketParam } from "@/lib/v22/earn-share-meta";
import { loadEarnShareChainState } from "@/lib/v22/earn-share-chain";
import { fetchLogoDataUrl, ownStorageHosts } from "@/lib/v22/earn-share-image";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CORS = { "Access-Control-Allow-Origin": "*" } as const;
const notFound = () => NextResponse.json({ error: "not found" }, { status: 404, headers: { ...CORS, "Cache-Control": "public, max-age=30, s-maxage=30" } });

/** The market's uploaded / resolved logo URL from the app's own table (cosmetic; any failure = no logo). */
async function logoUrlOf(market: string): Promise<string | null> {
  try {
    const { data } = await getServiceClient().from("markets").select("logo_url").eq("slab_address", market).single();
    return typeof data?.logo_url === "string" ? data.logo_url : null;
  } catch {
    return null;
  }
}

const SIZE = 512;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ market: string }> }) {
  if (!isDevnetV22Enabled()) return notFound();
  const { market: raw } = await params;
  const market = parseMarketParam(raw);
  if (!market) return notFound();
  let state;
  try {
    state = await loadEarnShareChainState(getServerConnection(), new PublicKey(getConfig().programId), market);
  } catch {
    return NextResponse.json({ error: "temporarily unavailable" }, { status: 503, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
  if (state.kind !== "ok") return notFound();

  const logo = await fetchLogoDataUrl(await logoUrlOf(market.toBase58()), ownStorageHosts());
  const badge = (size: number) => (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", width: size, height: size, borderRadius: size * 0.22,
        background: "linear-gradient(135deg, #0aff9d 0%, #00d4ff 100%)", color: "#050508", fontSize: size * 0.62, fontWeight: 700,
      }}
    >
      P
    </div>
  );
  const img = new ImageResponse(
    (
      <div style={{ width: SIZE, height: SIZE, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", background: "#050508" }}>
        {logo ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logo} width={400} height={400} style={{ width: 400, height: 400, borderRadius: 200, objectFit: "cover" }} alt="" />
            <div style={{ position: "absolute", right: 28, bottom: 28, display: "flex", padding: 6, borderRadius: 34, background: "#050508" }}>{badge(112)}</div>
          </>
        ) : (
          badge(320)
        )}
      </div>
    ),
    { width: SIZE, height: SIZE },
  );
  const headers = new Headers(img.headers);
  headers.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(img.body, { status: 200, headers });
}
