import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseAccount, parseEngine, parseParams } from "@percolator/sdk";
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

    const currentSlot = await connection.getSlot("confirmed");
    const warmupPeriodSlots = Number(riskParams.warmupPeriodSlots);
    const warmupStartedAtSlot = Number(account.warmupStartedAtSlot);
    const warmupSlopePerStep = account.warmupSlopePerStep.toString();

    // Calculate unlocked/locked amounts
    const elapsed = Math.max(0, currentSlot - warmupStartedAtSlot);
    const totalCapital = account.capital;
    
    let unlockedAmount: bigint;
    let lockedAmount: bigint;

    if (elapsed >= warmupPeriodSlots) {
      // Warmup complete
      unlockedAmount = totalCapital;
      lockedAmount = 0n;
    } else if (warmupPeriodSlots > 0) {
      unlockedAmount = (totalCapital * BigInt(elapsed)) / BigInt(warmupPeriodSlots);
      lockedAmount = totalCapital - unlockedAmount;
    } else {
      unlockedAmount = totalCapital;
      lockedAmount = 0n;
    }

    return NextResponse.json({
      warmupStartedAtSlot,
      warmupSlopePerStep,
      warmupPeriodSlots,
      currentSlot,
      totalLockedAmount: totalCapital.toString(),
      unlockedAmount: unlockedAmount.toString(),
      lockedAmount: lockedAmount.toString(),
    });
  } catch (err) {
    console.error("[Warmup API] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch warmup data" },
      { status: 500 }
    );
  }
}
