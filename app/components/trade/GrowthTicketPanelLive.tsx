"use client";

/**
 * The growth ticket panel with its v2.2 tier badge, next-unlock line and out-of-date-reading line. A separate component so the
 * cluster-slot poll (`useClusterSlot`) exists only on a growth market, not on every order ticket. Until the upgrade that carries
 * the tier rules is deployed (`GROWTH_DEPTH_RULES_DEPLOYED`), the program does not apply them, so the ticket promises nothing of it.
 */
import { useMemo, type FC } from "react";
import { GrowthTicketPanel, type GrowthTicketPanelProps } from "@/components/trade/GrowthTicketPanel";
import { useClusterSlot } from "@/hooks/useClusterSlot";
import { GROWTH_DEPTH_RULES_DEPLOYED } from "@/lib/v21/growth-market";
import { growthUnlockView } from "@/lib/v22/growth-unlock";

export interface GrowthTicketPanelLiveProps extends Omit<GrowthTicketPanelProps, "unlock"> {
  /** Engine `band_bps` of the asset; null when the band view is unavailable (no unlock is claimed). */
  bandBps: number | null;
  /** Test seam; defaults to the build constant. */
  rulesDeployed?: boolean;
}

export const GrowthTicketPanelLive: FC<GrowthTicketPanelLiveProps> = ({ bandBps, rulesDeployed = GROWTH_DEPTH_RULES_DEPLOYED, ...panel }) => {
  const nowSlot = useClusterSlot(rulesDeployed);
  const unlock = useMemo(
    () => (bandBps === null || !rulesDeployed ? null : growthUnlockView({ view: panel.view, bandBps, nowSlot })),
    [panel.view, bandBps, nowSlot, rulesDeployed],
  );
  return <GrowthTicketPanel {...panel} unlock={unlock} />;
};
