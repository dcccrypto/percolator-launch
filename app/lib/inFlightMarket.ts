/**
 * In-flight market state persistence.
 *
 * Survives tab close so a market that creates a slab on-chain but doesn't
 * complete TX1/TX2/TX3 can still be recovered.
 *
 * 2026-05-12: PERC-8329 (slab-secret-not-in-localStorage) is INTENTIONALLY
 * superseded for this flow. The slab secret key IS persisted so the
 * uninitialised-slab reclaim path (ReclaimSlabRent / tag 52, signed by the
 * slab keypair) works after tab close. Trade-off accepted because:
 *   - Closed beta uses small bounded amounts (~100-200 USDC)
 *   - Without the secret, the only recovery for a half-created slab is the
 *     CLI script — defeats the in-UI recovery design
 *   - Same-origin script exfiltration risk is bounded by SDK pin + CSP
 * If you ever raise the LP bootstrap amounts, revisit this.
 */

const KEY_PREFIX = "percolator:in-flight-market:";
const POINTER_KEY = "percolator:last-in-flight-key";

export type InFlightMarketState = {
  slabAddress: string;
  /** Slab Keypair secret key, serialized as number[] (length 64). Required for the
   *  in-UI reclaim path (ReclaimSlabRent signs with this key). */
  slabSecretKey: number[];
  adminAddress: string;
  collateralAta: string;
  collateralMint: string;
  programId: string;
  network: "mainnet" | "devnet";
  createdAt: number;
  lastStep: number; // 0 = before TX0 sent, 1 = TX0 done, 2 = TX1 done, 3 = TX2 done, 4 = TX3 done
};

const isBrowser = () => typeof window !== "undefined" && !!window.localStorage;

const keyFor = (slabAddress: string) => `${KEY_PREFIX}${slabAddress}`;

export function saveInFlightMarket(state: InFlightMarketState): void {
  if (!isBrowser()) return;
  try {
    const k = keyFor(state.slabAddress);
    window.localStorage.setItem(k, JSON.stringify(state));
    window.localStorage.setItem(POINTER_KEY, k);
  } catch (err) {
    // localStorage quota / disabled mode — not fatal, the tx still proceeds
    console.warn("[inFlightMarket] save failed", err);
  }
}

export function updateInFlightStep(slabAddress: string, lastStep: number): void {
  if (!isBrowser()) return;
  try {
    const raw = window.localStorage.getItem(keyFor(slabAddress));
    if (!raw) return;
    const state = JSON.parse(raw) as InFlightMarketState;
    state.lastStep = lastStep;
    window.localStorage.setItem(keyFor(slabAddress), JSON.stringify(state));
  } catch (err) {
    console.warn("[inFlightMarket] updateStep failed", err);
  }
}

export function clearInFlightMarket(slabAddress: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(keyFor(slabAddress));
    const ptr = window.localStorage.getItem(POINTER_KEY);
    if (ptr === keyFor(slabAddress)) {
      window.localStorage.removeItem(POINTER_KEY);
    }
  } catch (err) {
    console.warn("[inFlightMarket] clear failed", err);
  }
}

export function loadLastInFlightMarket(): InFlightMarketState | null {
  if (!isBrowser()) return null;
  try {
    const ptr = window.localStorage.getItem(POINTER_KEY);
    if (!ptr) return null;
    const raw = window.localStorage.getItem(ptr);
    if (!raw) return null;
    return JSON.parse(raw) as InFlightMarketState;
  } catch {
    return null;
  }
}

export function loadAllInFlightMarkets(): InFlightMarketState[] {
  if (!isBrowser()) return [];
  const out: InFlightMarketState[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      const raw = window.localStorage.getItem(k);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as InFlightMarketState);
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * Build the JSON payload that scripts/close-market-reclaim-all.ts (and
 * any future recovery script) expects. Excludes the slab secret key by
 * default — that's only persisted in localStorage for the in-UI reclaim
 * path. Set includeSlabSecret=true if you want to bundle the secret in
 * the download (useful for full off-machine recovery; users who choose
 * this should treat the file as sensitive).
 */
export function buildRecoveryPayload(
  state: InFlightMarketState,
  options: { includeSlabSecret?: boolean } = {},
): string {
  const payload: Record<string, unknown> = {
    slab_address: state.slabAddress,
    admin_address: state.adminAddress,
    collateral_ata: state.collateralAta,
    collateral_mint: state.collateralMint,
    program_id: state.programId,
    network: state.network,
    created_at: new Date(state.createdAt).toISOString(),
    last_step: state.lastStep,
    _instructions: [
      "Save this file as recovery.json.",
      `Run: SLAB_ADDRESS=${state.slabAddress} pnpm exec tsx scripts/close-market-reclaim-all.ts --dry-run`,
      "Review the plan, then drop --dry-run to execute.",
      "Requires admin keypair at ~/.percolator-mainnet/keys/deploy-authority.json (or set ADMIN_KEYPAIR env var).",
    ],
  };
  if (options.includeSlabSecret) {
    payload.slab_secret_key = state.slabSecretKey;
    payload._slab_secret_warning =
      "This file contains the slab keypair secret. Treat as sensitive. Required only if you want to reclaim slab rent via ReclaimSlabRent (tag 52); the admin-side close path does not need it.";
  }
  return JSON.stringify(payload, null, 2);
}
