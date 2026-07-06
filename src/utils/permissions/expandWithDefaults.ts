/**
 * Expand the literal "$defaults" sentinel in a user autoMode rules array,
 * splicing the built-in defaults at that position (mirrors the official 2.1.118+
 * `$defaults` expansion). Only the FIRST "$defaults" expands (subsequent ones
 * are no-ops, matching the official `r` flag). An empty user array returns all
 * built-in defaults. Other elements pass through `normalize` (identity by
 * default).
 *
 * Official logic (decompiled):
 *   if (!e.length) return [...t];
 *   let r=false, o=[];
 *   for (let s of e) {
 *     if (s === "$defaults") { if (!r) o.push(...t), r=true; continue; }
 *     o.push(n(s));
 *   }
 *   return o;
 *
 * Kept in a standalone module (no permission-graph imports) so it can be unit
 * tested without triggering the YOLO_CLASSIFIER_TOOL_NAME circular-import TDZ.
 */
export function expandWithDefaults(
  userArray: string[] | undefined,
  builtInDefaults: string[],
  normalize: (s: string) => string = s => s,
): string[] {
  if (!userArray || userArray.length === 0) return [...builtInDefaults]
  let expandedDefaults = false
  const out: string[] = []
  for (const s of userArray) {
    if (s === '$defaults') {
      if (!expandedDefaults) {
        out.push(...builtInDefaults)
        expandedDefaults = true
      }
      continue
    }
    out.push(normalize(s))
  }
  return out
}
