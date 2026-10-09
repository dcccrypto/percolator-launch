// @vitest-environment node
/**
 * GET /api/earn-share/<market> (+ /image): the metadata the Earn share token's Metaplex `uri` points at (percolator-prog docs/v22-lp-share-mint.md;
 * security review R10). Built from chain state only; the path parameter is validated; v2.2 only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { deriveInsuranceLpMint, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, deriveLpShareMetadataPdaV22, lpShareIdentityV22 } from "@/lib/v22/sdk";
import { __clearEarnShareCacheForTest } from "@/lib/v22/earn-share-chain";

const h = vi.hoisted(() => ({
  getMultiple: vi.fn(),
  logoUrl: null as string | null,
}));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => ({ getMultipleAccountsInfo: h.getMultiple }) }));
vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { logo_url: h.logoUrl }, error: null }) }) }) }) }),
}));

import { GET, OPTIONS } from "@/app/api/earn-share/[market]/route";
import { GET as GET_IMAGE } from "@/app/api/earn-share/[market]/image/route";
import { getConfig } from "@/lib/config";

const PROGRAM = new PublicKey(getConfig().programId);
const market = Keypair.generate().publicKey;
const [registry] = deriveLpVaultRegistry(PROGRAM, market);
const [mint] = deriveInsuranceLpMint(PROGRAM, market);
const [meta] = deriveLpShareMetadataPdaV22(mint);
const M = market.toBase58();
const BASE = "https://play.percolator.trade";

const acct = (owner: PublicKey, data = Buffer.alloc(8)) => ({ owner, data, lamports: 1, executable: false });
function record(ua: PublicKey, m: PublicKey, name: string, symbol: string, mutable = false) {
  const s = (x: string, pad: number) => Buffer.concat([Buffer.from(new Uint32Array([pad]).buffer), Buffer.from(x, "latin1"), Buffer.alloc(pad - Buffer.byteLength(x, "latin1"))]);
  return Buffer.concat([Buffer.from([4]), ua.toBuffer(), m.toBuffer(), s(name, 32), s(symbol, 10), s(`${BASE}/api/earn-share/${M}`, 200), Buffer.from([0, 0, 0, 0, mutable ? 1 : 0, 0])]);
}
const call = (raw: string) => GET(new NextRequest(`http://localhost/api/earn-share/${encodeURIComponent(raw)}`), { params: Promise.resolve({ market: raw }) });
const callImage = (raw: string) => GET_IMAGE(new NextRequest("http://localhost/x"), { params: Promise.resolve({ market: raw }) });
const chain = (reg: ReturnType<typeof acct> | null, rec: ReturnType<typeof acct> | null) => h.getMultiple.mockResolvedValue([reg, rec]);

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __clearEarnShareCacheForTest();
  h.getMultiple.mockReset();
  h.logoUrl = null;
});
afterEach(() => __setDevnetV22ForTest(null));

describe("parameter validation (404, never echoed, no chain read for garbage)", () => {
  const bad = [
    "", "abc", "../../etc/passwd", "<script>alert(1)</script>", "0".repeat(44), "O".repeat(44), "I".repeat(44), "l".repeat(44),
    "1".repeat(31), "1".repeat(33), // 31 / 33 zero bytes
    M + "1", // too long / non canonical
    "1" + M, // extra leading zero byte
    "%2e%2e%2f", "x".repeat(5000), "11111111111111111111111111111111" + "1", // 33 bytes of zeros
  ];
  for (const raw of bad) {
    it(`404 for ${JSON.stringify(raw.length > 40 ? raw.slice(0, 40) + "…" : raw)}`, async () => {
      chain(acct(PROGRAM), null);
      const res = await call(raw);
      expect(res.status).toBe(404);
      expect(h.getMultiple).not.toHaveBeenCalled();
      const text = await res.text();
      if (raw.length > 3) expect(text).not.toContain(raw);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  }
  it("a valid key whose registry PDA does not exist is 404", async () => {
    chain(null, null);
    expect((await call(M)).status).toBe(404);
  });
  it("a registry account owned by ANOTHER program is 404 (the parameter must be a market of this wrapper)", async () => {
    chain(acct(Keypair.generate().publicKey), null);
    expect((await call(M)).status).toBe(404);
  });
  it("the system program key (32 zero bytes, canonical) has no vault: 404", async () => {
    chain(null, null);
    expect((await call("11111111111111111111111111111111")).status).toBe(404);
  });
  it("flag OFF: the route does not exist (404, no chain read)", async () => {
    __setDevnetV22ForTest(false);
    chain(acct(PROGRAM), null);
    expect((await call(M)).status).toBe(404);
    expect((await callImage(M)).status).toBe(404);
    expect(h.getMultiple).not.toHaveBeenCalled();
  });
});

describe("the JSON", () => {
  it("never-named vault: the generic form, from chain state only", async () => {
    chain(acct(PROGRAM), null);
    const res = await call(M);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    expect(res.headers.get("set-cookie")).toBeNull();
    const j = await res.json();
    expect(j).toEqual({
      name: `Percolator Earn Share ${M.slice(0, 8)}`,
      symbol: "pEARN",
      description: `Share of the Earn vault of a market on Percolator (market ${M.slice(0, 8)}...). The market creator has not named this share.`,
      image: `${BASE}/api/earn-share/${M}/image`,
      external_url: `${BASE}/earn/${M}`,
      properties: { category: "image", files: [{ uri: `${BASE}/api/earn-share/${M}/image`, type: "image/png" }] },
    });
    // the reads: the registry and the Metaplex record of the share mint, nothing else
    expect(h.getMultiple).toHaveBeenCalledWith([registry, meta]);
  });
  it("a record OURS (update authority = the registry PDA, mint = the share mint): name and symbol come from it; the document's example", async () => {
    const id = lpShareIdentityV22(market, "BURNIE");
    chain(acct(PROGRAM), acct(METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, record(registry, mint, id.name, id.symbol)));
    const j = await (await call(M)).json();
    expect(j.name).toBe(`Percolator Earn BURNIE ${M.slice(0, 6)}`);
    expect(j.symbol).toBe("peBURNIE");
    expect(j.description).toBe(`Share of the Earn vault of the BURNIE market on Percolator (market ${M.slice(0, 8)}...). The ticker is set by the market creator and is not verified by Percolator.`);
  });
  it("an ours-but-generic record (mutable, pEARN) keeps its generic name", async () => {
    const id = lpShareIdentityV22(market, "");
    chain(acct(PROGRAM), acct(METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, record(registry, mint, id.name, id.symbol, true)));
    const j = await (await call(M)).json();
    expect(j.symbol).toBe("pEARN");
    expect(j.name).toBe(id.name);
  });
  describe("NEGATIVE CONTROLS: text that is not the wrapper's record is never served", () => {
    const evil = (data: Buffer, owner = METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22) => chain(acct(PROGRAM), acct(owner, data));
    const generic = { name: `Percolator Earn Share ${M.slice(0, 8)}`, symbol: "pEARN" };
    it("another update authority", async () => {
      // framing the program really uses, so ONLY the authority check can reject it
      evil(record(Keypair.generate().publicKey, mint, `Percolator Earn EVIL ${M.slice(0, 6)}`, "peEVIL"));
      expect(await (await call(M)).json()).toMatchObject(generic);
    });
    it("another mint", async () => {
      evil(record(registry, Keypair.generate().publicKey, `Percolator Earn EVIL ${M.slice(0, 6)}`, "peEVIL"));
      expect(await (await call(M)).json()).toMatchObject(generic);
    });
    it("a record owned by another program", async () => {
      evil(record(registry, mint, "Percolator Earn EVIL 4vJ9JU", "peEVIL"), Keypair.generate().publicKey);
      expect(await (await call(M)).json()).toMatchObject(generic);
    });
    it("unparseable bytes", async () => {
      evil(Buffer.from([4, 1, 2, 3]));
      expect(await (await call(M)).json()).toMatchObject(generic);
    });
    it("ours, but text the program could not have written: markup, control characters, wrong framing, wrong symbol", async () => {
      for (const [n, s] of [
        ["<img src=x onerror=alert(1)>", "peABC"],
        ["Percolator Earn ABC \u0007\u0007", "peABC"],
        ["Free Money Airdrop", "peABC"],
        ["Percolator Earn ABC 4vJ9JU", "FREE"],
        ["Percolator Earn ABC 4vJ9JU", "peabc"],
        ["Percolator Earn ABC 4vJ9JU", "pe"],
        ["", "peABC"],
      ] as const) {
        evil(record(registry, mint, n, s));
        const j = await (await call(M)).json();
        expect(j, `${n}/${s}`).toMatchObject(generic);
        __clearEarnShareCacheForTest();
      }
    });
    it("the response is the same shape whatever the record says (no field is passed through)", async () => {
      evil(record(registry, mint, "Percolator Earn ABC 4vJ9JU", "peABC"));
      const j = await (await call(M)).json();
      expect(Object.keys(j).sort()).toEqual(["description", "external_url", "image", "name", "properties", "symbol"]);
    });
  });
  it("an RPC failure is 503 and not cached; a later success is served", async () => {
    h.getMultiple.mockRejectedValueOnce(new Error("429"));
    const bad = await call(M);
    expect(bad.status).toBe(503);
    expect(bad.headers.get("cache-control")).toBe("no-store");
    chain(acct(PROGRAM), null);
    expect((await call(M)).status).toBe(200);
  });
  it("chain reads are memoised (60 s) per market", async () => {
    chain(acct(PROGRAM), null);
    await call(M);
    await call(M);
    expect(h.getMultiple).toHaveBeenCalledTimes(1);
  });
  it("OPTIONS answers CORS preflight", () => {
    const r = OPTIONS();
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("the image", () => {
  const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const dims = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
  it("a square 512 x 512 PNG from this origin (no logo: the Percolator mark alone), cacheable, CORS *", async () => {
    chain(acct(PROGRAM), null);
    const res = await callImage(M);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toMatch(/public, max-age=3600/);
    expect(res.headers.get("location")).toBeNull();
    const buf = Buffer.from(await res.arrayBuffer());
    expect(isPng(buf)).toBe(true);
    expect(dims(buf)).toEqual({ w: 512, h: 512 });
  }, 30_000);
  describe("with a creator-supplied logo (re-encoded here, never redirected to)", () => {
    const PNG16 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM4oaFBEmIY1TCqYfhqAAB8MxgQ+Pjr0gAAAABJRU5ErkJggg==", "base64");
    const render = async () => Buffer.from(await (await callImage(M)).arrayBuffer());
    afterEach(() => vi.unstubAllGlobals());
    it("an allowlisted logo is fetched with redirects refused and drawn into the same 512 x 512 PNG; a disallowed host is never contacted", async () => {
      chain(acct(PROGRAM), null);
      const none = await render();
      __clearEarnShareCacheForTest();
      chain(acct(PROGRAM), null);
      const f = vi.fn(async () => new Response(new Uint8Array(PNG16), { status: 200 }));
      vi.stubGlobal("fetch", f);
      h.logoUrl = "https://assets.coingecko.com/coins/images/1/large/x.png";
      const withLogo = await render();
      expect(f).toHaveBeenCalledTimes(1);
      expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("error");
      expect(withLogo.readUInt32BE(16)).toBe(512);
      expect(withLogo.readUInt32BE(20)).toBe(512);
      expect(withLogo.equals(none)).toBe(false); // the logo changed the picture
      // the same market with a logo on a host that is not allowed: no request, the mark-only picture
      f.mockClear();
      h.logoUrl = "https://evil.example/x.png";
      const evil = await render();
      expect(f).not.toHaveBeenCalled();
      expect(evil.equals(none)).toBe(true);
    }, 60_000);
    it("a logo fetch that fails is not an error: the mark alone", async () => {
      chain(acct(PROGRAM), null);
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
      h.logoUrl = "https://assets.coingecko.com/x.png";
      const res = await callImage(M);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    }, 30_000);
  });
  it("invalid parameter / no vault: 404", async () => {
    expect((await callImage("nope")).status).toBe(404);
    chain(null, null);
    expect((await callImage(M)).status).toBe(404);
  });
});
