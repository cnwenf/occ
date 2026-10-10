/**
 * CC 2.1.295 (#022): Bash tool `coerceInput` — verbatim port of the official
 * v295 `fvn` (@219108012, byte-verified):
 *
 *   function fvn(e){if(!L(e))return null;let n={...e},r=[];
 *     if("timeout_ms"in n&&!("timeout"in n)){let s=n.timeout_ms;
 *       if(typeof s==="number"||typeof s==="string"&&/^\d+$/.test(s))
 *         n.timeout=s,delete n.timeout_ms,r.push("timeout_ms")}
 *     if("command_description"in n){
 *       if(!("description"in n)&&typeof n.command_description==="string")
 *         n.description=n.command_description,r.push("command_description");
 *       else r.push("command_description_dropped");
 *       delete n.command_description}
 *     return r.length?{input:n,shapeClass:r.join(",")}:null}
 *
 * Wired officially as a DIRECT reference on the Bash tool def — `coerceInput:fvn`
 * (@219165025: `get inputSchema(){return Lxn()},coerceInput:fvn,…`) with NO
 * `pH` schema-success gate (that gate is WebFetch/Grep-only) and NO
 * `coerceInputBeforePluginHooks` flag (Write-only).
 *
 * v294→v295 delta (v294 `cRn` @216611875 handled ONLY timeout_ms):
 *   1. NEW `command_description` arm — models that call the tool with
 *      `command_description` (older/other-harness schema name) instead of
 *      `description` no longer fail the strict schema: the value is aliased
 *      when `description` is absent and a string, otherwise dropped
 *      (shapeClass `command_description_dropped`). Either way the key itself
 *      is always deleted (the strict object schema would reject it).
 *   2. `delete n.timeout_ms` moved INSIDE the valid-type branch — v294
 *      deleted an invalid-typed `timeout_ms` unconditionally (silently
 *      dropping e.g. `timeout_ms:{}`), v295 leaves it in the input so the
 *      strict schema still rejects it. This port keeps the v295 position.
 *
 * The generic parse site (official `N6t` @216992939; OCC
 * services/tools/toolExecution.ts checkPermissionsAndCallTool) calls
 * `coerceInput?.(input)` before `inputSchema.safeParse` and emits
 * `tengu_tool_input_coerced` with `{toolName, shapeClass, outcome}` — no
 * extra telemetry wiring needed here. `fvn` returns no `resultNote` (unlike
 * Write/Grep coercers).
 *
 * `L(e)` is the shared plain-object guard used by every official coercer
 * (same as WebFetchTool/coerceInput.ts `isRecord`). The digit-string timeout
 * tolerance pairs with the schema's semanticNumber wrapper, which coerces
 * `"5000"` → 5000 at parse time.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function coerceBashInput(raw: unknown): {
  input: Record<string, unknown>
  shapeClass: string
} | null {
  if (!isRecord(raw)) {
    return null
  }
  const input: Record<string, unknown> = { ...raw }
  const shapeClasses: string[] = []

  // Arm 1 — `timeout_ms` alias (present since v294 as `cRn`, delete-position
  // changed in v295): alias only when `timeout` is absent AND the value is a
  // number or a digits-only string; an invalid-typed `timeout_ms` stays in
  // the input so the strict schema rejects it (v295 behavior).
  if ('timeout_ms' in input && !('timeout' in input)) {
    const value = input.timeout_ms
    if (
      typeof value === 'number' ||
      (typeof value === 'string' && /^\d+$/.test(value))
    ) {
      input.timeout = value
      delete input.timeout_ms
      shapeClasses.push('timeout_ms')
    }
  }

  // Arm 2 — `command_description` alias (NEW in v295, the #022 fix): alias to
  // `description` when absent and a string; otherwise record the drop. The
  // key is ALWAYS deleted — the strict object schema never accepts it.
  if ('command_description' in input) {
    if (!('description' in input) && typeof input.command_description === 'string') {
      input.description = input.command_description
      shapeClasses.push('command_description')
    } else {
      shapeClasses.push('command_description_dropped')
    }
    delete input.command_description
  }

  return shapeClasses.length > 0
    ? { input, shapeClass: shapeClasses.join(',') }
    : null
}
