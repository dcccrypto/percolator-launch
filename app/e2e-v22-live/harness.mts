/**
 * v2.2 preview browser E2E harness (devnet, real chain, no wallet extension).
 *
 * A Wallet Standard wallet ("E2E Test Wallet") is injected into the page; the key never enters the
 * page — every signature is made in Node with a local throwaway devnet keypair (E2E_KEYPAIR, default
 * ~/.v22e2e-keys/trader.json). Adapted from the #2701 fork harness wallet (e2e-fork/wallet/inject.ts),
 * plus: a per-prompt log of the decoded tx (programs, ix count, size, signers) and the landed status of
 * each signature, so a flow is judged on chain and not on UI copy alone.
 *
 * Refuses any target that is not the v2.2 preview or a localhost build, and any keypair path that is
 * not a throwaway (never Khubair's wallets).
 *
 * Run (from app/): E2E_TEAM_SECRET=… [E2E_KEYPAIR=~/.v22e2e-keys/x.json] npx tsx e2e-v22-live/<flow>.mts <name> [args]
 *   probe · faucet · trade (SIDE/SIZE/LEV/OPEN/CLOSE, FAULT=two-tx) · earn / earn-finish · stake · portfolio /
 *   portfolio-close · create (LAUNCH=1 to launch) · map <name> <route> [scope]. Output: E2E_OUT (screenshots, prompt
 *   logs, rpc traces). Throwaway keys need devnet SOL; USDC comes from the app's own /faucet flow.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const WALLET_NAME = "E2E Test Wallet";
export const BASE_URL = process.env.E2E_BASE_URL ?? "https://percolator-v22-preview.vercel.app";
export const OUT_DIR = process.env.E2E_OUT ?? path.join(os.tmpdir(), "v22-browser-e2e");
export const RPC = process.env.E2E_RPC ?? "https://api.devnet.solana.com";

const ALLOWED_HOSTS = ["percolator-v22-preview.vercel.app", "localhost", "127.0.0.1"];
if (!ALLOWED_HOSTS.includes(new URL(BASE_URL).hostname) && !/^percolator-v22-preview-[a-z0-9-]+\.vercel\.app$/.test(new URL(BASE_URL).hostname)) {
  throw new Error(`refusing target ${BASE_URL}: v2.2 preview or localhost only`);
}

export function loadKeypair(p = process.env.E2E_KEYPAIR ?? path.join(os.homedir(), ".v22e2e-keys/trader.json")): Keypair {
  // Throwaway devnet keys only, kept outside the repo; refuse anything else (never a person's wallet).
  if (!p.includes(".v22e2e-keys")) throw new Error(`refusing keypair ${p}: only throwaway keys under a .v22e2e-keys directory`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export interface SignLogEntry {
  at: string;
  kind: "tx" | "msg";
  bytes: number;
  version?: string;
  programs?: string[];
  ixCount?: number;
  signers?: string[];
  sig?: string;
}

function describe(raw: Buffer): Pick<SignLogEntry, "version" | "programs" | "ixCount" | "signers"> {
  try {
    const vt = VersionedTransaction.deserialize(raw);
    const m = vt.message;
    const keys = m.staticAccountKeys.map((k) => k.toBase58());
    const ixs = m.compiledInstructions;
    return {
      version: String(vt.version),
      programs: ixs.map((ix) => keys[ix.programIdIndex] ?? `alt#${ix.programIdIndex}`),
      ixCount: ixs.length,
      signers: keys.slice(0, m.header.numRequiredSignatures),
    };
  } catch {
    const t = Transaction.from(raw);
    return {
      version: "legacy",
      programs: t.instructions.map((i) => i.programId.toBase58()),
      ixCount: t.instructions.length,
      signers: t.signatures.map((s) => s.publicKey.toBase58()),
    };
  }
}

export async function installTestWallet(page: Page, kp: Keypair, opts: { autoConnect?: boolean; reject?: () => boolean } = {}): Promise<SignLogEntry[]> {
  const log: SignLogEntry[] = [];
  await page.exposeFunction("__e2eSignTx", async (b64: string): Promise<string> => {
    const raw = Buffer.from(b64, "base64");
    const entry: SignLogEntry = { at: new Date().toISOString(), kind: "tx", bytes: raw.length, ...describe(raw) };
    log.push(entry);
    if (opts.reject?.()) throw new Error("User rejected the request.");
    try {
      const vt = VersionedTransaction.deserialize(raw);
      if (vt.version !== "legacy") {
        vt.sign([kp]);
        entry.sig = bs58.encode(vt.signatures[0]);
        return Buffer.from(vt.serialize()).toString("base64");
      }
    } catch { /* legacy below */ }
    const t = Transaction.from(raw);
    t.partialSign(kp);
    entry.sig = t.signature ? bs58.encode(t.signature) : undefined;
    return t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  });
  await page.exposeFunction("__e2eSignMsg", async (b64: string): Promise<string> => {
    const m = Buffer.from(b64, "base64");
    log.push({ at: new Date().toISOString(), kind: "msg", bytes: m.length });
    return Buffer.from(nacl.sign.detached(m, kp.secretKey)).toString("base64");
  });
  // Raw JS string: tsx/esbuild would inject a `__name` helper into a function argument, which does
  // not exist in the page (ReferenceError, the wallet never registers).
  const cfg = JSON.stringify({ address: kp.publicKey.toBase58(), pk: Array.from(kp.publicKey.toBytes()), name: WALLET_NAME, autoConnect: opts.autoConnect ?? false });
  await page.addInitScript(`(() => {
    const { address, pk, name, autoConnect } = ${cfg};
    const b64 = (u) => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
    const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const CHAINS = ["solana:devnet", "solana:localnet", "solana:mainnet", "solana:testnet"];
    const account = { address, publicKey: new Uint8Array(pk), chains: CHAINS, features: ["solana:signTransaction", "solana:signMessage"] };
    let accounts = [];
    const listeners = { change: [] };
    const emit = () => listeners.change.forEach((f) => f({ accounts }));
    const signOne = async (tx) => unb64(await window.__e2eSignTx(b64(tx)));
    const wallet = {
      version: "1.0.0",
      name,
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz48L3N2Zz4=",
      chains: CHAINS,
      get accounts() { return accounts; },
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { accounts = [account]; emit(); return { accounts }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { accounts = []; emit(); } },
        "standard:events": { version: "1.0.0", on: (ev, f) => { (listeners[ev] ??= []).push(f); return () => { listeners[ev] = listeners[ev].filter((x) => x !== f); }; } },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedTransaction: await signOne(i.transaction) }))),
        },
        "solana:signMessage": {
          version: "1.0.0",
          signMessage: async (...inputs) => Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await window.__e2eSignMsg(b64(i.message))) }))),
        },
      },
    };
    window.__e2eWallet = wallet;
    const register = (api) => api.register(wallet);
    try { window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register })); } catch {}
    window.addEventListener("wallet-standard:app-ready", (e) => register(e.detail));
    if (autoConnect) { try { localStorage.setItem("walletName", JSON.stringify(name)); } catch {} }
  })();`);
  return log;
}

