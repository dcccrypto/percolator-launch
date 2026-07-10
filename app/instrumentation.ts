/**
 * Next.js Instrumentation — runs once on server startup.
 *
 * Sentry instrumentation was REMOVED here. Its edge imports — `sentry.edge.config`
 * (register(), NEXT_RUNTIME === "edge") and the dynamic `import("@sentry/nextjs")`
 * in onRequestError — got co-bundled into the Edge middleware's shared chunk, and
 * Vercel's deploy-time Edge validator rejected the Node-referencing code
 * ("The Edge Function 'middleware' is referencing unsupported modules: @/lib/blocklist").
 * Sentry is also disabled at the build level (withSentryConfig removed from
 * next.config.ts). Re-introduce Sentry only via a strictly nodejs-runtime-guarded
 * path that the Edge bundle cannot reach.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export function register(): void {
  // no-op — Sentry disabled (see note above)
}
