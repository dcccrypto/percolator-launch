/** v2.2 preview build tag: short commit SHA + Vercel deployment id, inlined at build (next.config.ts env). */
export interface V22Build { sha: string; deployment: string }
export function v22Build(): V22Build {
  return { sha: process.env.NEXT_PUBLIC_BUILD_SHA ?? "", deployment: process.env.NEXT_PUBLIC_BUILD_DEPLOYMENT ?? "" };
}
export function formatV22Build(b: V22Build): string {
  return `build ${b.sha || "local"}${b.deployment ? ` · ${b.deployment}` : ""}`;
}
