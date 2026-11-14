/**
 * A small JSON-schema validator for the subset the bot API's OpenAPI document uses ($ref, allOf, oneOf, type, enum, pattern,
 * minimum/maximum, required, properties, additionalProperties: false, items). Test-only; no dependency. Returns the list
 * of mismatches (empty = the value fits the schema).
 */
type S = { [k: string]: unknown };

export function validate(schema: S, value: unknown, components: Record<string, S>, path = "$"): string[] {
  if (schema.$ref !== undefined) {
    const name = String(schema.$ref).replace("#/components/schemas/", "");
    const target = components[name];
    if (!target) return [`${path}: unknown $ref ${name}`];
    return validate(target, value, components, path);
  }
  const errs: string[] = [];
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf as S[]) errs.push(...validate(s, value, components, path));
  if (Array.isArray(schema.oneOf)) {
    const branches = (schema.oneOf as S[]).map((s) => validate(s, value, components, path));
    if (!branches.some((b) => b.length === 0)) errs.push(`${path}: matches none of oneOf (${branches.map((b) => b[0]).join(" | ")})`);
  }
  const type = schema.type as string | undefined;
  if (type !== undefined) {
    const ok =
      type === "null" ? value === null
      : type === "string" ? typeof value === "string"
      : type === "boolean" ? typeof value === "boolean"
      : type === "integer" ? typeof value === "number" && Number.isInteger(value)
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
      : type === "array" ? Array.isArray(value)
      : type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
      : true;
    if (!ok) return [...errs, `${path}: expected ${type}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value} (${JSON.stringify(value)?.slice(0, 40)})`];
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: "${value.slice(0, 40)}" does not match ${schema.pattern}`);
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${path}: ${value} < minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errs.push(`${path}: ${value} > maximum`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errs.push(`${path}: ${value} <= exclusiveMinimum`);
  }
  if (type === "array" && Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items as S, v, components, `${path}[${i}]`)));
  if (type === "object" && typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, S>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in o)) errs.push(`${path}: missing required "${r}"`);
    for (const [k, v] of Object.entries(o)) {
      if (props[k]) errs.push(...validate(props[k], v, components, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unexpected property "${k}"`);
    }
  }
  return errs;
}
