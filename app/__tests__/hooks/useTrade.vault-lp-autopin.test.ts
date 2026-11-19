// @vitest-environment node
/**
 * P3 auto-pin (07a1d0eb, bytes regenerated on FINAL 4b1a5d30): a market bound by the APP's wizard (createAccount(ctx) + 94 + 96) trades
 * immediately. Fixture = the vault-LP portfolio bytes right after that app-built bind in the P3
 * LiteSVM sim (scripts/limits-parity/p3-sim, LIMITS_DUMP_VAULT_LP), where a trade through
 * exactly these accounts LANDED. The app's own trade-account resolution must produce the same
 * LP, matcher ctx and delegate (delegate seeds use the LP's owner = the registry PDA).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
// Static import: the useTrade module graph is huge and cold-transforming it (11-23s) inside the
// first test body blew the 10s test timeout. vi.mock calls are hoisted above this import.
import { resolveV17TradeAccounts } from "@/hooks/useTrade";

vi.mock("@/lib/config", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, getConfig: () => ({ ...(real.getConfig as () => Record<string, unknown>)(), matcherProgramId: "4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT" }) };
});

// The taker's own portfolio comes from the shared scan store (not under test here).
const takerPortfolio = Keypair.generate().publicKey;
let takerKey: PublicKey | null = null;
vi.mock("@/lib/userAccountScan", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, getPortfolioRawSnapshot: () => (takerKey ? { pubkey: takerPortfolio, portfolio: { owner: takerKey } } : null) };
});

const f = JSON.parse(readFileSync(join(__dirname, "../fixtures/limits/sim-vault-lp-4b1a5d30.json"), "utf8")) as {
  programId: string; market: string; registry: string; vaultLp: string; ctx: string; delegate: string; matcher: string; dataB64: string; headP3: string;
};

// Since 18526d86 the LP is chosen by ON-CHAIN IDENTITY (lib/market-lp.ts): the resolver
// reads the MARKET account (asset 0's P3 vault-LP binding) and the matcher CTX account
// (ctx.lp_pda must equal the derived delegate). The original version of this test served
// neither (getAccountInfo -> null), which the identity rule correctly treats as "no LP".
// The two accounts below are the minimal real shapes those reads need; the LP portfolio
// bytes stay the sim fixture, so the delegate the resolver derives must still equal the
// one the program accepted.
async function sdkP3() {
  return (await vi.importActual("@percolatorct/sdk")) as typeof import("@percolatorct/sdk");
}

async function boundMarketData(vaultLp: PublicKey): Promise<Buffer> {
  const sdk = await sdkP3();
  const off = sdk.assetVaultLpAccountOffsetP3(0);
  const d = Buffer.alloc(off + 128 + 64);
  d[10] = 1; // kind = market
  vaultLp.toBuffer().copy(d, off + sdk.ASSET_VAULT_LP_FIELD_OFF_P3.vaultLpPortfolio);
  d[off + sdk.ASSET_VAULT_LP_FIELD_OFF_P3.flags] = sdk.ASSET_VAULT_LP_FLAG_BOUND_P3;
  return d;
}

function boundCtxData(delegate: PublicKey): Buffer {
  const d = Buffer.alloc(320); // VAULT_LP_MATCHER_CTX_LEN_P3
  delegate.toBuffer().copy(d, 64 + 16); // 64-byte return slot, then vAMM ctx lp_pda at +16
  return d;
}

describe("trade resolution against an auto-pinned vault LP", () => {
  function connectionFor(marketData: Buffer, ctxData: Buffer) {
    const data = Buffer.from(f.dataB64, "base64");
    const program = new PublicKey(f.programId);
    return {
      getAccountInfo: vi.fn(async (pk: PublicKey) =>
        pk.equals(new PublicKey(f.market)) ? { data: marketData, owner: program } : null,
      ),
      getMultipleAccountsInfo: vi.fn(async (pks: PublicKey[]) =>
        pks.map((pk) => (pk.equals(new PublicKey(f.ctx)) ? { data: ctxData, owner: new PublicKey(f.matcher) } : null)),
      ),
      getProgramAccounts: vi.fn(async (_p: PublicKey, cfg: { filters: { memcmp: { offset: number; bytes: string } }[] }) => {
        const ownerFilter = cfg.filters.find((x) => x.memcmp && x.memcmp.offset === 80);
        if (ownerFilter) return [{ pubkey: takerPortfolio, account: { data: Buffer.alloc(9500), owner: program } }];
        return [{ pubkey: new PublicKey(f.vaultLp), account: { data, owner: program } }];
      }),
    };
  }

  it("finds the vault LP and derives the delegate the program accepted", async () => {
    const taker = Keypair.generate().publicKey;
    takerKey = taker;
    const data = Buffer.from(f.dataB64, "base64");
    const connection = connectionFor(await boundMarketData(new PublicKey(f.vaultLp)), boundCtxData(new PublicKey(f.delegate)));
    const r = await resolveV17TradeAccounts(connection as never, new PublicKey(f.programId), new PublicKey(f.market), taker);
    expect(f.headP3).toBe("4b1a5d30");
    expect(r.accountB.toBase58()).toBe(f.vaultLp);
    expect(r.matcherProg.toBase58()).toBe(f.matcher);
    expect(r.matcherCtx.toBase58()).toBe(f.ctx);
    expect(r.matcherDelegate.toBase58()).toBe(f.delegate);
    // the LP's recorded owner is the registry PDA (no creator key anywhere in the pin)
    expect(new PublicKey(data.subarray(80, 112)).toBase58()).toBe(f.registry);
  });

  it("refuses the vault LP when its ctx is not bound to the program-accepted delegate", async () => {
    const taker = Keypair.generate().publicKey;
    takerKey = taker;
    const connection = connectionFor(await boundMarketData(new PublicKey(f.vaultLp)), boundCtxData(Keypair.generate().publicKey));
    await expect(
      resolveV17TradeAccounts(connection as never, new PublicKey(f.programId), new PublicKey(f.market), taker),
    ).rejects.toThrow(/No LP portfolio/);
  });
});
