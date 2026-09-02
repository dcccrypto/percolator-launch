import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #2520 — every pre-existing check on this route was SHAPE-only (valid pubkey,
// printable name, ticker charset, decimals range). A syntactically valid pubkey
// for an account that was never created still landed in `devnet_mints`.
describe("#2520 devnet-register-mint verifies the mint on-chain", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../app/api/devnet-register-mint/route.ts"),
    "utf8",
  );

  it("fetches the account before upserting", () => {
    expect(src).toMatch(/getAccountInfo\(new PublicKey\(mintAddress\)\)/);
  });

  it("rejects a nonexistent account", () => {
    expect(src).toMatch(/does not exist on devnet/);
  });

  it("requires the token program as owner AND the exact SPL mint length", () => {
    expect(src).toMatch(/owner\.equals\(TOKEN_PROGRAM_ID\)/);
    expect(src).toMatch(/SPL_MINT_LEN\s*=\s*82/);
    expect(src).toMatch(/data\.length\s*!==\s*SPL_MINT_LEN/);
  });

  it("fails CLOSED on an RPC error rather than falling through to the upsert", () => {
    // an advisory check that skips on error would leave the issue half-closed
    const catchBlock = src.slice(src.indexOf("mint existence check failed"));
    expect(catchBlock).toMatch(/status:\s*503/);
    expect(catchBlock).toMatch(/return NextResponse\.json/);
  });

  it("runs BEFORE the DB upsert", () => {
    expect(src.indexOf("getAccountInfo")).toBeLessThan(src.indexOf('from("devnet_mints")'));
  });
});
