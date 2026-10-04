// @vitest-environment node
/** The registered-markets probe is bounded: it times out (=> unresolved, never hidden) and does not retry 429s. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

const h = vi.hoisted(() => ({ getServerConnection: vi.fn() }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet", programId: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB" }) }));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: h.getServerConnection }));

import { readSlabExistence, readLiveMarketStateResolutions, SLAB_PROBE_TIMEOUT_MS } from "@/lib/live-market-state";

afterEach(() => {
  vi.useRealTimers();
  h.getServerConnection.mockReset();
});

const key = () => Keypair.generate().publicKey.toBase58();

describe("readSlabExistence bounds", () => {
  it("a hung RPC times out into unresolved (nothing hidden) instead of hanging", async () => {
    vi.useFakeTimers();
    const slabs = [key(), key()];
    const c = { getMultipleAccountsInfo: vi.fn(() => new Promise(() => {})) } as unknown as Connection;
    const p = readSlabExistence(slabs, c);
    await vi.advanceTimersByTimeAsync(SLAB_PROBE_TIMEOUT_MS + 1);
    const r = await p;
    expect(r.missing.size).toBe(0);
    expect(r.unresolved.size).toBe(2);
  });

  it("NEGATIVE CONTROL: a reply inside the budget is used normally", async () => {
    vi.useFakeTimers();
    const slabs = [key(), key()];
    const c = { getMultipleAccountsInfo: vi.fn(async () => [{ data: Buffer.alloc(1) }, null]) } as unknown as Connection;
    const r = await readSlabExistence(slabs, c);
    expect([...r.missing]).toEqual([slabs[1]]);
  });

  it("builds its own connection with 429 retry disabled (probe only)", async () => {
    h.getServerConnection.mockReturnValue({ getMultipleAccountsInfo: async () => [] });
    await readSlabExistence([key()]);
    expect(h.getServerConnection).toHaveBeenCalledWith("confirmed", { disableRetryOnRateLimit: true });
  });

  it("the full-read path keeps the default connection (global behaviour unchanged)", async () => {
    h.getServerConnection.mockReturnValue({ getMultipleAccountsInfo: async () => [] });
    await readLiveMarketStateResolutions([key()]);
    expect(h.getServerConnection).toHaveBeenCalledWith("confirmed", {});
  });
});
