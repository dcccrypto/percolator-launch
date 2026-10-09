// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { IX_TAG, deriveLpBackingLedger } from "@percolatorct/sdk";
import {
  buildEarnVaultSeedInstructions,
  EARN_VAULT_BUCKET_NOT_EMPTY_MESSAGE,
  LP_VAULT_BACKING_BUCKET_NOT_EMPTY_CODE,
} from "@/lib/earn-vault-seed";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

// This file pins the v2.1 step list; the v2.2 list (tag 74 with account [6], then 122) is pinned in __tests__/lib/v22/create-lp-vault-and-naming.test.ts.
beforeEach(() => __setDevnetV22ForTest(false));
afterEach(() => __setDevnetV22ForTest(null));

const k = () => Keypair.generate().publicKey;
const args = () => ({
  programId: k(), wallet: k(), market: k(), registry: k(), lpMint: k(), userAta: k(), vaultAta: k(),
  seedPerDomain: 1_000_000_000n, includeCreate: true,
});
const u128 = (d: Uint8Array, o: number) => {
  const dv = new DataView(d.buffer, d.byteOffset);
  return (dv.getBigUint64(o + 8, true) << 64n) | dv.getBigUint64(o, true);
};

describe("earn vault seed step list (bug C-1)", () => {
  it("is CreateLpVault, ATA, DepositToLpVault(d0), DepositToLpVault(d1) — no direct TopUpBackingBucket", () => {
    const a = args();
    const ixs = buildEarnVaultSeedInstructions(a);
    expect(ixs.length).toBe(4);
    expect(ixs[0].data[0]).toBe(IX_TAG.CreateLpVault); // 74
    expect(ixs[1].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[2].data[0]).toBe(IX_TAG.DepositToLpVault); // 75
    expect(ixs[3].data[0]).toBe(IX_TAG.DepositToLpVault);
    for (const ix of ixs) {
      if (ix.programId.equals(a.programId)) expect(ix.data[0]).not.toBe(IX_TAG.TopUpBackingBucket);
    }
    // CreateLpVault comes before any deposit (buckets must still be Empty).
    expect(ixs.findIndex((i) => i.data[0] === 74)).toBeLessThan(ixs.findIndex((i) => i.data[0] === 75));
  });

  it("deposits BOTH domains, each with the full per-domain seed", () => {
    const a = args();
    const [, , d0, d1] = buildEarnVaultSeedInstructions(a);
    // wrapper decode (v16_program.rs:6800-6803): tag(1) + amount u128 + domain u16
    for (const [ix, dom] of [[d0, 0], [d1, 1]] as const) {
      expect(ix.data.length).toBe(1 + 16 + 2);
      expect(u128(ix.data, 1)).toBe(a.seedPerDomain);
      expect(new DataView(ix.data.buffer, ix.data.byteOffset).getUint16(17, true)).toBe(dom);
    }
  });

  it("deposit accounts match handle_deposit_to_lp_vault order (ledger=domain0, sibling=domain1)", () => {
    const a = args();
    const [, ata, d0, d1] = buildEarnVaultSeedInstructions(a);
    const [l0] = deriveLpBackingLedger(a.programId, a.market, 0);
    const [l1] = deriveLpBackingLedger(a.programId, a.market, 1);
    for (const ix of [d0, d1]) {
      const kk = ix.keys.map((x) => x.pubkey.toBase58());
      expect(kk[0]).toBe(a.wallet.toBase58());      // depositor (signer)
      expect(ix.keys[0].isSigner).toBe(true);
      expect(kk[1]).toBe(a.market.toBase58());
      expect(kk[2]).toBe(a.registry.toBase58());
      expect(kk[3]).toBe(a.lpMint.toBase58());
      expect(kk[4]).toBe(ata.keys[1].pubkey.toBase58()); // depositor LP ATA
      expect(kk[5]).toBe(a.userAta.toBase58());     // creator funds both deposits
      expect(kk[6]).toBe(a.vaultAta.toBase58());
      expect(kk[7]).toBe(l0.toBase58());
      expect(kk[10]).toBe(l1.toBase58());
      expect(ix.keys.length).toBe(11);
    }
  });

  it("resume variant (registry exists) omits CreateLpVault but keeps both deposits", () => {
    const ixs = buildEarnVaultSeedInstructions({ ...args(), includeCreate: false });
    expect(ixs.map((i) => i.data[0] === 74)).not.toContain(true);
    expect(ixs.filter((i) => i.data[0] === 75).length).toBe(2);
  });

  it("CreateLpVault bytes match the wrapper decode (domain 0, unchanged vault params)", () => {
    const [c] = buildEarnVaultSeedInstructions(args());
    const dv = new DataView(c.data.buffer, c.data.byteOffset);
    // v16_program.rs:6794-6799: fee_share u16, cooldown u64, oi_res u16, domain u16
    expect(dv.getUint16(1, true)).toBe(1000);
    expect(dv.getBigUint64(3, true)).toBe(150n); // C-1: relaunch floor (was 5)
    expect(dv.getUint16(11, true)).toBe(8000);
    expect(dv.getUint16(13, true)).toBe(0);
  });

  it("rejects a zero seed", () => {
    expect(() => buildEarnVaultSeedInstructions({ ...args(), seedPerDomain: 0n })).toThrow();
  });
});

describe("old-flow market: Custom(63) at the Earn-vault step is explained, not retried blindly", () => {
  it("code is 63 and the step-aware message says retrying cannot fix it", () => {
    expect(LP_VAULT_BACKING_BUCKET_NOT_EMPTY_CODE).toBe(63);
    const logs = "Program X invoke [1]\nProgram X failed: custom program error: 0x3f";
    const m = parseMarketCreationError(new Error(logs), { step: "earn-vault", stepLabel: "Creating the Earn vault" });
    expect(m).toContain(EARN_VAULT_BUCKET_NOT_EMPTY_MESSAGE);
    expect(m).toMatch(/Retrying cannot fix/);
    // same code at a different step keeps its generic handling
    const other = parseMarketCreationError(new Error(logs), { step: "funding", stepLabel: "Funding liquidity" });
    expect(other).not.toContain("Retrying cannot fix");
  });
});

describe("wizard wiring (code-level control)", () => {
  const root = path.resolve(__dirname, "../..");
  const src = readFileSync(path.join(root, "hooks/useCreateMarket.ts"), "utf8");
  it("M3a funds nothing but the LP deposit; M4a carries the vault + both deposits", () => {
    expect(src).toMatch(/instructions: \[depositIx\],\s*\n\s*computeUnits: \d[\d_]*,\s*\n\s*signers: \[\],\s*\n\s*\};\s*\n\s*\n\s*\/\/ M3b/);
    expect(src).toMatch(/label: WIZARD_STEP_COPY\.earnVault,\s*\n\s*instructions: earnVaultIxs/);
    expect(src).not.toMatch(/TopUpBackingBucket\(|encodeTopUpBackingBucket/);
  });
  it("sequential Step 4 seeds via the helper and tells old-flow markets apart", () => {
    expect(src).toContain("LP_VAULT_BACKING_BUCKET_NOT_EMPTY_CODE");
    expect(src.match(/buildEarnVaultSeedInstructions\(/g)?.length).toBe(2);
  });
});
