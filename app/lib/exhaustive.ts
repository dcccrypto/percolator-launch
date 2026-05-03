/**
 * Compile-time exhaustiveness check for switch / discriminated-union dispatch.
 *
 * Add `default: return assertNever(value)` (or `default: assertNever(value)`)
 * to a switch over a union type. If a future contributor extends the union
 * without adding a matching case, TypeScript fails at the assertNever call
 * site — pointing at the missing branch instead of at the function signature.
 *
 * The runtime throw is a safety net for paths that bypass the type system
 * (stale enum values from storage, `as any` upstream, JSON deserialisation,
 * `// @ts-expect-error`). Production code should never reach it.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}
