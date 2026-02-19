import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  "https://percolator-api1-production.up.railway.app";

const RPC_URL =
  process.env.HELIUS_API_KEY
    ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      "https://api.devnet.solana.com";

async function checkWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 3000
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const [apiOk, rpcOk] = await Promise.all([
    checkWithTimeout(`${API_URL}/health`, {}, 3000),
    checkWithTimeout(
      RPC_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      },
      3000
    ),
  ]);

  const status = apiOk && rpcOk ? "online" : apiOk ? "degraded" : "offline";

  return NextResponse.json(
    { status, api: apiOk, rpc: rpcOk, ts: Date.now() },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}
