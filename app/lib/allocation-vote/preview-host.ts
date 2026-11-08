/**
 * Opt-in, preview-only exact host for the deployed-preview E2E (isolated
 * throwaway DB). Honoured ONLY when Vercel itself marks the deployment as a
 * preview (VERCEL_ENV is a Vercel system variable, not client input) AND the
 * deployment was given ALLOCATION_VOTE_PREVIEW_HOST explicitly (per deployment,
 * never in project env). The value must be one exact single-label *.vercel.app
 * hostname: no wildcard, no port, never a production host. Production,
 * mainnet and ordinary previews: unchanged.
 *
 * The ONLY env reads on the host lock live here. Edge-safe, dependency-free.
 */
const PREVIEW_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/;

export type PreviewHostEnv = { VERCEL_ENV?: string; ALLOCATION_VOTE_PREVIEW_HOST?: string };

export function previewHostEnv(): PreviewHostEnv {
  return { VERCEL_ENV: process.env.VERCEL_ENV, ALLOCATION_VOTE_PREVIEW_HOST: process.env.ALLOCATION_VOTE_PREVIEW_HOST };
}

export function allocationVotePreviewHost(env: PreviewHostEnv = previewHostEnv()): string | null {
  if (env.VERCEL_ENV !== "preview") return null;
  const h = env.ALLOCATION_VOTE_PREVIEW_HOST;
  if (typeof h !== "string" || !PREVIEW_HOST_RE.test(h)) return null;
  return h;
}
