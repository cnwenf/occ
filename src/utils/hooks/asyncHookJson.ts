/**
 * CC 2.1.295 (#078): async hook JSON answer extraction.
 *
 * Bug (v294 and earlier): an async hook's JSON output was ignored when it
 * was printed over several lines — the registry scanned stdout line by line
 * and only tried `JSON.parse` on single lines starting with `{`, so a
 * pretty-printed object never parsed and the response was silently dropped.
 *
 * Official v295 mechanism (ELF offsets verified against
 * /tmp/cc-153/v295/package/claude; the v294 per-line loop with its
 * "Found JSON line" log @213046724 is gone in v295):
 *   - `fkt` (extractAsyncHookSyncResponse) @~215484300: builds a candidate
 *     list — FIRST the whole trimmed stdout (skipping the leading
 *     `{"async":true}` announcement line when present) joined back with
 *     newlines, THEN each individual trimmed line (the v294 fallback) —
 *     and returns the first candidate that parses to a JSON object without
 *     an "async" key. The whole-stdout candidate is what makes
 *     multi-line/pretty-printed JSON answers readable.
 *   - `QIe` (parseHookJsonObject): a candidate must start with `{` and
 *     parse to a plain object, else undefined.
 *   - `ukt` (isAsyncMarkerOutput): `"async" in (QIe(e) ?? {})`.
 *   - `pkt` (hasUnreadableAsyncHookJsonAnswer): diagnostic predicate —
 *     the whole stdout is not an async-marker object AND some line begins
 *     with `{` and is not itself an async marker. Only consulted when
 *     extraction found nothing; triggers the user-facing error log telling
 *     them to print one JSON object and nothing else.
 *   - finalizeHook wraps extraction in one try/catch ("Failed to read the
 *     JSON answer of ..., so it is dropped") instead of per-line catches.
 *
 * Contract (deliberately faithful to official, pinned by tests): text
 * BEFORE a multi-line JSON object means the whole-stdout candidate fails to
 * parse and the per-line fallback cannot see the object either — that case
 * is NOT recognized (the pkt error log advises the user), exactly as in the
 * official binary.
 */
import type { SyncHookJSONOutput } from 'src/entrypoints/agentSdkTypes.js'
import { jsonParse } from '../slowOperations.js'

/** Official `L` — plain-object guard (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Official `QIe` verbatim:
 *   if(!e.startsWith("{"))return;
 *   try{let n=X(e);return L(n)?n:void 0}catch{return}
 */
export function parseHookJsonObject(
  text: string,
): SyncHookJSONOutput | undefined {
  if (!text.startsWith('{')) {
    return undefined
  }
  try {
    const parsed: unknown = jsonParse(text)
    return isPlainObject(parsed) ? (parsed as SyncHookJSONOutput) : undefined
  } catch {
    return undefined
  }
}

/** Official `ukt` verbatim: `"async"in(QIe(e)??{})`. */
export function isAsyncMarkerOutput(text: string): boolean {
  return 'async' in (parseHookJsonObject(text) ?? {})
}

/**
 * Official `fkt` verbatim:
 *   let n=e.trim().split("\n"),[r=""]=n,s=QIe(r.trim()),
 *       h=[(s!==void 0&&"async"in s?n.slice(1):n).join("\n").trim(),
 *          ...n.map((y)=>y.trim())];
 *   for(let y of h){let S=QIe(y);if(S!==void 0&&!("async"in S))return S}
 *   return
 * The first candidate is the entire stdout (minus a leading async-marker
 * line) — this is the 2.1.295 multi-line JSON fix.
 */
export function extractAsyncHookSyncResponse(
  stdout: string,
): SyncHookJSONOutput | undefined {
  const lines = stdout.trim().split('\n')
  const [firstLine = ''] = lines
  const firstParsed = parseHookJsonObject(firstLine.trim())
  const candidates = [
    (firstParsed !== undefined && 'async' in firstParsed
      ? lines.slice(1)
      : lines
    )
      .join('\n')
      .trim(),
    ...lines.map(line => line.trim()),
  ]
  for (const candidate of candidates) {
    const parsed = parseHookJsonObject(candidate)
    if (parsed !== undefined && !('async' in parsed)) {
      return parsed
    }
  }
  return undefined
}

/**
 * Official `pkt` verbatim:
 *   return !ukt(e.trim())&&e.split("\n").some((n)=>{
 *     let r=n.trim();return r.startsWith("{")&&!ukt(r)})
 */
export function hasUnreadableAsyncHookJsonAnswer(stdout: string): boolean {
  return (
    !isAsyncMarkerOutput(stdout.trim()) &&
    stdout.split('\n').some(line => {
      const trimmed = line.trim()
      return trimmed.startsWith('{') && !isAsyncMarkerOutput(trimmed)
    })
  )
}
