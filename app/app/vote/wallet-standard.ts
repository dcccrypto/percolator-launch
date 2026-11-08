/**
 * Minimal Wallet Standard discovery (no dependency): finds injected wallets
 * (Phantom, Solflare, Backpack, ...) that support connect + solana:signMessage.
 * Client-only. The app never sees a private key; the wallet signs the text.
 */
export interface StdAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
}
export interface StdWallet {
  readonly name: string;
  readonly icon: string;
  readonly features: Readonly<Record<string, unknown>>;
  readonly accounts: readonly StdAccount[];
}
type ConnectFeature = { connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly StdAccount[] }> };
type SignFeature = {
  signMessage: (...inputs: { account: StdAccount; message: Uint8Array }[]) => Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>;
};

export function canSign(w: StdWallet): boolean {
  return !!w.features?.["standard:connect"] && !!w.features?.["solana:signMessage"];
}

/** Calls `onChange` with every signing-capable wallet registered so far; returns an unsubscribe. */
export function discoverWallets(onChange: (wallets: StdWallet[]) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const found = new Map<string, StdWallet>();
  const api = {
    register: (...ws: StdWallet[]) => {
      for (const w of ws) if (w && typeof w.name === "string" && canSign(w)) found.set(w.name, w);
      onChange([...found.values()]);
      return () => {};
    },
  };
  const onRegister = (e: Event) => {
    const cb = (e as CustomEvent).detail;
    if (typeof cb === "function") cb(api);
  };
  window.addEventListener("wallet-standard:register-wallet", onRegister);
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  return () => window.removeEventListener("wallet-standard:register-wallet", onRegister);
}

export async function connectWallet(w: StdWallet): Promise<StdAccount | null> {
  const r = await (w.features["standard:connect"] as ConnectFeature).connect();
  const a = r.accounts?.[0] ?? w.accounts?.[0];
  return a ?? null;
}

/** Signs `message` exactly; refuses if the wallet signed different bytes. */
export async function signText(w: StdWallet, account: StdAccount, message: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(message);
  const [out] = await (w.features["solana:signMessage"] as SignFeature).signMessage({ account, message: bytes });
  if (!out || out.signature?.length !== 64) throw new Error("Wallet returned no signature");
  const signed = out.signedMessage ?? bytes;
  if (signed.length !== bytes.length || signed.some((b, i) => b !== bytes[i])) throw new Error("Wallet altered the message");
  return out.signature;
}
