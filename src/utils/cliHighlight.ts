// highlight.js's type defs carry `/// <reference lib="dom" />`. SSETransport,
// mcp/client, ssh, dumpPrompts use DOM types (TextDecodeOptions, RequestInfo)
// that only typecheck because this file's `typeof import('highlight.js')` pulls
// lib.dom in. tsconfig has lib: ["ESNext"] only — fixing the actual DOM-type
// deps is a separate sweep; this ref preserves the status quo.
/// <reference lib="dom" />

import { createRequire } from 'module'
import { extname } from 'path'
import { hashPair } from './hash.js'
import { type BoundedHljs, installHighlightBounds } from './hljsBound.js'
import { applyGrammarPatches } from './hljsGrammarPatches.js'

export type CliHighlight = {
  highlight: typeof import('cli-highlight').highlight
  supportsLanguage: typeof import('cli-highlight').supportsLanguage
}

// One promise shared by Fallback.tsx, markdown.ts, events.ts, getLanguageName.
// The highlight.js import piggybacks: cli-highlight has already pulled it into
// the module cache, so the second import() is a cache hit — no extra bytes
// faulted in.
let cliHighlightPromise: Promise<CliHighlight | null> | undefined

let loadedGetLanguage: ((name: string) => { name: string } | undefined) | undefined

/**
 * CC 2.1.289 changelog #2 (OCC-side mitigation, kept ALONGSIDE the official
 * bounded-emitter port below — defense in depth):
 * "Fixed the terminal freezing on short code blocks with many unclosed
 * `<script>` tags or deeply nested `${` substitutions."
 *
 * The freeze reproduces LIVE in OCC: cli-highlight's html/xml grammar
 * (highlight.js) backtracks exponentially on repeated unclosed `<script>`
 * tags — measured locally: 10 tags ≈ 100ms, 15 ≈ 600ms, 20 > 6s. Since
 * highlighting runs synchronously in the render path, one pathological
 * code block in assistant output freezes the whole REPL.
 *
 * NOTE (OCC-107 merge): the official mechanism WAS later recovered from the
 * 2.1.289 ELF (budgeted emitter `Se(n)` / `HighlightBoundError`, installed
 * below via hljsBound.ts) — this guard remains as a cheap pre-filter so the
 * pathological html family never even enters the emitter.
 * The deeply-nested `${` (javascript) half of the official item does NOT
 * reproduce in OCC's cli-highlight js grammar (400-deep ≈ 15ms) — no guard
 * needed; recorded in docs/upstream-version-gap-occ146-2026-10.md.
 */
const MAX_SCRIPT_TAGS_TO_HIGHLIGHT = 8
const SCRIPT_OPEN_TAG_RE = /<script\b/gi
const HTML_FAMILY_LANGUAGES = new Set(['html', 'xml', 'xhtml'])

export function isPathologicalHtmlForHighlight(
  code: string,
  language: string | undefined,
): boolean {
  if (language === undefined) return false
  if (!HTML_FAMILY_LANGUAGES.has(language.toLowerCase())) return false
  const tags = code.match(SCRIPT_OPEN_TAG_RE)
  return tags !== null && tags.length > MAX_SCRIPT_TAGS_TO_HIGHLIGHT
}

/**
 * Gap-289 #2 failure memo — official v289 renderer catch (s289.txt
 * @37062551): `catch{return e.lang=null,[[D(t),i]]}` — a block that blew the
 * highlight budget renders plain AND is never re-highlighted on subsequent
 * streaming re-renders. The official memo lives on its persistent block
 * descriptor (`e.lang=null`); OCC's marked tokens are re-lexed per render, so
 * the memo is centralized here (keyed like Fallback.tsx's hlCache) where it
 * covers every consumer — markdown fences, file previews, permission
 * dialogs. Bounded LRU-by-insertion-order, same 500 cap as hlCache.
 */
const HIGHLIGHT_FAILURE_MEMO_MAX = 500
const highlightFailureMemo = new Set<string>()

function memoizeHighlightFailure(key: string): void {
  if (highlightFailureMemo.size >= HIGHLIGHT_FAILURE_MEMO_MAX) {
    const oldest = highlightFailureMemo.keys().next().value
    if (oldest !== undefined) highlightFailureMemo.delete(oldest)
  }
  highlightFailureMemo.add(key)
}

