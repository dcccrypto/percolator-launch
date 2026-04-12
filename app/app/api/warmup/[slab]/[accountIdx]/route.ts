import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseAccount, parseEngine, parseParams } from "@percolatorct/sdk";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string; accountIdx: string }> }
) {
  const { slab, accountIdx: accountIdxStr } = await params;

  let slabPk: PublicKey;
  try {
    slabPk = new PublicKey(slab);
  } catch {
    return NextResponse.json({ error: "Invalid slab address" }, { status: 400 });
  }

  const accountIdx = parseInt(accountIdxStr, 10);
  if (isNaN(accountIdx) || accountIdx < 0) {
    return NextResponse.json({ error: "Invalid account index" }, { status: 400 });
  }

  try {
    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");
    const data = await fetchSlab(connection, slabPk);
    const engine = parseEngine(data);
    const riskParams = parseParams(data);

    // Check if account index is valid
    if (accountIdx >= engine.numUsedAccounts) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const account = parseAccount(data, accountIdx);

    // If warmup hasn't started (slot 0), no active warmup
    if (account.warmupStartedAtSlot === 0n) {
      return NextResponse.json({ error: "No active warmup" }, { status: 404 });
    }

    // Warmup only locks POSITIVE PnL, not deposited capital.
    // If the user has no positive PnL, there's nothing to "unlock".
    const positivePnl = account.pnl > 0n ? account.pnl : 0n;
    if (positivePnl === 0n) {
      return NextResponse.json({ error: "No profits to unlock" }, { status: 404 });
    }

    const currentSlot = await connection.getSlot("confirmed");
    const warmupPeriodSlots = Number(riskParams.warmupPeriodSlots);
    const warmupStartedAtSlot = Number(account.warmupStartedAtSlot);
    const warmupSlopePerStep = account.warmupSlopePerStep.toString();

    // Calculate unlocked/locked amounts from POSITIVE PNL only (not capital)
    const elapsed = Math.max(0, currentSlot - warmupStartedAtSlot);

    let unlockedAmount: bigint;
    let lockedAmount: bigint;

    if (elapsed >= warmupPeriodSlots) {
      unlockedAmount = positivePnl;
      lockedAmount = 0n;
    } else if (warmupPeriodSlots > 0) {
      unlockedAmount = (positivePnl * BigInt(elapsed)) / BigInt(warmupPeriodSlots);
      lockedAmount = positivePnl - unlockedAmount;
    } else {
      unlockedAmount = positivePnl;
      lockedAmount = 0n;
    }

    return NextResponse.json({
      warmupStartedAtSlot,
      warmupSlopePerStep,
      warmupPeriodSlots,
      currentSlot,
      totalLockedAmount: positivePnl.toString(),
      unlockedAmount: unlockedAmount.toString(),
      lockedAmount: lockedAmount.toString(),
    });
  } catch (err) {
    // GH#1948: never expose raw error messages to callers (internal implementation details)
    console.error("[Warmup API] Error:", err);
    return NextResponse.json(
      { error: "Failed to fetch warmup data" },
      { status: 500 }
    );
  }
}
