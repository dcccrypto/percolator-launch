/**
 * GH#2014 — Routine upgrade-authority monitor.
 *
 * Usage:
 *   npx tsx scripts/check-upgrade-authority.ts [--network mainnet|devnet] [--allow-eoa] [--json]
 */

import { Connection, PublicKey } from "@solana/web3.js";

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SQUADS_V4_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const MAINNET_EOA = "7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G";
const DEVNET_EOA = "FF7KFfU5Bb3Mze2AasDHCCZuyhdaSLjUZy2K3JvjdB7x";
const MAINNET_PROGRAM_ID = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";
const DEVNET_PROGRAM_ID = "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in";

type Network = "mainnet" | "devnet";

type Assessment = {
  programId: string;
  authority: string | null;
  authorityOwner: string | null;
  kind: string;
  safe: boolean;
  message: string;
};

const DEFAULT_RPC: Record<Network, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

function programDataAddress(programId: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE);
  return address;
}

function parseAuthority(data: Uint8Array): string | null {
  if (data.length < 45 || data[12] !== 1) return null;
  return new PublicKey(data.subarray(13, 45)).toBase58();
}

function assess(programId: string, authority: string | null, owner: string | null): Assessment {
  if (!authority) {
    return { programId, authority, authorityOwner: owner, kind: "immutable", safe: true, message: "Program is immutable (no upgrade authority)." };
  }
  if (owner === SQUADS_V4_PROGRAM_ID) {
    return { programId, authority, authorityOwner: owner, kind: "squads_multisig", safe: true, message: "Upgrade authority is a Squads vault (threshold-gated)." };
  }
  if (authority === MAINNET_EOA || authority === DEVNET_EOA) {
    return { programId, authority, authorityOwner: owner, kind: "known_eoa", safe: false, message: "CRITICAL: documented single EOA — transfer to Squads per docs/SQUADS-SETUP.md." };
  }
  if (owner === SYSTEM_PROGRAM_ID) {
    return { programId, authority, authorityOwner: owner, kind: "other_eoa", safe: false, message: "CRITICAL: single keypair authority — use Squads multisig." };
  }
  return { programId, authority, authorityOwner: owner, kind: "other_eoa", safe: false, message: "CRITICAL: upgrade authority is not a Squads vault." };
}

function parseArgs(): { network: Network; allowEoa: boolean; json: boolean } {
  const args = process.argv.slice(2);
  let network: Network = "mainnet";
  let allowEoa = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--network" && args[i + 1]) network = args[++i] as Network;
    else if (args[i] === "--allow-eoa") allowEoa = true;
    else if (args[i] === "--json") json = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx scripts/check-upgrade-authority.ts [--network mainnet|devnet] [--allow-eoa] [--json]");
      process.exit(0);
    }
  }
  if (network !== "mainnet" && network !== "devnet") {
    console.error("--network must be mainnet or devnet");
    process.exit(2);
  }
  return { network, allowEoa, json };
}

async function checkProgram(connection: Connection, programIdStr: string): Promise<Assessment> {
  const programData = await connection.getAccountInfo(programDataAddress(new PublicKey(programIdStr)));
  if (!programData?.data) {
    return { programId: programIdStr, authority: null, authorityOwner: null, kind: "missing_program_data", safe: false, message: "Could not read ProgramData account." };
  }
  const authority = parseAuthority(programData.data);
  if (!authority) return assess(programIdStr, null, null);
  const owner = (await connection.getAccountInfo(new PublicKey(authority)))?.owner.toBase58() ?? null;
  return assess(programIdStr, authority, owner);
}

async function main(): Promise<void> {
  const { network, allowEoa, json } = parseArgs();
  const programId = network === "mainnet" ? MAINNET_PROGRAM_ID : DEVNET_PROGRAM_ID;
  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC[network];
  const result = await checkProgram(new Connection(rpcUrl, "confirmed"), programId);

  if (json) console.log(JSON.stringify({ network, rpcUrl, ...result }, null, 2));
  else {
    console.log(`Network:   ${network}`);
    console.log(`Program:   ${result.programId}`);
    console.log(`Authority: ${result.authority ?? "(none — immutable)"}`);
    console.log(`Owner:     ${result.authorityOwner ?? "(n/a)"}`);
    console.log(`Kind:      ${result.kind}`);
    console.log(`Safe:      ${result.safe}`);
    console.log(`Message:   ${result.message}`);
  }

  if (!result.safe && !allowEoa) {
    console.error("\nFAILED — see docs/GH-2014-upgrade-authority-governance.md");
    process.exit(1);
  }
  if (!result.safe && allowEoa) console.warn("\nWARN: EOA authority (--allow-eoa).");
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
