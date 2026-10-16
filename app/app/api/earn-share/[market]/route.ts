/**
 * GET /api/earn-share/<market>: the metadata JSON wallets fetch for an Earn share token (the `uri` of its Metaplex record, written by wrapper
 * tag 122). Spec: percolator-prog `docs/v22-lp-share-mint.md` ("The JSON the app must serve"); review R10.
 *
 *  - v2.2 only: with `NEXT_PUBLIC_DEVNET_V22` unset the route answers 404 (it does not exist as far as a v2.1 deployment is concerned).
 *  - The path parameter must be a canonical base58 32-byte key AND the LP vault registry PDA `["lp_vault", market]` must exist and be owned by
 *    the wrapper; otherwise 404. The parameter is never echoed (the response carries the re-encoded canonical key only).
 *  - Built from CHAIN STATE only (the registry account and the Metaplex record of the share mint). No app database, no secret, no request
 *    header: the public base URL is a constant of the program build.
 *  - Public, cacheable, `Access-Control-Allow-Origin: *`, no authentication.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getConfig, getNetwork } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { PublicKey } from "@solana/web3.js";
import { buildEarnShareMetadata, parseMarketParam, shareBaseUrl, shareIdentityFromChain } from "@/lib/v22/earn-share-meta";
import { loadEarnShareChainState } from "@/lib/v22/earn-share-chain";
import { earnShareRateLimit, hasQuery, marketIsKnown, rememberUnknown } from "@/lib/v22/earn-share-guard";

export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" } as const;
const OK_CACHE = { "Cache-Control": "public, max-age=300, s-maxage=300" } as const;
const MISS_CACHE = { "Cache-Control": "public, max-age=30, s-maxage=30" } as const;

const notFound = () => NextResponse.json({ error: "not found" }, { status: 404, headers: { ...CORS, ...MISS_CACHE } });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ market: string }> }) {
  if (!isDevnetV22Enabled()) return notFound();
  const { market: raw } = await params;
  const market = parseMarketParam(raw);
  if (!market || hasQuery(_req)) return notFound(); // a query string is not part of the contract (it would bypass URL-keyed caches)
  const limited = await earnShareRateLimit(_req, "json", CORS);
  if (limited) return limited;
  // The market must be one of ours BEFORE any RPC read (random valid-looking keys must cost nothing on chain).
  const known = await marketIsKnown(market.toBase58());
  if (known === "unavailable") return NextResponse.json({ error: "temporarily unavailable" }, { status: 503, headers: { ...CORS, "Cache-Control": "no-store" } });
  if (known === "unknown") return notFound();
  let state;
  try {
    state = await loadEarnShareChainState(getServerConnection(), new PublicKey(getConfig().programId), market);
  } catch {
    return NextResponse.json({ error: "temporarily unavailable" }, { status: 503, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
  if (state.kind !== "ok") {
    rememberUnknown(market.toBase58());
    return notFound();
  }
  const base = shareBaseUrl(getNetwork());
  const id = shareIdentityFromChain(market, state.record, { registry: state.registry, mint: state.mint }, base);
  return NextResponse.json(buildEarnShareMetadata(market, id, base), { status: 200, headers: { ...CORS, ...OK_CACHE } });
}