/** The preview's tester-link secret (`/enter?team=`), from the environment only; never written anywhere. */
function teamSecret(): string {
  const v = process.env.E2E_TEAM_SECRET?.trim();
  if (!v) throw new Error("set E2E_TEAM_SECRET (the preview's team bypass secret) in the environment");
  return v;
}

export interface Session {
  browser: Browser;
  ctx: BrowserContext;
  page: Page;
  kp: Keypair;
  log: SignLogEntry[];
  events: string[];
  shot: (name: string) => Promise<string>;
  note: (s: string) => void;
  close: () => Promise<void>;
}

export async function openSession(flow: string, opts: { keypair?: string; autoConnect?: boolean; viewport?: { width: number; height: number } } = {}): Promise<Session> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const kp = loadKeypair(opts.keypair);
  const browser = await chromium.launch({ headless: process.env.E2E_HEADED !== "1" });
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const events: string[] = [];
  const note = (s: string) => { const l = `${new Date().toISOString()} ${s}`; events.push(l); console.log(`[${flow}] ${s}`); };
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning" || /\[use[A-Z]|multi-asset|refresh/.test(m.text())) events.push(`console.${m.type()}: ${m.text().slice(0, 600)}`); });
  page.on("pageerror", (e) => events.push(`pageerror: ${String(e).slice(0, 600)}`));
  // RPC errors the app sees (sendTransaction / simulateTransaction answers), so a refusal is attributed.
  page.on("response", async (r) => {
    if (!r.url().includes("/api/rpc")) return;
    try {
      const req = r.request().postDataJSON() as { method?: string } | Array<{ method?: string }>;
      const methods = (Array.isArray(req) ? req : [req]).map((x) => x?.method);
      if (!methods.some((m) => m === "sendTransaction" || m === "simulateTransaction")) return;
      const body = await r.json();
      const arr = Array.isArray(body) ? body : [body];
      for (const b of arr) {
        const err = b?.error ?? b?.result?.value?.err;
        if (err) events.push(`rpc ${methods.join(",")} err: ${JSON.stringify(err).slice(0, 400)} logs: ${JSON.stringify(b?.result?.value?.logs?.slice(-6) ?? b?.error?.data?.logs?.slice(-6) ?? []).slice(0, 900)}`);
        else if (methods.includes("sendTransaction")) events.push(`rpc sendTransaction ok: ${b?.result}`);
      }
    } catch { /* non-JSON */ }
  });
  // tsx keeps function names via an esbuild `__name` helper; functions handed to page.evaluate need it in the page.
  await page.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
  const log = await installTestWallet(page, kp, { autoConnect: opts.autoConnect });
  await page.goto(`${BASE_URL}/enter?team=${encodeURIComponent(teamSecret())}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  let n = 0;
  const shot = async (name: string) => {
    const f = path.join(OUT_DIR, `${flow}-${String(++n).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: f, fullPage: false });
    return f;
  };
  const close = async () => {
    fs.writeFileSync(path.join(OUT_DIR, `${flow}-log.json`), JSON.stringify({ wallet: kp.publicKey.toBase58(), base: BASE_URL, prompts: log, events }, null, 2));
    await browser.close();
  };
  return { browser, ctx, page, kp, log, events, shot, note, close };
}

