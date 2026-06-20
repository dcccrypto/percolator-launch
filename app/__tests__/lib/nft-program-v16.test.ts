// @vitest-environment node

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  deriveNftMint,
  deriveNftPda,
  parsePositionNftAccount,
  PERCOLATOR_NFT_PROGRAM_ID,
  POSITION_NFT_STATE_LEN,
} from "../../lib/nft-program";

const POSITION_NFT_MAGIC = 0x5045_5243_4e46_5400n;

function u16Le(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function writeI128(view: DataView, offset: number, value: bigint) {
  const unsigned = value < 0n ? (1n << 128n) + value : value;
  view.setBigUint64(offset, unsigned & 0xffff_ffff_ffff_ffffn, true);
  view.setBigUint64(offset + 8, unsigned >> 64n, true);
}

describe("percolator-nft v16 helpers", () => {
  it("derives PositionNft PDA from portfolio account and asset index", () => {
    const portfolio = new PublicKey("11111111111111111111111111111111");
    const staleSlab = new PublicKey("So11111111111111111111111111111111111111112");
    const assetIndex = 7;

    const [actual] = deriveNftPda(portfolio, assetIndex);
    const [expected] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("position_nft"), portfolio.toBytes(), u16Le(assetIndex)],
      PERCOLATOR_NFT_PROGRAM_ID
    );
    const [staleLaunchPda] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("position_nft"), staleSlab.toBytes(), u16Le(assetIndex)],
      PERCOLATOR_NFT_PROGRAM_ID
    );

    expect(actual.equals(expected)).toBe(true);
    expect(actual.equals(staleLaunchPda)).toBe(false);
  });

  it("parses the 199-byte PositionNftV16 layout", () => {
    const portfolio = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const data = new Uint8Array(POSITION_NFT_STATE_LEN);
    const view = new DataView(data.buffer);

    view.setBigUint64(0, POSITION_NFT_MAGIC, true);
    data[8] = 2;
    data[9] = 201;
    data.set(portfolio.toBytes(), 10);
    data.set(mint.toBytes(), 42);
    view.setUint32(74, 7, true);
    data[78] = 1;
    writeI128(view, 79, -123n);
    writeI128(view, 95, 456n);
    view.setBigUint64(111, 987n, true);
    view.setBigUint64(119, 654n, true);
    data.set(owner.toBytes(), 127);
    view.setBigInt64(159, 1_710_000_000n, true);

    const parsed = parsePositionNftAccount(data);

    expect(parsed.version).toBe(2);
    expect(parsed.bump).toBe(201);
    expect(parsed.portfolioAccount.equals(portfolio)).toBe(true);
    expect(parsed.mint.equals(mint)).toBe(true);
    expect(parsed.assetIndex).toBe(7);
    expect(parsed.sideAtMint).toBe(1);
    expect(parsed.basisPosQAtMint).toBe(-123n);
    expect(parsed.positionSize).toBe(123n);
    expect(parsed.fSnapAtMint).toBe(456n);
    expect(parsed.marketIdAtMint).toBe(987n);
    expect(parsed.epochSnapAtMint).toBe(654n);
    expect(parsed.positionOwner.equals(owner)).toBe(true);
    expect(parsed.mintedAt).toBe(1_710_000_000n);
  });

  it("rejects stale lengths and stale mint PDA derivation", () => {
    expect(POSITION_NFT_STATE_LEN).toBe(199);
    expect(() => parsePositionNftAccount(new Uint8Array(198))).toThrow(/too small/i);
    expect(() => deriveNftMint(Keypair.generate().publicKey, 0)).toThrow(/fresh signer/i);
  });
});
