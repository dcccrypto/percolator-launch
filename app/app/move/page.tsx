import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MoveFlow } from "@/components/move/MoveFlow";
import { isMoveFlowEnabled } from "@/lib/v21/move/flag";

export const metadata: Metadata = { title: "Move to v2.1", robots: { index: false, follow: false } };

/** Flagged: 404 unless NEXT_PUBLIC_DEVNET_V21 and NEXT_PUBLIC_V21_MOVE are both on. */
export default function MovePage() {
  if (!isMoveFlowEnabled()) notFound();
  return <MoveFlow />;
}