/** Connect through the app's own UI (header connect button → our wallet). */
export async function connectViaUi(s: Session): Promise<void> {
  const { page } = s;
  const btn = page.getByTestId("wallet-connect").first();
  await btn.waitFor({ state: "visible", timeout: 30_000 });
  const label = (await btn.textContent())?.trim() ?? "";
  if (/solflare|phantom|backpack|install/i.test(label)) throw new Error(`connect button offers "${label}", not ${WALLET_NAME}; refusing to click (never a real wallet)`);
  await btn.click();
  const choice = page.getByRole("button", { name: new RegExp(WALLET_NAME, "i") }).or(page.getByRole("menuitem", { name: new RegExp(WALLET_NAME, "i") }));
  if (await choice.first().isVisible({ timeout: 3_000 }).catch(() => false)) await choice.first().click();
  const short = `${s.kp.publicKey.toBase58().slice(0, 4)}`;
  await page.getByText(new RegExp(short)).first().waitFor({ timeout: 20_000 });
}

const conn = new Connection(RPC, "confirmed");
export async function sigStatus(sig: string): Promise<{ sig: string; landed: boolean; err: unknown; slot?: number }> {
  for (let i = 0; i < 20; i++) {
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { sig, landed: st.err == null, err: st.err, slot: st.slot };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { sig, landed: false, err: "not found after 30s" };
}

export async function tokenBalance(owner: PublicKey, mint: PublicKey): Promise<number> {
  const r = await conn.getParsedTokenAccountsByOwner(owner, { mint });
  return r.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
}

export { conn };

/** Visible buttons / inputs / testids, for mapping a page's controls. */
export async function dump(page: Page, scope = "body"): Promise<string> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) ?? document.body;
    const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out: string[] = [];
    root.querySelectorAll("button, input, select, textarea, a[role=button], [data-testid]").forEach((e) => {
      if (!vis(e)) return;
      const t = (e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const tid = e.getAttribute("data-testid");
      const ph = e.getAttribute("placeholder");
      const dis = (e as HTMLButtonElement).disabled ? " [disabled]" : "";
      out.push(`${e.tagName.toLowerCase()}${tid ? `#${tid}` : ""}${ph ? ` ph="${ph}"` : ""}${t ? ` "${t}"` : ""}${dis}`);
    });
    return out.join("\n");
  }, scope);
}

