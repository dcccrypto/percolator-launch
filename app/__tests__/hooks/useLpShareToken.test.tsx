// @vitest-environment jsdom
/** v2.2: what the chain says about a market's Earn share token (decimals + Metaplex record). Flag off: no request at all. */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MINT_SIZE, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

// PDA derivation does not run under this jsdom setup (noble's on-curve check mis-reads cross-realm arrays), so the derivations are
// replaced by fixed keys; the hook's logic (which accounts it reads, what it trusts) is what is under test.
const K = vi.hoisted(() => {
  const mk = (n: number) => new (require("@solana/web3.js").PublicKey)(new Uint8Array(32).fill(n));
  return { registry: mk(11), mint: mk(12), meta: mk(13), mpl: mk(14) };
});
vi.mock("@percolatorct/sdk", () => ({
  deriveLpVaultRegistry: () => [K.registry, 255],
  deriveInsuranceLpMint: () => [K.mint, 255],
}));
// spl-token's layout decoder does not run under this jsdom setup either (cross-realm Uint8Array); the stand-in reads the same byte it does (decimals at 44).
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  unpackMint: (_a: unknown, info: { data: Uint8Array }) => {
    if (info.data.length !== 82) throw new Error("bad mint");
    return { decimals: info.data[44] };
  },
}));
vi.mock("@/lib/v22/sdk", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/sdk")>()),
  deriveLpShareMetadataPdaV22: () => [K.meta, 255],
}));
const h = vi.hoisted(() => ({ conn: { getMultipleAccountsInfo: undefined as unknown as ReturnType<typeof import("vitest").vi.fn> } }));
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection: h.conn }) }));

import { useLpShareToken } from "@/hooks/useLpShareToken";
import { METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22 } from "@/lib/v22/sdk";

const program = Keypair.generate().publicKey, market = Keypair.generate().publicKey;
const { registry, mint, meta } = K;

function mintAccount(decimals: number) {
  const d = Buffer.alloc(MINT_SIZE);
  d.writeUInt32LE(1, 0); // mint authority option = Some
  registry.toBuffer().copy(d, 4);
  d.writeBigUInt64LE(1_000n, 36); // supply
  d[44] = decimals;
  d[45] = 1; // initialized
  return { owner: TOKEN_PROGRAM_ID, data: d, lamports: 1, executable: false };
}
function record(ua: PublicKey, m: PublicKey, name: string, symbol: string) {
  const s = (x: string, pad: number) => Buffer.concat([Buffer.from(new Uint32Array([pad]).buffer), Buffer.from(x), Buffer.alloc(pad - x.length)]);
  const data = Buffer.concat([Buffer.from([4]), ua.toBuffer(), m.toBuffer(), s(name, 32), s(symbol, 10), s("https://play.percolator.trade/api/earn-share/x", 200), Buffer.from([0, 0, 0, 0, 1, 0])]);
  return { owner: METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, data, lamports: 1, executable: false };
}

beforeEach(() => { h.conn.getMultipleAccountsInfo = vi.fn(); });
afterEach(() => __setDevnetV22ForTest(null));

describe("useLpShareToken", () => {
  it("flag OFF: nothing is read, nothing is known", async () => {
    __setDevnetV22ForTest(false);
    const { result } = renderHook(() => useLpShareToken(market, program));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.conn.getMultipleAccountsInfo).not.toHaveBeenCalled();
    expect(result.current).toEqual({ decimals: null, metadataPresent: null, name: null, symbol: null });
  });
  it("flag ON: decimals from the mint, name from OUR record (update authority = registry, mint = share mint)", async () => {
    __setDevnetV22ForTest(true);
    h.conn.getMultipleAccountsInfo.mockResolvedValue([mintAccount(6), record(registry, mint, "Percolator Earn BURNIE BeumQK", "peBURNIE")]);
    const { result } = renderHook(() => useLpShareToken(market, program));
    await waitFor(() => expect(result.current.decimals).toBe(6));
    expect(result.current).toEqual({ decimals: 6, metadataPresent: true, name: "Percolator Earn BURNIE BeumQK", symbol: "peBURNIE" });
    expect(h.conn.getMultipleAccountsInfo).toHaveBeenCalledWith([mint, meta]);
  });
  it("a 0-decimal mint from an earlier build with no record: decimals 0, metadata absent", async () => {
    __setDevnetV22ForTest(true);
    h.conn.getMultipleAccountsInfo.mockResolvedValue([mintAccount(0), null]);
    const { result } = renderHook(() => useLpShareToken(market, program));
    await waitFor(() => expect(result.current.decimals).toBe(0));
    expect(result.current.metadataPresent).toBe(false);
    expect(result.current.name).toBeNull();
  });
  it("NEGATIVE CONTROLS: a record that is not ours (other update authority, other mint, wrong owner, garbage) is not 'present' and its text is never used", async () => {
    __setDevnetV22ForTest(true);
    const other = Keypair.generate().publicKey;
    for (const rec of [
      record(other, mint, "Fake Name", "FAKE"),
      record(registry, other, "Fake Name", "FAKE"),
      { ...record(registry, mint, "Fake Name", "FAKE"), owner: Keypair.generate().publicKey },
      { owner: METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, data: Buffer.from([4, 1, 2, 3]), lamports: 1, executable: false },
    ]) {
      h.conn.getMultipleAccountsInfo.mockResolvedValue([mintAccount(6), rec]);
      const { result, unmount } = renderHook(() => useLpShareToken(market, program));
      await waitFor(() => expect(result.current.decimals).toBe(6));
      expect(result.current.metadataPresent).toBe(false);
      expect(result.current.name).toBeNull();
      unmount();
    }
  });
  it("no mint at all: everything unknown; an RPC failure is also unknown (never a guess)", async () => {
    __setDevnetV22ForTest(true);
    h.conn.getMultipleAccountsInfo.mockResolvedValue([null, null]);
    const a = renderHook(() => useLpShareToken(market, program));
    await new Promise((r) => setTimeout(r, 20));
    expect(a.result.current).toEqual({ decimals: null, metadataPresent: null, name: null, symbol: null });
    h.conn.getMultipleAccountsInfo.mockRejectedValue(new Error("429"));
    const b = renderHook(() => useLpShareToken(market, program));
    await new Promise((r) => setTimeout(r, 20));
    expect(b.result.current).toEqual({ decimals: null, metadataPresent: null, name: null, symbol: null });
  });
});
