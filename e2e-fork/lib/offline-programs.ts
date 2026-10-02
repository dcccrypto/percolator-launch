/**
 * OFFLINE install: create an upgradeable-loader program (program + programdata
 * accounts) directly with surfnet_setAccount — no deploy tx, no program keypair.
 */
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { rpc, BPF_UPGRADEABLE, programDataAddress } from "./chain.ts";

export async function putProgram(url: string, programId: PublicKey, elf: Buffer, authority: PublicKey, allocLen = elf.length): Promise<void> {
  const pd = programDataAddress(programId);
  const prog = Buffer.alloc(36); prog.writeUInt32LE(2, 0); pd.toBuffer().copy(prog, 4);
  const pdData = Buffer.alloc(45 + allocLen); pdData.writeUInt32LE(3, 0); pdData.writeBigUInt64LE(0n, 4); pdData[12] = 1; authority.toBuffer().copy(pdData, 13); elf.copy(pdData, 45);
  await rpc(url, "surfnet_setAccount", [pd.toBase58(), { lamports: 100 * LAMPORTS_PER_SOL, data: pdData.toString("hex"), owner: BPF_UPGRADEABLE.toBase58(), executable: false }]);
  await rpc(url, "surfnet_setAccount", [programId.toBase58(), { lamports: LAMPORTS_PER_SOL, data: prog.toString("hex"), owner: BPF_UPGRADEABLE.toBase58(), executable: true }]);
}