export const USDC_V22 = new PublicKey("ERe2nVetnKFH4Am7hh1cVWXd52s7uhWjorwFkU61kwan");

/** A decoded `/api/rpc` simulate/send call. `n` counts simulate calls in this session. */
export interface RpcCall { n: number; method: string; ixCount: number; programs: string[]; cuLimit?: number; data: string[] }
/** Return a replacement JSON-RPC `result.value` (or `{ error }`) to inject a fault; undefined = real answer. */
export type RpcFault = (call: RpcCall) => Record<string, unknown> | undefined;

function decodeTxB64(b64: string): { programs: string[]; data: string[]; cuLimit?: number } {
  const raw = Buffer.from(b64, "base64");
  const vt = VersionedTransaction.deserialize(raw);
  const keys = vt.message.staticAccountKeys.map((k) => k.toBase58());
  const ixs = vt.message.compiledInstructions;
  const programs = ixs.map((ix) => keys[ix.programIdIndex]);
  const data = ixs.map((ix) => Buffer.from(ix.data).toString("hex"));
  let cuLimit: number | undefined;
  ixs.forEach((ix, k) => { if (programs[k] === "ComputeBudget111111111111111111111111111111" && ix.data[0] === 2) cuLimit = Buffer.from(ix.data).readUInt32LE(1); });
  return { programs, data, cuLimit };
}

/** Trace every simulate/send through /api/rpc into `trace`, and apply `fault` (if any). */
export async function traceRpc(page: Page, trace: string[], fault?: RpcFault): Promise<void> {
  let n = 0;
  await page.route("**/api/rpc**", async (route) => {
    const req = route.request();
    let body: { method?: string; params?: unknown[]; id?: unknown } | null = null;
    try { body = req.postDataJSON(); } catch { /* not JSON */ }
    if (!body || Array.isArray(body) || (body.method !== "simulateTransaction" && body.method !== "sendTransaction")) return route.continue();
    let call: RpcCall | null = null;
    try {
      const d = decodeTxB64(String(body.params?.[0]));
      call = { n: body.method === "simulateTransaction" ? ++n : 0, method: body.method, ixCount: d.programs.length, programs: d.programs, data: d.data, cuLimit: d.cuLimit };
    } catch { /* undecodable */ }
    const injected = call && fault ? fault(call) : undefined;
    if (call && injected) {
      trace.push(`${new Date().toISOString()} INJECTED ${call.method}#${call.n} ixs=${call.ixCount} cu=${call.cuLimit} -> ${JSON.stringify(injected).slice(0, 200)}`);
      const slot = 1;
      const json = "error" in injected ? { jsonrpc: "2.0", id: body.id, error: injected.error } : { jsonrpc: "2.0", id: body.id, result: { context: { slot }, value: injected } };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
    }
    const r = await route.fetch();
    let txt = await r.text();
    try {
      const j = JSON.parse(txt);
      const v = j?.result?.value;
      trace.push(`${new Date().toISOString()} ${call?.method}#${call?.n} ixs=${call?.ixCount} cu=${call?.cuLimit} progs=${call?.programs.map((p) => p.slice(0, 4)).join(",")} -> ${j.error ? `rpcerr ${JSON.stringify(j.error).slice(0, 200)}` : call?.method === "sendTransaction" ? `sig ${j.result}` : `err=${JSON.stringify(v?.err)} units=${v?.unitsConsumed}`}`);
    } catch { /* keep */ }
    return route.fulfill({ response: r, body: txt });
  });
}
