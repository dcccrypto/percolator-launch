// @vitest-environment node
/** sendUserBundle bypasses sendTx, so it applies the v2.2 market tails itself (flag on only; flag off: no RPC, same groups). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ACCOUNT_KIND, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, deriveBondTrancheV22 } from "@/lib/v22/sdk";
import { __setTailsClockForTest } from "@/lib/v22/market-tails";
import { sendUserBundle } from "@/lib/tx-v1/user-bundle";

const wrapper = new PublicKey(resolveDevnetProgramIds().wrapper);
const market = Keypair.generate().publicKey;
const k = () => Keypair.generate().publicKey;
const ix97 = () =>
  new TransactionInstruction({ programId: wrapper, keys: Array.from({ length: 12 }, (_, i) => ({ pubkey: i === 1 ? market : k(), isSigner: i === 0, isWritable: false })), data: Buffer.from([97, 1]) });

const trancheAcct = () => {
  const d = new Uint8Array(200);
  new DataView(d.buffer).setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  new DataView(d.buffer).setUint16(8, LAYOUT_V22.version, true);
  d[10] = ACCOUNT_KIND.BondTranche;
  return { owner: wrapper, data: d, lamports: 1, executable: false };
};

async function capture(flag: boolean) {
  __setDevnetV22ForTest(flag);
  __setTailsClockForTest(null);
  const getMultipleAccountsInfo = vi.fn(async () => [trancheAcct(), null]);
  let planned: readonly (readonly TransactionInstruction[])[] = [];
  const stop = new Error("stop after plan");
  await sendUserBundle({
    connection: { getMultipleAccountsInfo } as never,
    wallet: { publicKey: k() } as never,
    groups: [{ instructions: [ix97()], computeUnits: 200_000 }],
    mode: "off",
    deps: { getPriorityFee: async () => 0, clusterSupportsV1: async () => false } as never,
    onPlan: (plan) => {
      planned = plan.txs.map((t) => (t as unknown as { instructions: TransactionInstruction[] }).instructions ?? []);
      throw stop;
    },
  }).catch((e) => {
    if (e !== stop) throw e;
  });
  return { planned, getMultipleAccountsInfo };
}

afterEach(() => __setDevnetV22ForTest(null));

describe("sendUserBundle applies the market tails", () => {
  it("flag on: the tranche is appended to tag 97 and exactly one RPC read is made", async () => {
    const { planned, getMultipleAccountsInfo } = await capture(true);
    const tranche = deriveBondTrancheV22(wrapper, market)[0];
    const flat = planned.flat();
    const found = flat.find((i) => i.data[0] === 97);
    expect(found?.keys).toHaveLength(13);
    expect(found!.keys[12].pubkey.equals(tranche)).toBe(true);
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });
  it("CONTROL flag off: untouched, no RPC", async () => {
    const { planned, getMultipleAccountsInfo } = await capture(false);
    expect(planned.flat().find((i) => i.data[0] === 97)?.keys).toHaveLength(12);
    expect(getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
});
