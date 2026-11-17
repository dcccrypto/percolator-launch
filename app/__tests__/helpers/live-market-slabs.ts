import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

const FX = path.join(__dirname, "..", "fixtures");
const KEY = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr");

/** Three captured v2.2 market slabs (single-asset SOL, multi-asset, chillhouse growth market). */
export function liveMarketFixtures(): Array<{ name: string; key: PublicKey; data: Uint8Array }> {
  const rd = (f: string) => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8")) as Record<string, string>;
  const a = rd("v22-market-single-asset-SOL.json");
  const b = rd("v22-market-multi-asset-2xhs.json");
  const c = rd("v22-growth/chillhouse-t.market.json");
  const u8 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
  return [
    { name: "single-asset", key: new PublicKey(a.market), data: u8(a.dataBase64) },
    { name: "multi-asset", key: new PublicKey(b.market), data: u8(b.dataBase64) },
    { name: "chillhouse", key: KEY, data: u8(c.data) },
  ];
}
