/**
 * Is the NFT program at `nftProgramId` the S1-2 build (Position NFT layout v3)? Decides whether a legacy 199 B NFT is a
 * valid position (pre-S1-2) or a dead NFT the program rejects (S1-2). Both programs are upgraded in place, so the answer
 * comes from deployed state, never a hand-flipped code constant. Any ONE of these says "S1-2":
 *   1. the per-cluster config in lib/program-ids.ts (`nftS12Deploy().deployed`), flipped in the runbook step that records
 *      the upgrade;
 *   2. the runtime probe: the program's ProgramData `slot` is >= the configured `minDeploySlot` (when one is recorded);
 *   3. a v3 (239 B) NFT was observed on chain (`observedV3`): only the S1-2 build can have written one.
 * Fails safe toward "S1-2": a probe error never flips the answer back to pre-S1-2, and the answer is sticky once true.
 * Only the absence of all three keeps legacy visible.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { nftS12Deploy } from "@/lib/program-ids";

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const sticky = new Set<string>();
const probeCache = new Map<string, { at: number; slot: number | null }>();
const PROBE_TTL_MS = 60_000;

/** Clears the sticky/probe caches (tests only). */
export function resetNftIncarnationCache(): void {
  sticky.clear();
  probeCache.clear();
}

async function probeDeploySlot(connection: Pick<Connection, "getAccountInfo">, nftProgramId: PublicKey): Promise<number | null> {
  const key = nftProgramId.toBase58();
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.slot;
  let slot: number | null = null;
  try {
    const [programData] = PublicKey.findProgramAddressSync([nftProgramId.toBytes()], BPF_LOADER_UPGRADEABLE);
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority: Option<Pubkey> }: u32 tag (3) then slot u64 LE.
    const info = await connection.getAccountInfo(programData, { dataSlice: { offset: 0, length: 12 } });
    if (info && info.data.length >= 12) {
      const v = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
      if (v.getUint32(0, true) === 3) slot = Number(v.getBigUint64(4, true));
    }
  } catch {
    slot = null;
  }
  probeCache.set(key, { at: Date.now(), slot });
  return slot;
}

/**
 * @param connection    Solana connection (only getAccountInfo is used, and only when a minDeploySlot is configured).
 * @param nftProgramId  The NFT program id in use.
 * @param observedV3    True if the caller saw a 239 B NFT account for this program.
 * @returns true when legacy 199 B NFTs are dead (the S1-2 build is deployed).
 * @example
 * const legacyIsStale = await resolveNftLegacyIsStale(connection, PERCOLATOR_NFT_PROGRAM_ID, nfts.some((n) => n.data.length === 239));
 */
export async function resolveNftLegacyIsStale(
  connection: Pick<Connection, "getAccountInfo">,
  nftProgramId: PublicKey,
  observedV3 = false,
): Promise<boolean> {
  const key = nftProgramId.toBase58();
  if (sticky.has(key)) return true;
  const cfg = nftS12Deploy(key);
  let deployed = cfg.deployed || observedV3;
  if (!deployed && cfg.minDeploySlot !== null) {
    const slot = await probeDeploySlot(connection, nftProgramId);
    deployed = slot !== null && slot >= cfg.minDeploySlot;
  }
  if (deployed) sticky.add(key);
  return deployed;
}
