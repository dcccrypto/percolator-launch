/** Dev-only pages are reachable only with NEXT_PUBLIC_DEV_PREVIEW=1 AND never on a Vercel production deployment (review F13). */
export function devPreviewAllowed(env: { NEXT_PUBLIC_DEV_PREVIEW?: string; VERCEL_ENV?: string }): boolean {
  return env.NEXT_PUBLIC_DEV_PREVIEW === "1" && env.VERCEL_ENV !== "production";
}
