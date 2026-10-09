import { describe, expect, test } from 'bun:test'

// WebFetchTool transitively pulls in the fetch path which reads MACRO.VERSION
// (a build-time constant polyfilled in cli.tsx). Mirror that polyfill so the
// module imports cleanly under `bun test`.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Gap-293 C5 (WebFetch part only): stray-parameter tolerance. The official
 * WebFetch dropper `zKt` (@213351378, wired @213376925 as
 * `coerceInput(e){return pH(T2t(),zKt(e))}`) drops EXACTLY three stray params
 * before schema parse:
 *
 *   var tLo=["text_content_token_limit","html_extraction_method","web_fetch_pdf_extract_text"];
 *   function zKt(e){if(!L(e))return null;let n=tLo.filter((s)=>Object.hasOwn(e,s));if(n.length===0)return null;
 *     let r={...e};for(let s of n)delete r[s];return{input:r,shapeClass:n.map((s)=>`drop_${s}`).join(",")}}
 *
 * `pH` gate (@212144777): `n!==null&&e.safeParse(n.input).success?n:null` —
 * coercion is only returned when the COERCED input passes the strict schema;
 * a partial repair yields null and normal validation errors stand.
 *
 * Read/Grep/WebSearch/Write parts of C5 are owned by other agents — this file
 * pins the WebFetch part only.
 */
const { WebFetchTool } = await import('../WebFetchTool.js')

const VALID = { url: 'https://example.com/page', prompt: 'summarize' }

describe('C5 WebFetch — coerceInput drops the three official stray params', () => {
  test('drops text_content_token_limit with drop_* shapeClass', () => {
    const repair = WebFetchTool.coerceInput?.({
      ...VALID,
      text_content_token_limit: 25000,
    })
    expect(repair).not.toBeNull()
    expect(repair?.input).toEqual(VALID)
    expect(repair?.shapeClass).toBe('drop_text_content_token_limit')
  })

  test('drops html_extraction_method with drop_* shapeClass', () => {
    const repair = WebFetchTool.coerceInput?.({
      ...VALID,
      html_extraction_method: 'markdown',
    })
    expect(repair).not.toBeNull()
    expect(repair?.input).toEqual(VALID)
    expect(repair?.shapeClass).toBe('drop_html_extraction_method')
  })

  test('drops web_fetch_pdf_extract_text with drop_* shapeClass', () => {
    const repair = WebFetchTool.coerceInput?.({
      ...VALID,
      web_fetch_pdf_extract_text: true,
    })
    expect(repair).not.toBeNull()
    expect(repair?.input).toEqual(VALID)
    expect(repair?.shapeClass).toBe('drop_web_fetch_pdf_extract_text')
  })

  test('drops all three at once, shapeClass joined in official tLo order', () => {
    const repair = WebFetchTool.coerceInput?.({
      ...VALID,
      web_fetch_pdf_extract_text: true,
      html_extraction_method: 'markdown',
      text_content_token_limit: 25000,
    })
    expect(repair).not.toBeNull()
    expect(repair?.input).toEqual(VALID)
    expect(repair?.shapeClass).toBe(
      'drop_text_content_token_limit,drop_html_extraction_method,drop_web_fetch_pdf_extract_text',
    )
  })

  test('keeps a valid offset param while dropping strays', () => {
    const repair = WebFetchTool.coerceInput?.({
      ...VALID,
      offset: 100,
      text_content_token_limit: 25000,
    })
    expect(repair).not.toBeNull()
    expect(repair?.input).toEqual({ ...VALID, offset: 100 })
  })
})

describe('C5 WebFetch — pH gate: coerce only when the repaired input strict-parses', () => {
  test('returns null when no stray params are present (nothing to coerce)', () => {
    expect(WebFetchTool.coerceInput?.({ ...VALID })).toBeNull()
    expect(WebFetchTool.coerceInput?.({ ...VALID, offset: '500' })).toBeNull()
  })

  test('returns null when the repaired input still fails the strict schema', () => {
    // missing prompt → repaired input still invalid → pH gate → null
    expect(
      WebFetchTool.coerceInput?.({
        url: 'https://example.com/page',
        text_content_token_limit: 25000,
      }),
    ).toBeNull()
  })

  test('returns null for non-object input', () => {
    expect(WebFetchTool.coerceInput?.('https://example.com')).toBeNull()
    expect(WebFetchTool.coerceInput?.(null)).toBeNull()
    expect(WebFetchTool.coerceInput?.([{ ...VALID }])).toBeNull()
  })

  test('does not drop other unknown params (strictObject still rejects them)', () => {
    // Official drops EXACTLY the three tLo params; anything else stays and the
    // strict schema rejects it as before.
    expect(
      WebFetchTool.coerceInput?.({ ...VALID, some_other_param: 1 }),
    ).toBeNull()
    const parsed = WebFetchTool.inputSchema.safeParse({
      ...VALID,
      some_other_param: 1,
    })
    expect(parsed.success).toBe(false)
  })
})
