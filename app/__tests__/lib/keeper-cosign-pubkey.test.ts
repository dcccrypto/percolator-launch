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

  it("gives up on a stalled request instead of holding the launch open", async () => {
    // A server that accepts the connection and never answers. Unbounded, the
    // awaited call would block step 1 forever (CodeRabbit, PR #3662).
    const stalling = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as unknown as typeof fetch;
    expect(await fetchKeeperCosignPubkey(stalling, 10)).toBeNull();
  });

  it("passes an abort signal so the request is bounded", async () => {
    let seen: RequestInit | undefined;
    const capture = ((_url: string, init?: RequestInit) => {
      seen = init;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as unknown as typeof fetch;
    await fetchKeeperCosignPubkey(capture);
    expect(seen?.signal).toBeDefined();
  });

  it("stays bounded when AbortSignal.timeout is unavailable (older runtimes)", async () => {
    // Returning no signal here would leave the request unbounded again — the
    // exact failure the timeout was added for (CodeRabbit, PR #3662).
    const original = AbortSignal.timeout;
    // @ts-expect-error — simulating a runtime without AbortSignal.timeout
    delete (AbortSignal as unknown as { timeout?: unknown }).timeout;
    try {
      const stalling = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        })) as unknown as typeof fetch;
      expect(await fetchKeeperCosignPubkey(stalling, 10)).toBeNull();
    } finally {
      (AbortSignal as unknown as { timeout: unknown }).timeout = original;
    }
  });

  it("is null, not a rejection, when the request itself throws", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchKeeperCosignPubkey(throwing)).toBeNull();
  });
});
