import {
  DEFAULT_OUTPUT_STYLE_NAME,
  OUTPUT_STYLE_CONFIG,
  getAllOutputStyles,
  type OutputStyleConfig,
} from '../../constants/outputStyles.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../services/analytics/index.js'
import type {
  LocalCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

// Port of the official 2.1.270 /output-style command module (binary offset
// 202167402, chunk-87knjp1g). Helper-name mapping from the module imports:
//   qD(Z(), storageV5)  → getAllOutputStyles(getCwd())
//   Gse()               → getSettings_DEPRECATED()?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME
//   jJe(e)              → isBuiltinStyle(e)
//   Oee(o)              → isRelayedContext(o)   (always false in OCC)
//   ao(o.session)       → isRelayedContext(o)   (always false in OCC)
//   Sr("localSettings") → isSettingSourceEnabled('localSettings')
//   Kt("localSettings", {outputStyle}, ...) → updateSettingsForSource(...)
//   $k("output_style")  → no-op (see comment at call site)
//   i(event, meta)      → logEvent(event, meta)
//   jht(t)              → telemetryStyleName(t)
//   y(s)                → telemetry string interning (identity for our purposes)
//   _n(s)               → displaySanitizer(s) — ported verbatim (see below);
//                         the official applies it at every user-facing echo of
//                         a style name/description/argument, including the
//                         headless `-p` path (the interactive REPL additionally
//                         strips control chars at the input layer, but `-p`
//                         args reach `call()` raw)

// Official `_n` (chunk-q3eg9j9b, binary offset ~188806900) is a display
// sanitizer, NOT an identity — ported byte-faithfully:
//   var W=/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF]|[\uDC00-\uDFFF]/g
//   function z(e){return e.replace(W,(r)=>r.length===2?r:"")}
//   var C=/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]|(?!\u0020)\p{Zs}/gu
//   function A$n(e){...fixed-point loop ≤64 rounds, non-convergence → ""...}
//   function _n(e){if(typeof e!=="string")return"";
//                  return ne(A$n(e.length>4096?e.slice(0,4096):e),1024)}
// and `ne` (chunk-0y8dccaw @~185157100): surrogate-safe truncate to n UTF-16
// units + `Re` Buffer utf16le round-trip. The official applies `_n` at all six
// message sites: unknown-style echo, available-names join, listing name +
// description, current label, already-active, and set-to messages. The save
// error message is NOT sanitized upstream (`${d.error.message}` verbatim).

// Official `W`: surrogate-pair regex — well-formed pairs match at length 2.
const SURROGATE_RE =
  /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF]|[\uDC00-\uDFFF]/g

// Official `z`: keep well-formed surrogate pairs, drop lone surrogates.
function stripLoneSurrogates(value: string): string {
  return value.replace(SURROGATE_RE, match => (match.length === 2 ? match : ''))
}

// Official `C`: control/format characters (includes ESC — so CSI sequences
// lose their escape byte), line/paragraph separators, default-ignorables,
// braille blank, and non-space separators.
const INVISIBLE_RE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]|(?!\u0020)\p{Zs}/gu

// Official `A$n`: iterate z+C-stripping to a fixed point (≤64 rounds —
// stripping can expose new lone surrogates or invisible joins); a value that
// never converges fails closed to ''.
function stripInvisibleToFixedPoint(value: string): string {
  let current = value
  for (let round = 0; round < 64; round++) {
    const next = stripLoneSurrogates(current).replace(INVISIBLE_RE, '')
    if (next === current) return next
    current = next
  }
  return ''
}

// Official `ne`: truncate to `max` UTF-16 code units, dropping a trailing
// high surrogate, then round-trip through Buffer utf16le (official `Re`) so
// any residual lone surrogate becomes U+FFFD rather than leaking raw.
function truncateUtf16Safe(value: string, max: number): string {
  if (max <= 0) return ''
  if (value.length <= max) return value
  const sliced = value.slice(0, max)
  const lastUnit = sliced.charCodeAt(max - 1)
  const trimmed =
    lastUnit >= 0xd800 && lastUnit <= 0xdbff ? sliced.slice(0, -1) : sliced
  return Buffer.from(trimmed, 'utf16le').toString('utf16le')
}

// Official `_n`: non-string → '', pre-slice at 4096, sanitize, truncate 1024.
function displaySanitizer(value: unknown): string {
  if (typeof value !== 'string') return ''
  const pre = value.length > 4096 ? value.slice(0, 4096) : value
  return truncateUtf16Safe(stripInvisibleToFixedPoint(pre), 1024)
}

// Official export `g as CUSTOM_CURRENT_STYLE_PLACEHOLDER` — verbatim.
export const CUSTOM_CURRENT_STYLE_PLACEHOLDER = 'a custom style'

// Official export `C as SAVE_FAILURE_OFF_BOX` — verbatim. Shown instead of the
// raw error when the save fails in a relayed (off-box) session.
export const SAVE_FAILURE_OFF_BOX =
  "Couldn't save the output style (detail withheld on this connection)."

// Official `pEt` (chunk-qp85c5qb) — verbatim; appended after list/unknown-style
// output when the invocation arrived over the bridge.
const OFF_BOX_LIST_NOTE =
  "\nCustom output styles can't be selected over Remote Control or from a relayed message. Select one in the session itself, or pick a built-in style here."

