"use client";

import { SlabProvider } from "@/components/providers/SlabProvider";
import { useEngineState } from "@/hooks/useEngineState";
import { PnlShareModal } from "@/components/share/PnlShareModal";
import { poolPayableCapacity, type PnlCardData } from "@/lib/pnl-card";

/** Reads the slab's vault + insurance (PositionsDock's formula) and hands it to the card. */
function CapacityBridge({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const { engine, insuranceBalance } = useEngineState();
  const payableCapacityAtoms = poolPayableCapacity(engine?.vault, insuranceBalance);
  return <PnlShareModal data={{ ...data, payableCapacityAtoms }} onClose={onClose} />;
}

/**
 * The share modal for surfaces with no slab context (the portfolio rows). Like
 * the portfolio's on-demand close flow, it mounts its own SlabProvider only while
 * the modal is open, so the card can apply the same pool-payout cap as the trade
 * dock without the page paying one provider per row.
 */
export function PnlShareModalWithSlabCapacity({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  return (
    <SlabProvider slabAddress={data.slab}>
      <CapacityBridge data={data} onClose={onClose} />
    </SlabProvider>
  );
}
