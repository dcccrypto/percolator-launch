/**
 * Dev-only visual preview of the Devnet v2.2 surfaces with fixture data (no RPC, no wallet). 404 unless the dev
 * server runs with NEXT_PUBLIC_DEV_PREVIEW=1 and not on a Vercel production deployment (so it never ships as a reachable page).
 */
import { notFound } from "next/navigation";
import { V22Preview } from "./preview";
import { devPreviewAllowed } from "@/lib/v22/dev-preview-gate";

export default function Page() {
  if (!devPreviewAllowed({ NEXT_PUBLIC_DEV_PREVIEW: process.env.NEXT_PUBLIC_DEV_PREVIEW, VERCEL_ENV: process.env.VERCEL_ENV })) notFound();
  return <V22Preview />;
}
