// @vitest-environment node
/**
 * Cutover to the v2.2 11-06 fresh-address set:
 *  - DEVNET_PROGRAM_IDS == the four current IDs; canonical vault-LP matcher matches;
 *  - published @percolatorct/sdk@8.0.0 still defaults to an older devnet set (companion SDK PR);
 *  - no source file outside tests/fixtures still names a GnwdeQr-era id as a program to call;
 *  - 90 VaultLpBindRequiresFlatAsset has plain copy in every map.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProgramId, PROGRAM_IDS } from "@percolatorct/sdk";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET, P3_ERR } from "@/lib/limits/constants";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { P3_ERROR_COPY_BY_NAME } from "@/lib/limits/copy";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { parseMarketCreationError } from "@/lib/parseMarketError";

const FRESH = {
  wrapper: "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe",
  stake: "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE",
  nft: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs",
  matcher: "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam",
};
const ABANDONED = [
  "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ",
  "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3",
  "CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3",
  "4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT",
];

describe("relaunch program IDs", () => {
  it("the app's single source is the four fresh IDs", () => {
    expect({ ...DEVNET_PROGRAM_IDS }).toEqual(FRESH);
    expect(CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET).toBe(FRESH.matcher);
  });
  it("published @percolatorct/sdk@8.0.0 still pins an older devnet default (companion SDK PR)", () => {
    const sdk = PROGRAM_IDS as unknown as { devnet: Record<string, string> };
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "node_modules/@percolatorct/sdk/package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe("8.0.0");
    // Until the companion percolator-sdk PR is published, launch pins are authoritative.
    expect(sdk.devnet.percolator).not.toBe(FRESH.wrapper);
    expect(getProgramId("devnet").toBase58()).not.toBe(FRESH.wrapper);
  });
  it("the relaunch wrapper (rustc oracle on 5544302a) pins the relaunch matcher", () => {
    const fx = JSON.parse(readFileSync(join(process.cwd(), "__tests__/fixtures/limits/rust-p3-final.json"), "utf8")) as { p3Sha: string; layout: Record<string, number> };
    expect(fx.p3Sha.startsWith("5544302a")).toBe(true);
    expect(fx.layout.canonicalMatcherIsDevnetEDKK).toBe(1);
  });
  it("no app source names an abandoned program id (lib/program-ids.ts may, in its history note)", () => {
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (e === "node_modules" || e === "__tests__" || e === ".next" || e === "vendor") continue;
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx|mjs|js)$/.test(e)) out.push(p);
      }
      return out;
    };
    const files = ["lib", "hooks", "components", "app", "scripts"].flatMap((d) => walk(join(process.cwd(), d)));
    expect(files.length).toBeGreaterThan(500);
    const hits = files
      .filter((f) => !f.endsWith("lib/program-ids.ts"))
      .flatMap((f) => ABANDONED.filter((id) => readFileSync(f, "utf8").includes(id)).map((id) => `${f.replace(process.cwd() + "/", "")}: ${id}`));
    expect(hits).toEqual([]);
  });
});

describe("error 90 VaultLpBindRequiresFlatAsset", () => {
  it("is generated at 90 and has plain copy in every map", () => {
    expect(WRAPPER_ERR.VaultLpBindRequiresFlatAsset).toBe(90);
    expect(P3_ERR.VaultLpBindRequiresFlatAsset).toBe(90);
    expect(P3_ERROR_COPY_BY_NAME.VaultLpBindRequiresFlatAsset).toMatch(/already has open positions/);
    const err = new Error(`Transaction simulation failed: {"InstructionError":[3,{"Custom":90}]}\nProgram ${FRESH.wrapper} failed: custom program error: 0x5a`);
    const m = resolveUserMessage(err, { surface: "create" });
    expect(m.kind).toBe("setup-not-allowed");
    expect(m.body).toMatch(/already has open positions/);
    expect(parseMarketCreationError(err, { step: "vault-lp" })).toMatch(/before any trade/);
  });
});