// Official `fEt` (chunk-qp85c5qb) — verbatim; shown when localSettings isn't a
// loaded settings source for this session.
const LOCAL_SETTINGS_NOT_LOADED =
  "Output styles are saved to local settings (.claude/settings.local.json), which this session doesn't load, so the style can't be changed here."

// Official `Jw` (chunk-vfsq2z4g, binary offset 185269045) — verbatim.
const HELP_ARGS = ['help', '-h', '--help']

// Official `nN` (same chunk, `A=["list",...]` then `nN=A`) — verbatim.
const LIST_ARGS = [
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?',
]

// Official `jJe`: `e===null||e?.source==="built-in"` (binary offset ~191433038).
function isBuiltinStyle(style: OutputStyleConfig | null): boolean {
  return style === null || style?.source === 'built-in'
}

// Official `Oee(o)`: `o.dispatchedOverBridge===!0||o.submissionVerifiedSlackHumanTurn===!0`.
// OCC's LocalJSXCommandContext carries neither field (no Remote Control /
// Slack-bridge dispatch subsystem), so this is always false at runtime; the
// optional-field read is kept for structural fidelity. The official `ao(session)`
// save-error branch collapses through the same predicate.
function isRelayedContext(context: LocalJSXCommandContext): boolean {
  const relayed = context as LocalJSXCommandContext & {
    dispatchedOverBridge?: boolean
    submissionVerifiedSlackHumanTurn?: boolean
  }
  return (
    relayed.dispatchedOverBridge === true ||
    relayed.submissionVerifiedSlackHumanTurn === true
  )
}

// Official `jht(t)`: `Object.hasOwn(kB,t)?tn(t):y("custom")` (kB = built-in
// config map; tn/y = telemetry interning → identity here).
function telemetryStyleName(style: string): string {
  return Object.hasOwn(OUTPUT_STYLE_CONFIG, style) ? style : 'custom'
}

// Official `Gse()`: `Cn()?.outputStyle||nA` (nA = "default").
function currentOutputStyleName(): string {
  return (
    (getSettings_DEPRECATED()?.outputStyle as string | undefined) ||
    DEFAULT_OUTPUT_STYLE_NAME
  )
}

const call: LocalCommandCall = async (args, context) => {
  const allStyles = await getAllOutputStyles(getCwd())
  const relayed = isRelayedContext(context)
  const styleNames = Object.keys(allStyles)
  // Off-box invocations may only see/select built-in styles.
  const selectable = relayed
    ? styleNames.filter(name => isBuiltinStyle(allStyles[name]))
    : styleNames
  const current = currentOutputStyleName()
  const offBoxNote = relayed ? OFF_BOX_LIST_NOTE : ''
  const trimmed = args.trim()
  const lowered = trimmed.toLowerCase()
  const target = trimmed
    ? selectable.find(name => name.toLowerCase() === lowered)
    : undefined

  if (target === undefined) {
    if (trimmed && !LIST_ARGS.includes(lowered) && !HELP_ARGS.includes(lowered)) {
      // Official: `Unknown output style "${_n(r)}". Available styles: ${l.map(_n).join(", ")}${p}`
      return {
        type: 'text',
        value: `Unknown output style "${displaySanitizer(trimmed)}". Available styles: ${selectable.map(name => displaySanitizer(name)).join(', ')}${offBoxNote}`,
      }
    }
    // Official: `let e=l.map(c=>{let S=n[c]?.description,f=_n(c),O=c===s?" (current)":"";
    //            return S?`- ${f}${O}: ${_n(S)}`:`- ${f}${O}`})`
    const lines = selectable.map(name => {
      const description = allStyles[name]?.description
      const currentMark = name === current ? ' (current)' : ''
      const displayName = displaySanitizer(name)
      return description
        ? `- ${displayName}${currentMark}: ${displaySanitizer(description)}`
        : `- ${displayName}${currentMark}`
    })
    // Official: `Output style: ${u&&!jJe(n[s])?g:_n(s)}` (g = placeholder verbatim)
    const currentLabel =
      relayed && !isBuiltinStyle(allStyles[current])
        ? CUSTOM_CURRENT_STYLE_PLACEHOLDER
        : displaySanitizer(current)
    return {
      type: 'text',
      value: `Output style: ${currentLabel}\n\nAvailable styles:\n${lines.join('\n')}\n\nUsage: /output-style <style>${offBoxNote}`,
    }
  }

  if (target === current) {
    // Official: `Output style is already ${_n(t)}`
    return {
      type: 'text',
      value: `Output style is already ${displaySanitizer(target)}`,
    }
  }

  if (!isSettingSourceEnabled('localSettings')) {
    return { type: 'text', value: LOCAL_SETTINGS_NOT_LOADED }
  }

  const result = updateSettingsForSource('localSettings', {
    outputStyle: target,
  })
  if (result.error) {
    return {
      type: 'text',
      value: relayed
        ? SAVE_FAILURE_OFF_BOX
        : `Could not save output style: ${result.error.message}`,
    }
  }

  // Official `$k("output_style")` → promptAssembly.noteInvalidation("output_style").
  // OCC has no promptAssembly cache — the active output style is re-read per
  // turn via src/utils/attachments.ts — so invalidation is a no-op here.
  void logEvent('tengu_output_style_changed', {
    style: telemetryStyleName(target) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    source: 'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    settings_source: 'localSettings' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  // Official: `Output style set to ${_n(t)}`
  return { type: 'text', value: `Output style set to ${displaySanitizer(target)}` }
}

export { call }
