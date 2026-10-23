import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { fetchKeeperCosignPubkey } from "@/lib/keeper-cosign-pubkey";

function jsonResponse(ok: boolean, body: unknown): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("fetchKeeperCosignPubkey", () => {
  it("returns the keeper pubkey the backend reports", async () => {
    const keeper = Keypair.generate().publicKey;
    const got = await fetchKeeperCosignPubkey(jsonResponse(true, { keeperPubkey: keeper.toBase58() }));
    expect(got?.toBase58()).toBe(keeper.toBase58());
  });

  it("is null on a non-OK answer (403 non-devnet, 503 keeper not configured)", async () => {
    expect(await fetchKeeperCosignPubkey(jsonResponse(false, { error: "Keeper not configured" }))).toBeNull();
  });

  it("is null when the body carries no usable pubkey", async () => {
    expect(await fetchKeeperCosignPubkey(jsonResponse(true, {}))).toBeNull();
    expect(await fetchKeeperCosignPubkey(jsonResponse(true, { keeperPubkey: 42 }))).toBeNull();
  });

  it("is null, not a rejection, when the pubkey is not valid base58", async () => {
    expect(await fetchKeeperCosignPubkey(jsonResponse(true, { keeperPubkey: "not-a-key" }))).toBeNull();
  });

  it("is null, not a rejection, when the request itself throws", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchKeeperCosignPubkey(throwing)).toBeNull();
  });
});
