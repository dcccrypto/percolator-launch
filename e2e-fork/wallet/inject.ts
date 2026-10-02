/**
 * Test wallet for Playwright: a Wallet Standard wallet injected into the page.
 * The page never holds the key — signing is delegated to Node via
 * page.exposeFunction, using a THROWAWAY Keypair generated in-session.
 * Local validator only: signed txs are sent by the app through its /api/rpc proxy,
 * whose upstream (DEVNET_RPC_URL) the harness points at the local surfpool.
 */
import type { Page } from "@playwright/test";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

export const WALLET_NAME = "E2E Test Wallet";

export interface SignLogEntry { at: number; kind: "tx" | "msg"; bytes: number; sig?: string }

export async function installTestWallet(page: Page, kp: Keypair, opts: { autoConnect?: boolean; beforeSign?: (raw: Buffer) => Promise<void> } = {}): Promise<SignLogEntry[]> {
  const log: SignLogEntry[] = [];
  await page.exposeFunction("__e2eSignTx", async (b64: string): Promise<string> => {
    const raw = Buffer.from(b64, "base64");
    const entry: SignLogEntry = { at: Date.now(), kind: "tx", bytes: raw.length };
    log.push(entry);
    if (opts.beforeSign) await opts.beforeSign(raw);
    // versioned first (message prefix bit 0x80), else legacy
    try {
      const vt = VersionedTransaction.deserialize(raw);
      if (vt.version !== "legacy") { vt.sign([kp]); entry.sig = bs58.encode(vt.signatures[0]); return Buffer.from(vt.serialize()).toString("base64"); }
    } catch { /* legacy */ }
    const t = Transaction.from(raw);
    t.partialSign(kp);
    entry.sig = t.signature ? bs58.encode(t.signature) : undefined;
    return t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  });
  await page.exposeFunction("__e2eSignMsg", async (b64: string): Promise<string> => {
    const m = Buffer.from(b64, "base64");
    log.push({ at: Date.now(), kind: "msg", bytes: m.length });
    return Buffer.from(nacl.sign.detached(m, kp.secretKey)).toString("base64");
  });
  await page.addInitScript(
    ({ address, pk, name, autoConnect }) => {
      const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
      const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const CHAINS = ["solana:devnet", "solana:localnet", "solana:mainnet", "solana:testnet"];
      const account = {
        address,
        publicKey: new Uint8Array(pk),
        chains: CHAINS,
        features: ["solana:signTransaction", "solana:signMessage"],
      };
      let accounts: typeof account[] = [];
      const listeners: Record<string, Array<(p: unknown) => void>> = { change: [] };
      const emit = () => listeners.change.forEach((f) => f({ accounts }));
      const w = window as unknown as Record<string, any>;
      const signOne = async (tx: Uint8Array) => unb64(await w.__e2eSignTx(b64(tx)));
      const wallet = {
        version: "1.0.0",
        name,
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz48L3N2Zz4=",
        chains: CHAINS,
        get accounts() { return accounts; },
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => { accounts = [account]; emit(); return { accounts }; } },
          "standard:disconnect": { version: "1.0.0", disconnect: async () => { accounts = []; emit(); } },
          "standard:events": { version: "1.0.0", on: (ev: string, f: (p: unknown) => void) => { (listeners[ev] ??= []).push(f); return () => { listeners[ev] = listeners[ev].filter((x) => x !== f); }; } },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signTransaction: async (...inputs: Array<{ transaction: Uint8Array }>) =>
              Promise.all(inputs.map(async (i) => ({ signedTransaction: await signOne(i.transaction) }))),
          },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage: async (...inputs: Array<{ message: Uint8Array }>) =>
              Promise.all(inputs.map(async (i) => ({ signedMessage: i.message, signature: unb64(await w.__e2eSignMsg(b64(i.message))) }))),
          },
        },
      };
      w.__e2eWallet = wallet;
      const register = (api: { register: (x: unknown) => void }) => api.register(wallet);
      try {
        window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
      } catch { /* ignore */ }
      window.addEventListener("wallet-standard:app-ready", (e: Event) => register((e as CustomEvent).detail));
      if (autoConnect) {
        try { localStorage.setItem("walletName", JSON.stringify(name)); } catch { /* ignore */ }
      }
    },
    { address: kp.publicKey.toBase58(), pk: Array.from(kp.publicKey.toBytes()), name: WALLET_NAME, autoConnect: opts.autoConnect ?? true },
  );
  return log;
}

/**
 * Hermetic pool pick: DexScreener (live, external) decides which pool the wizard launches on. On 2026-09-30 it
 * ranked WIF's Meteora DAMM v1 pool first — a pool the keeper cannot price (B21) — so the wizard journeys launched
 * orphaned markets. Keep ONLY pools this harness loaded into the validator; B21 itself is recorded separately.
 */
export async function pinDexPools(page: Page, allow: string[] = (process.env.E2E_POOL_ALLOW ?? "ADEjbFryutjfrJTpZfFPRMFhF7XBisPY63Awe79EVhe9,4mMDQ5kG9fFrBSQeedErsUoTBhY5KKnsKWGvenXRTwSy").split(",")): Promise<void> {
  const keep = new Set(allow);
  await page.route(/api\.dexscreener\.com/, async (route) => {
    const r = await route.fetch();
    let j: any; try { j = await r.json(); } catch { return route.fulfill({ response: r }); }
    if (Array.isArray(j?.pairs)) j.pairs = j.pairs.filter((p: any) => keep.has(p.pairAddress));
    return route.fulfill({ response: r, json: j });
  });
}
