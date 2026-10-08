/**
 * Surrogate-safe text slicers — verbatim ports of the official Claude Code
 * 2.1.292/293 helpers @203275474 (gap item #018a; see
 * docs/gap-research-293/webfetch-018-forensics.md §2.3):
 *
 *   function ne(t,n){if(n<=0)return"";if(t.length<=n)return t;let e=t.slice(0,n),r=e.charCodeAt(n-1);
 *     return f(r>=55296&&r<=56319?e.slice(0,-1):e)}
 *   function Xl(t,n){if(n<=0)return"";if(t.length<=n)return t;let e=t.slice(-n),r=e.charCodeAt(0);
 *     return f(r>=56320&&r<=57343?e.slice(1):e)}
 *   function f(t){if(typeof Buffer<"u")return Buffer.from(t,"utf16le").toString("utf16le");return x(t)}
 *
 * `ne` (here: sliceHead) drops a trailing lone HIGH surrogate (D800–DBFF) at
 * the cut point; `Xl` (here: sliceTail) drops a leading lone LOW surrogate
 * (DC00–DFFF); `f` normalizes via a utf16le Buffer round-trip. Buffer always
 * exists on the Bun/Node runtime OCC ships on, so the official's non-Buffer
 * fallback (`x(t)`) is unreachable and omitted.
 *
 * The WebFetch offset reader uses `Xl(Ut, Ut.length - H)` = "text from
 * character offset H on"; the secondary-model remainder cap uses
 * `zJn(e) = ne(e, 100_000)` (@213370702) — see applyPromptToMarkdown and
 * WebFetchTool.call.
 *
 * NOTE (item #018b, STAGED): the official's gated `agent_raw` verbatim reader
 * (`LLo`, inside the built-in `web-fetch` subagent, env-gated
 * CLAUDE_CODE_WEB_FETCH_AGENT ?? growthbook tengu_clever_orbit default false)
 * also consumes these slicers. Only the always-on #018a consumers are wired
 * in OCC; #018b (LLo / ZK tag escaping / web-fetch subagent / tool-filter
 * chain) stays staged — do not add gated callers here without porting that
 * item. The official mid-slicer `T4` is unused by either WebFetch item and is
 * intentionally not ported (YAGNI).
 */

/** Official `f` — utf16le Buffer round-trip normalization. */
function normalizeUtf16(t: string): string {
  return Buffer.from(t, 'utf16le').toString('utf16le')
}

/**
 * Official `ne` — the first `n` characters of `t`, dropping a trailing lone
 * high surrogate so a surrogate pair is never split in half.
 */
export function sliceHead(t: string, n: number): string {
  if (n <= 0) return ''
  if (t.length <= n) return t
  const e = t.slice(0, n)
  const r = e.charCodeAt(n - 1)
  return normalizeUtf16(r >= 0xd800 && r <= 0xdbff ? e.slice(0, -1) : e)
}

/**
 * Official `Xl` — the last `n` characters of `t`, dropping a leading lone low
 * surrogate so a surrogate pair is never split in half. With
 * `n = t.length - offset` this is "text from character offset on".
 */
export function sliceTail(t: string, n: number): string {
  if (n <= 0) return ''
  if (t.length <= n) return t
  const e = t.slice(-n)
  const r = e.charCodeAt(0)
  return normalizeUtf16(r >= 0xdc00 && r <= 0xdfff ? e.slice(1) : e)
}
