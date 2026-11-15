// Models send null for optional arguments that Pi treats as omitted. Preserve
// unknown tool inputs, but normalize known tool arguments before schema parsing.
export function omitNullArgs(rawArgs: unknown): unknown {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return rawArgs;
  }
  return Object.fromEntries(Object.entries(rawArgs).filter(([, value]) => value !== null));
}