/**
 * Wraps cli-highlight's highlight: on HighlightBoundError (budget/depth-cap
 * throw from the bounded emitter installed below), HighlightLimitError (CC
 * 2.1.295 #091 before:highlight length/long-line rejection from hljsLimit)
 * — or any other throw — returns the raw code unchanged, mirroring the
 * official plain-text fallback. Without this the bound/limit throw would
 * surface as an unhandled exception inside Ink render.
 */
function withPlainFallback(
  rawHighlight: CliHighlight['highlight'],
): CliHighlight['highlight'] {
  return (code, options) => {
    const key = hashPair(options?.language ?? '', code)
    if (highlightFailureMemo.has(key)) return code
    try {
      return rawHighlight(code, options)
    } catch {
      memoizeHighlightFailure(key)
      return code
    }
  }
}

async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    const cliHighlight = await import('cli-highlight')
    // cache hit — cli-highlight already loaded highlight.js
    const highlightJs = await import('highlight.js')
    // Gap-289 #2 — mirror the official hljs-manager core():
    // `let n=e.loadCore();Se(n);` (s289.txt @17553789; the exact 1-token diff
    // vs v288). cli-highlight `require`s this same module instance, so
    // configuring the bounded emitter + budget plugin here bounds its
    // internal hljs.highlight call too. Idempotent (official ne/isBounded
    // guard). Official `ke()`: unwrap the interop default.
    const hljs = ((highlightJs as { default?: unknown }).default ??
      highlightJs) as BoundedHljs
    installHighlightBounds(hljs)
    // CC 2.1.295 #091 Layer B — patch the catastrophic-backtracking grammar
    // regexes in place (official patches at registerLanguage time via its
    // `O(name, loader)` wrapper; both hljs generations compile grammars
    // lazily inside highlight(), so patching the stored trees here — before
    // any highlight call — is timing-equivalent. See hljsGrammarPatches.ts
    // header for the full divergence note.)
    applyGrammarPatches(hljs)
    // OCC-specific: cli-highlight pins highlight.js@^10.7.1, so under Bun's
    // isolated node_modules store it resolves a SEPARATE v10 instance from
    // OCC's root v11 dep — the instance that actually renders terminal
    // highlights. Reach it with a require anchored at cli-highlight's own
    // location and bound it too. (The official binary vendors a single hljs
    // core, so its one `Se(n)` call suffices; here two instances exist.)
    // No-op when already bounded (idempotent). In the bundled dist this
    // resolve fails — scripts/build.ts injects the install into the inlined
    // highlight.js copies instead.
    try {
      const anchoredRequire = createRequire(
        import.meta.resolveSync('cli-highlight'),
      )
      const cliHighlightJs = anchoredRequire('highlight.js') as {
        default?: unknown
      } | null
      const chHljs = ((cliHighlightJs as { default?: unknown })?.default ??
        cliHighlightJs) as BoundedHljs | null
      if (chHljs) {
        installHighlightBounds(chHljs)
        // CC 2.1.295 #091 Layer B — same in-place grammar patching for the
        // v10 instance cli-highlight actually renders through (pairs whose
        // `old` source doesn't exist in v10 grammars are designed no-ops).
        applyGrammarPatches(chHljs)
      }
    } catch {
      // bundled/dist or unresolvable — build-time injection covers it
    }
    loadedGetLanguage = (highlightJs as { getLanguage?: typeof loadedGetLanguage }).getLanguage
    return {
      // OCC-107 merge: their pathological-html pre-filter INSIDE the official
      // bounded-emitter plain fallback (defense in depth, both suites pinned).
      highlight: withPlainFallback((code, options) =>
        isPathologicalHtmlForHighlight(code, options?.language)
          ? code
          : cliHighlight.highlight(code, options),
      ),
      supportsLanguage: cliHighlight.supportsLanguage,
    }
  } catch {
    return null
  }
}

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight()
  return cliHighlightPromise
}

/**
 * eg. "foo/bar.ts" → "TypeScript". Awaits the shared cli-highlight load,
 * then reads highlight.js's language registry. All callers are telemetry
 * (OTel counter attributes, permission-dialog unary events) — none block
 * on this, they fire-and-forget or the consumer already handles Promise<string>.
 */
export async function getLanguageName(file_path: string): Promise<string> {
  await getCliHighlightPromise()
  const ext = extname(file_path).slice(1)
  if (!ext) return 'unknown'
  return loadedGetLanguage?.(ext)?.name ?? 'unknown'
}
