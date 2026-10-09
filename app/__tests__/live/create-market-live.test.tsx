// @vitest-environment happy-dom
/**
 * LIVE devnet harness (skipped unless LIVE_RPC is set): renders the REAL useCreateMarket with a
 * Keypair-backed wallet, a real Connection and the REAL play.percolator.trade API routes (session
 * cookie from LIVE_COOKIE_FILE), and counts every wallet signing request.
 *   LIVE_RPC=... LIVE_WALLET=kp.json LIVE_COOKIE_FILE=cookies.txt LIVE_LOG=out.log \
 *   LIVE_WALLET_MODE=signall|sequential|perTx LIVE_PROMPT_MS=0 npx vitest run __tests__/live/create-market-live.test.tsx
 * keeper-register is stubbed so the harness never enrolls a throwaway market with the prod keeper.
 */
import React from "react";
import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";

const RPC = process.env.LIVE_RPC ?? "";
const T0 = Date.now();
const LOG = (m: string) => fs.appendFileSync(process.env.LIVE_LOG ?? "/dev/null", `[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}\n`);
const conn = RPC ? new Connection(RPC, "confirmed") : (null as unknown as Connection);

vi.mock("@/hooks/useWalletCompat", async (orig) => {
  const real = await orig<typeof import("@/hooks/useWalletCompat")>();
  return { ...real, useConnectionCompat: () => ({ connection: conn }) };
});

import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { useCreateMarket, type CreateMarketParams } from "@/hooks/useCreateMarket";

const ORIGIN = "https://play.percolator.trade";
const cookie = (() => {
  try {
    const line = fs.readFileSync(process.env.LIVE_COOKIE_FILE ?? "", "utf8").split("\n").find((l) => l.includes("pg_access"));
    return line ? `pg_access=${line.trim().split(/\s+/).pop()}` : "";
  } catch { return ""; }
})();

let signingRequests = 0;
import https from "node:https";
// happy-dom's fetch enforces CORS; a browser on play.percolator.trade is same-origin, so go through node:https.
const realFetch = (async (url: string, init?: RequestInit & { headers?: Headers }) => {
  const u = new URL(url);
  const hdrs: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { hdrs[k] = v; });
  return await new Promise<Response>((resolve, reject) => {
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: init?.method ?? "GET", headers: hdrs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
    });
    req.on("error", reject);
    if (init?.body) req.write(init.body as string);
    req.end();
  });
}) as unknown as typeof fetch;
const happyFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("/api/")) return happyFetch(input, init);
  const path = url.split("?")[0];
  if (path === "/api/playground/keeper-register" && process.env.LIVE_STUB_REGISTER !== "0") {
    LOG(`HTTP ${init?.method ?? "GET"} ${path} -> STUBBED (not enrolling a test market)`);
    return new Response(JSON.stringify({ ok: true, registered: true }), { status: 200 });
  }
  const headers = new Headers(init?.headers);
  if (cookie) headers.set("cookie", cookie);
  const t = Date.now();
  const res = await realFetch(ORIGIN + url, { ...init, headers });
  const body = await res.clone().text();
  LOG(`HTTP ${init?.method ?? "GET"} ${path} -> ${res.status} (${Date.now() - t}ms) ${res.ok ? "" : body.slice(0, 300)}`);
  return res;
}) as typeof fetch;

function walletFor(kp: Keypair): WalletApi {
  const mode = process.env.LIVE_WALLET_MODE ?? "signall";
  const promptMs = Number(process.env.LIVE_PROMPT_MS ?? "0");
  const sign = async (tx: Transaction) => {
    signingRequests += 1;
    LOG(`SIGN REQUEST #${signingRequests} (signTransaction) ixs=${tx.instructions.length} blockhash=${tx.recentBlockhash?.slice(0, 8)}`);
    if (promptMs) await new Promise((r) => setTimeout(r, promptMs));
    tx.partialSign(kp);
    return tx;
  };
  return {
    publicKey: kp.publicKey, connected: true, connecting: false, wallet: null,
    signTransaction: sign,
    signAndSendTransaction: undefined,
    signMessage: undefined,
    // "perTx": signAllTransactions exists but prompts once per tx internally (Privy's per-tx fallback signer)
    signAllTransactions: mode === "perTx"
      ? async (txs: Transaction[]) => { const out: Transaction[] = []; for (const t of txs) out.push(await sign(t)); return out; }
      : mode === "signall"
      ? async (txs: Transaction[]) => {
          signingRequests += 1;
          LOG(`SIGN REQUEST #${signingRequests} (signAllTransactions x${txs.length})`);
          if (promptMs) await new Promise((r) => setTimeout(r, promptMs));
          txs.forEach((t) => t.partialSign(kp));
          return txs;
        }
      : undefined,
    disconnect: async () => {},
  };
}

describe.skipIf(!RPC)("LIVE: useCreateMarket launches a market", () => {
  it("launch", async () => {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.LIVE_WALLET ?? "", "utf8"))));
    const w = walletFor(kp);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <WalletApiContext.Provider value={w}>{children}</WalletApiContext.Provider>
    );
    const { result } = renderHook(() => useCreateMarket(), { wrapper });
    const SIM_USDC = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
    const params: CreateMarketParams = {
      mint: new PublicKey(SIM_USDC),
      initialPriceE6: 100_000n,
      lpCollateral: 1_000_000_000n,
      insuranceAmount: 100_000_000n,
      oracleFeed: "J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump",
      invert: false,
      tradingFeeBps: 10,
      initialMarginBps: 1000,
      symbol: "LIVETEST",
      name: "Live Test",
      decimals: 6,
      mainnetCA: "J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump",
      oracleMode: "keeper",
      dexPoolAddress: "3KFCgJ5R3zshW8hTDbzjSrrKSRYmKvsMfhc4Vo4iddxD",
      dexType: "pumpswap",
    };
    const warn = console.warn; const err = console.error;
    console.warn = (...a: unknown[]) => { LOG("WARN " + a.map(String).join(" ").slice(0, 400)); };
    console.error = (...a: unknown[]) => { LOG("ERR " + a.map(String).join(" ").slice(0, 400)); };
    let out: unknown;
    const bal0 = await conn.getBalance(kp.publicKey);
    LOG(`wallet=${kp.publicKey.toBase58()} sol=${bal0 / 1e9} mode=${process.env.LIVE_WALLET_MODE ?? "signall"} promptMs=${process.env.LIVE_PROMPT_MS ?? 0}`);
    await act(async () => { out = await result.current.create(params); });
    console.warn = warn; console.error = err;
    const s = result.current.state;
    LOG(`RESULT ${JSON.stringify(out)} phase=${s.phase} step=${s.step} slab=${s.slabAddress} error=${s.error} sigs=${s.txSigs.length} fallback=${s.batchFallbackReason ?? ""}`);
    LOG(`TOTAL SIGNING REQUESTS: ${signingRequests}`);
    expect(s.error).toBeNull();
  }, 600_000);
});
