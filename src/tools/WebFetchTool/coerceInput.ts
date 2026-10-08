/**
 * Gap-293 C5 (WebFetch part): stray-parameter tolerance. Verbatim port of the
 * official Claude Code 2.1.292/293 WebFetch dropper `zKt` + `tLo`
 * (@213351378; see docs/gap-research-293/cluster-c-h-carryover.md §C5):
 *
 *   var tLo=["text_content_token_limit","html_extraction_method","web_fetch_pdf_extract_text"];
 *   function zKt(e){if(!L(e))return null;let n=tLo.filter((s)=>Object.hasOwn(e,s));if(n.length===0)return null;
 *     let r={...e};for(let s of n)delete r[s];return{input:r,shapeClass:n.map((s)=>`drop_${s}`).join(",")}}
 *
 * Wired officially as `coerceInput(e){return pH(T2t(),zKt(e))}` (@213376925),
 * where the `pH` gate (@212144777) is
 * `function pH(e,n){return n!==null&&e.safeParse(n.input).success?n:null}` —
 * the repair is returned ONLY when the coerced input passes the full strict
 * schema, so a partial repair yields null and the normal validation error
 * stands. The gate is applied at the wiring site in WebFetchTool.ts (mirroring
 * OCC's FileWriteTool coerceInput pattern); this file is the pure `zKt` port.
 *
 * Read (`_7n`), Grep (`cEt`), WebSearch (`mode_while_off`) and Write
 * (`drop_command_create`) coercers from the same C5 item are owned by other
 * agents and intentionally NOT part of this file.
 *
 * The official dropper returns no `resultNote` (unlike Grep/Write) — dropping
 * is silent apart from the `tengu_tool_input_coerced` shapeClass telemetry
 * the executor already emits.
 */

const STRAY_WEB_FETCH_PARAMS = [
  'text_content_token_limit',
  'html_extraction_method',
  'web_fetch_pdf_extract_text',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function dropStrayWebFetchParams(raw: unknown): {
  input: Record<string, unknown>
  shapeClass: string
} | null {
  if (!isRecord(raw)) {
    return null
  }
  const dropped = STRAY_WEB_FETCH_PARAMS.filter(key => Object.hasOwn(raw, key))
  if (dropped.length === 0) {
    return null
  }
  const input: Record<string, unknown> = { ...raw }
  for (const key of dropped) {
    delete input[key]
  }
  return {
    input,
    shapeClass: dropped.map(key => `drop_${key}`).join(','),
  }
}
