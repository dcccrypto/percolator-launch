/**
 * Live (RPC / wallet / route-backed) dependencies for `attemptSingleTxLaunch`. Kept apart from run.ts so
 * the orchestrator stays pure and the hook tests can replace this module wholesale.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { sendV1, simulateV1 } from "@/lib/v21/sdk";
import type { RawTxSigner } from "@/lib/tx-v1";
import type { LaunchSigStatus, SingleTxLaunchDeps } from "./run";

/** The fields the co-sign route already takes for the legacy co-sign (it re-derives the pair from them). */
export interface KeeperCosignRequestBase {
  deployer: string;
  slabAddress: string;
  initialPriceE6: string;
  assetIndex: 0;
  fresh: true;
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** POST the v1 message to the co-sign route; resolves the keeper's signature (64 bytes). */
export async function requestKeeperV1Signature(base: KeeperCosignRequestBase, message: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const r = await fetchImpl("/api/playground/keeper-cosign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, v1MessageBase64: toBase64(message) }),
  });
  const j = (await r.json().catch(() => ({}))) as { keeperSignatureBase64?: string; error?: string };
  if (!r.ok || typeof j.keeperSignatureBase64 !== "string") throw new Error(`co-sign ${r.status}: ${j.error ?? "no signature"}`);
  return fromBase64(j.keeperSignatureBase64);
}

export function liveSingleTxDeps(a: {
  connection: Connection;
  rawSigner: RawTxSigner;
  cosign: KeeperCosignRequestBase;
  slab: PublicKey;
  wrapperProgramId: PublicKey;
}): SingleTxLaunchDeps {
  const { connection } = a;
  return {
    simulate: (wire) => simulateV1(connection, wire),
    keeperSign: (message) => requestKeeperV1Signature(a.cosign, message),
    walletSign: async (wire) => {
      const [signed] = await a.rawSigner.signRaw([wire]);
      if (!signed) throw new Error("the wallet returned no signed transaction");
      return signed;
    },
    send: (wire) => sendV1(connection, wire, { preflightCommitment: "confirmed" }),
    status: async (sig): Promise<LaunchSigStatus> => {
      const s = (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (!s) return { kind: "not-found" };
      if (s.err) return { kind: "failed", err: s.err };
      return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? { kind: "confirmed" } : { kind: "pending" };
    },
    blockHeight: () => connection.getBlockHeight("confirmed"),
    slabExists: async () => {
      const info = await connection.getAccountInfo(a.slab, "confirmed");
      return !!info && info.owner.equals(a.wrapperProgramId);
    },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
  };
}
