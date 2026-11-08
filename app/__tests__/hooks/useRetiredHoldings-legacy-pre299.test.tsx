/**
 * R2-1 (Council 2026-11-07 round 2), mounted: the Portfolio page's "funds left in settled / retired markets" section
 * (useRetiredHoldings) on a build configured for the OLD v2.2 wrapper 6kpg2wi7 lists a holder's pre-#299 portfolio
 * (10,603 B, disc 19) with its capital, and asks the RPC for exactly that layout. On the fresh wrapper the same bytes are
 * not a holding (they cannot exist there; the scan asks for 10,607 B). Only the RPC, wallet, config and blocklist are mocked:
 * the hook, its filters, classifyRetiredHolding and parsePortfolio are the real code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_V22_PROGRAM_IDS, DEVNET_V22_FRESH_1106_PROGRAM_IDS } from "@/lib/program-ids";

const j = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/v22-growth/chillhouse-t.lp.json"), "utf8")) as { data: string };
const LEGACY = new Uint8Array(Buffer.from(j.data, "base64")); // recorded on 6kpg2wi7 before engine #299
const OWNER = new PublicKey(LEGACY.subarray(116, 148));
const SLAB = new PublicKey(LEGACY.subarray(16, 48)).toBase58();
const le128 = (b: Uint8Array, o: number) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]!); return v; };
const CAPITAL = le128(LEGACY, 148);
// The recorded market of that portfolio, with its engine mode set to Resolved (1) as R2-1's market was: group header @592, mode @+674.
const mj = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/v22-growth/chillhouse-t.market.json"), "utf8")) as { data: string };
const RESOLVED_MARKET = (() => { const b = new Uint8Array(Buffer.from(mj.data, "base64")).slice(0, 1400); b[592 + 674] = 1; return b; })();

const m = vi.hoisted(() => {
  const gpa = vi.fn();
  const gmai = vi.fn();
  // Referentially stable, like the real providers: the hook's effect depends on connection / publicKey identity.
  return { wrapper: "", gpa, gmai, conn: { connection: { getProgramAccounts: gpa, getMultipleAccountsInfo: gmai } }, wallet: { publicKey: null as unknown } };
});
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => m.conn, useWalletCompat: () => m.wallet }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getConfig: () => ({ programId: m.wrapper }) }));

import { useRetiredHoldings } from "@/hooks/useRetiredHoldings";

const configure = (w: string) => {
  m.wrapper = w;
  vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
  vi.stubEnv("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", w);
};
const dataSizes = () => (m.gpa.mock.calls[0]![1] as { filters: Array<{ dataSize?: number }> }).filters.filter((f) => f.dataSize !== undefined).map((f) => f.dataSize);

beforeEach(() => {
  __setDevnetV22ForTest(true);
  m.wallet.publicKey = OWNER;
  m.gpa.mockReset().mockResolvedValue([{ pubkey: new PublicKey("6eyAuA4QqEYkv65mHCtD8TyoJchoP2weDiF9ZoHS4mNh"), account: { data: Buffer.from(LEGACY) } }]);
  m.gmai.mockReset().mockResolvedValue([{ data: Buffer.from(RESOLVED_MARKET) }]);
});
afterEach(() => {
  __setDevnetV22ForTest(null);
  vi.unstubAllEnvs();
});

describe("useRetiredHoldings on the old wrapper 6kpg2wi7 (pre-#299 portfolios)", () => {
  it("scans for 10,603 B portfolios and lists the holder's capital", async () => {
    configure(DEVNET_V22_PROGRAM_IDS.wrapper);
    const { result } = renderHook(() => useRetiredHoldings());
    await waitFor(() => expect(result.current.holdings).toHaveLength(1));
    expect(dataSizes()).toEqual([10_603]);
    expect(result.current.holdings[0]!.slabAddress).toBe(SLAB);
    expect(result.current.holdings[0]!.capital).toBe(CAPITAL);
    expect(result.current.holdings[0]!.settled).toBe(true);
    expect(CAPITAL).toBeGreaterThan(0n);
  });
});

describe("useRetiredHoldings on the fresh wrapper 5NGgnU2j (unchanged)", () => {
  it("scans for 10,607 B portfolios; pre-#299 bytes are never read as a holding", async () => {
    configure(DEVNET_V22_FRESH_1106_PROGRAM_IDS.wrapper);
    const { result } = renderHook(() => useRetiredHoldings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(m.gpa).toHaveBeenCalledTimes(1);
    expect(dataSizes()).toEqual([10_607]);
    expect(result.current.holdings).toEqual([]);
  });
});
