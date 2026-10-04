// highlight.js's type defs carry `/// <reference lib="dom" />`. SSETransport,
// mcp/client, ssh, dumpPrompts use DOM types (TextDecodeOptions, RequestInfo)
// that only typecheck because this file's `typeof import('highlight.js')` pulls
// lib.dom in. tsconfig has lib: ["ESNext"] only — fixing the actual DOM-type
// deps is a separate sweep; this ref preserves the status quo.
/// <reference lib="dom" />

import { extname } from 'path'

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
 * CC 2.1.289 changelog #2 (OCC-side mitigation, documented divergence):
 * "Fixed the terminal freezing on short code blocks with many unclosed
 * `<script>` tags or deeply nested `${` substitutions."
 *
 * The freeze reproduces LIVE in OCC: cli-highlight's html/xml grammar
 * (highlight.js) backtracks exponentially on repeated unclosed `<script>`
 * tags — measured locally: 10 tags ≈ 100ms, 15 ≈ 600ms, 20 > 6s. Since
 * highlighting runs synchronously in the render path, one pathological
 * code block in assistant output freezes the whole REPL.
 *
 * The official fix lives inside their bundled highlighter (no extractable
 * named marker in the 2.1.289 ELF), so instead of guessing their mechanism
 * this guard skips highlighting (plain-text render — cosmetic-only loss)
 * when an html/xml-family block carries more `<script` open tags than the
 * threshold. Threshold 8 keeps worst-case highlight cost ≈ tens of ms.
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

async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    const cliHighlight = await import('cli-highlight')
    // cache hit — cli-highlight already loaded highlight.js
    const highlightJs = await import('highlight.js')
    loadedGetLanguage = (highlightJs as { getLanguage?: typeof loadedGetLanguage }).getLanguage
    return {
      highlight: (code, options) =>
        // CC 2.1.289 #2 guard: plain passthrough (valid unhighlighted
        // string — same shape cli-highlight returns for plaintext) when the
        // html/xml grammar would blow up exponentially.
        isPathologicalHtmlForHighlight(code, options?.language)
          ? code
          : cliHighlight.highlight(code, options),
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
