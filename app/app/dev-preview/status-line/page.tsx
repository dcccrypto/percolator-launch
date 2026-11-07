/**
 * Dev-only visual preview for UX work packages (screenshots at 375 / 1440 px). 404 unless the dev server runs with
 * NEXT_PUBLIC_DEV_PREVIEW=1 and not on a Vercel production deployment (so it never ships as a reachable page).
 */
import { notFound } from "next/navigation";
import { StatusLinePreview } from "./preview";
import { devPreviewAllowed } from "@/lib/v22/dev-preview-gate";

export default function Page() {
  if (!devPreviewAllowed({ NEXT_PUBLIC_DEV_PREVIEW: process.env.NEXT_PUBLIC_DEV_PREVIEW, VERCEL_ENV: process.env.VERCEL_ENV })) notFound();
  return <StatusLinePreview />;
}
