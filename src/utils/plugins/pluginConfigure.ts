/**
 * `claude plugin configure <plugin>` core logic (official Claude Code 2.1.285,
 * changelog item 9 — NEW command, plus `--values-stdin`).
 *
 * Ported byte-faithfully from the decompiled official 2.1.285 linux-x64 ELF
 * (`pluginConfigureHandler` = `Aa`, plugin-handlers chunk; captured verbatim at
 * /tmp/agentE/msgs285.txt + the front-half dump @231325200):
 *
 *   official            here
 *   --------            ----
 *   `tn`=262144         PLUGIN_CONFIGURE_STDIN_MAX_BYTES (256 KB)
 *   `an`=65536          PLUGIN_CONFIGURE_VALUE_MAX_BYTES (64 KB)
 *   `nn(s)`             parseStdinValuesJson
 *   `re` (extends I)    PluginConfigureRefusedError
 *   `$e(s,o)`           redactSensitiveValues
 *   (sensitive collect) collectSensitiveRedactionValues
 *   `LHe(G)`            parseBooleanValue
 *   `pe(s,o)`           configureOptionDisplayName
 *   `P(n,"option")`     pluralizeOptionWord
 *   `ln` validation     validateConfigureValues
 *   `Aa` display/JSON   buildConfigureDisplayLines / *Json builders
 *
 * Known omissions / staged (documented, never invented):
 * - The NUMBER-validation branch of the official `ln`
 *   (`M?.type==="number" && Ikt(G,M)===undefined` → `${pe(E,M)}: ${xkt(M)}`)
 *   is NOT implemented: `xkt`'s constraint-specific message body was not
 *   uniquely recoverable from the binary (multiple "must be a number /
 *   integer / at least / at most / between" candidates exist and cannot be
 *   attributed to `xkt` with byte certainty). String/boolean/required/size/
 *   line-break/undeclared/schema validation are all byte-exact; number
 *   validation is staged for a dedicated per-site decompilation.
 * - `Yn` (the display sanitizer applied to interpolated ids/keys/titles and to
 *   the joined schema errors) was not uniquely resolved among the official's
 *   sanitize aliases (`Kt`/`vt`/`Tn`). For all realistic ASCII option keys and
 *   titles these are identical, so `configureOptionDisplayName` uses the
 *   recovered `sanitizePluginMessageText` (≡`vt`); byte-faithfulness holds for
 *   well-formed inputs. Flagged in the port report.
 * - Schema validation (`VV` ≡ mcpbHandler.validateUserConfig) and the save
 *   (`vge` ≡ pluginOptionsStorage.savePluginOptions) are performed by the
 *   out-of-domain handler using OCC's existing in-domain functions; this core
 *   module stays pure (parse + validate + build) and testable.
 * - The CLI handler (`pluginConfigureHandler` in src/cli/handlers/plugins.ts),
 *   its registration in src/main.tsx, plugin discovery (`Wb`/`FKe`), and the
 *   output/telemetry plumbing (`Ic`/`si`/`rf`/`Jo`/`rn`/`ai`/`ac`) are all
 *   out of this module's domain — see the staged-wiring section of the report.
 */

import { sanitizePluginMessageText } from './pluginDisplayText.js'

/** Official `tn`: stdin payload hard cap (256 KB). */
export const PLUGIN_CONFIGURE_STDIN_MAX_BYTES = 262144
/** Official `an`: single option-value hard cap (64 KB). */
export const PLUGIN_CONFIGURE_VALUE_MAX_BYTES = 65536

/** Official `E`: the example hint appended to stdin usage errors. */
export const PLUGIN_CONFIGURE_EXAMPLE_HINT =
  'Example: claude plugin configure <plugin> --values-stdin < values.json'

/** Byte-exact stdout strings from the official `Aa` handler. */
export const PLUGIN_CONFIGURE_STDIN_OVER_LIMIT =
  'The input on stdin is over the 256 KB limit.'
export const PLUGIN_CONFIGURE_SAVED_TEXT =
  'Configuration saved. Restart Claude Code to apply it.'
export const PLUGIN_CONFIGURE_NO_CHANGES_TEXT = 'No configuration changes.'
export const PLUGIN_CONFIGURE_DISPLAY_FOOTER =
  'Set values with /plugin configure <plugin> in Claude Code, or pipe a JSON object to `claude plugin configure <plugin> --values-stdin`.'

/** Telemetry names (official `i`/`rn`/`ac`/`ai` call sites). */
export const PLUGIN_CONFIGURE_COMMAND_TELEMETRY =
  'tengu_plugin_configure_command'
export const PLUGIN_CONFIGURE_TELEMETRY_EVENT = 'cli_plugin_configure'

/** One declared `userConfig` option (minimal structural view). */
export interface ConfigureSchemaOption {
  readonly title?: string
  readonly type?: string
  readonly required?: boolean
  readonly sensitive?: boolean
}
export type ConfigureSchema = Readonly<Record<string, ConfigureSchemaOption>>

// ---------------------------------------------------------------------------
// Message builders (byte-identical to the official Aa handler)
// ---------------------------------------------------------------------------

/** Official not-found message (`Yn(s)` sanitizes the requested id). */
export function pluginConfigureNotFoundMessage(
  pluginId: string,
  cowork = false,
): string {
  return `No installed plugin has the id "${sanitizePluginMessageText(pluginId)}". Use its full id (name@marketplace), as \`claude plugin list${cowork ? ' --cowork' : ''}\` shows it.`
}

/** Official TTY-guard message: `No option values were piped in. ${E}`. */
export function pluginConfigureStdinNotPipedMessage(): string {
  return `No option values were piped in. ${PLUGIN_CONFIGURE_EXAMPLE_HINT}`
}

/** Official non-JSON-object message: `...isn't a JSON object of strings. ${E}`. */
export function pluginConfigureStdinNotJsonObjectMessage(): string {
  return `The input on stdin isn't a JSON object of strings. ${PLUGIN_CONFIGURE_EXAMPLE_HINT}`
}

/** Official save-failure message (already sensitive-redacted by the caller). */
export function pluginConfigureSaveFailedMessage(errorText: string): string {
  return `Failed to save configuration: ${errorText}`
}

/** Official saved-but-reread-failed log message. */
export function pluginConfigureSavedRereadFailedMessage(
  errorText: string,
): string {
  return `plugin configure: saved, but the re-read of unset options failed: ${errorText}`
}

/** Official could-not-read-saved-options message. */
export function pluginConfigureCouldNotReadSavedMessage(
  pluginId: string,
  errorText: string,
): string {
  return `Could not read the saved options for "${pluginId}": ${errorText}`
}

// ---------------------------------------------------------------------------
// stdin parsing (official nn)
// ---------------------------------------------------------------------------

/**
 * Official `nn(s)`: accept only a plain JSON object whose every value is a
 * string; anything else (non-object, null, array, non-string value) → undefined.
 * Takes the ALREADY-PARSED value (the official does `Q(stdin)` = JSON.parse
 * first, then `nn`).
 */
export function parseStdinValuesJson(
  parsed: unknown,
): Record<string, string> | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const result: Record<string, string> = Object.create(null)
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') return undefined
    result[key] = value
  }
  return result
}

// ---------------------------------------------------------------------------
// Sensitive-value redaction (official $e + the O collector)
// ---------------------------------------------------------------------------

/**
 * Official `O` collector: the sensitive values present in the submitted stdin
 * object — raw and trimmed, non-empty, sorted LONGEST-FIRST so a longer secret
 * is redacted before any of its substrings.
 */
export function collectSensitiveRedactionValues(
  values: Readonly<Record<string, string>>,
  schema: ConfigureSchema,
): string[] {
  return Object.entries(values)
    .filter(([key]) => Object.hasOwn(schema, key) && schema[key]?.sensitive)
    .flatMap(([, value]) => [value, value.trim()])
    .filter(value => value !== '')
    .sort((a, b) => b.length - a.length)
}

/** Official `$e(s,o)`: replace every sensitive value substring with U+2026. */
export function redactSensitiveValues(
  message: string,
  sensitiveValues: ReadonlyArray<string>,
): string {
  return sensitiveValues.reduce(
    (acc, value) => acc.split(value).join('…'),
    message,
  )
}

// ---------------------------------------------------------------------------
// Value parsing helpers (official LHe / pe / P)
// ---------------------------------------------------------------------------

/**
 * Official `LHe(G)`: boolean parse. The accepted set is byte-specified by the
 * validation error message — "true or false (or 1/0, yes/no, on/off)". Returns
 * undefined when the value is not one of those (case-insensitive).
 */
export function parseBooleanValue(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
      return true
    case 'false':
    case '0':
    case 'no':
    case 'off':
      return false
    default:
      return undefined
  }
}

/** Official `pe(s,o)` = `Yn(o?.title || s)`: option display name. */
export function configureOptionDisplayName(
  key: string,
  option: ConfigureSchemaOption | undefined,
): string {
  return sanitizePluginMessageText(option?.title || key)
}

/** Official `P(n,"option")`: "option" for 1, else "options". */
export function pluralizeOptionWord(count: number): string {
  return count === 1 ? 'option' : 'options'
}

// ---------------------------------------------------------------------------
// Refusal error (official re)
// ---------------------------------------------------------------------------

/**
 * Official `re extends I`: a configure refusal carrying a machine `reason`
 * (for telemetry) and, when tied to a specific option, the `option` key.
 */
export class PluginConfigureRefusedError extends Error {
  readonly reason: string
  readonly option: string | undefined

  constructor(message: string, reason: string, option?: string) {
    super(message)
    this.name = 'PluginConfigureRefusedError'
    this.reason = reason
    this.option = option
  }
}

// ---------------------------------------------------------------------------
// Validation (official ln's undeclared check + per-option loop)
// ---------------------------------------------------------------------------

/**
 * The pure-validation half of the official `ln`: reject undeclared options,
 * then per provided value enforce the 64 KB cap, single-line, required-blank,
 * and boolean-type rules with byte-exact messages. Returns nothing — it either
 * throws `PluginConfigureRefusedError` or completes. The official's NUMBER
 * branch is staged (see file header); schema validation (`VV`) and the save
 * (`vge`) run in the handler via OCC's existing in-domain functions.
 *
 * `savedValues` mirrors the official `k` (already-stored config) used by the
 * required-blank rule: a required sensitive option that already has a non-empty
 * stored value may be submitted blank.
 */
export function validateConfigureValues(
  schema: ConfigureSchema,
  values: Readonly<Record<string, string>>,
  savedValues: Readonly<Record<string, string | undefined>> = {},
): void {
  const undeclared = Object.keys(values).filter(
    key => !Object.hasOwn(schema, key),
  )
  if (undeclared.length > 0) {
    const known = Object.keys(schema).map(key => sanitizePluginMessageText(key))
    const list = undeclared
      .map(key => `"${sanitizePluginMessageText(key)}"`)
      .join(', ')
    throw new PluginConfigureRefusedError(
      `This plugin has no ${pluralizeOptionWord(undeclared.length)} ${list}.` +
        (known.length > 0 ? ` Known options: ${known.join(', ')}.` : ''),
      'plugin configure: option not declared in userConfig',
    )
  }

  for (const [key, raw] of Object.entries(values)) {
    const option = schema[key]
    if (Buffer.byteLength(raw, 'utf8') > PLUGIN_CONFIGURE_VALUE_MAX_BYTES) {
      throw new PluginConfigureRefusedError(
        `${configureOptionDisplayName(key, option)} is too long (over 64 KB).`,
        'plugin configure: option value over the size cap',
        key,
      )
    }
    if (/[\r\n]/.test(raw)) {
      throw new PluginConfigureRefusedError(
        `${configureOptionDisplayName(key, option)} must be a single line.`,
        'plugin configure: option value contains a line break',
        key,
      )
    }
    const trimmed = raw.trim()
    const saved = Object.hasOwn(savedValues, key) ? savedValues[key] : undefined
    if (
      trimmed === '' &&
      option?.required === true &&
      !(option.sensitive === true && saved !== undefined && saved !== '')
    ) {
      throw new PluginConfigureRefusedError(
        `${configureOptionDisplayName(key, option)} is required but not provided`,
        'plugin configure: required option blank',
        key,
      )
    }
    if (
      option?.type === 'boolean' &&
      trimmed !== '' &&
      parseBooleanValue(trimmed) === undefined
    ) {
      throw new PluginConfigureRefusedError(
        `${configureOptionDisplayName(key, option)} must be true or false (or 1/0, yes/no, on/off).`,
        'plugin configure: option value is not a boolean',
        key,
      )
    }
    // NUMBER branch staged — see file header (xkt message not recovered).
  }
}

// ---------------------------------------------------------------------------
// Display + JSON output (official Aa render paths)
// ---------------------------------------------------------------------------

/** Build one option row for the non-JSON display listing. */
export function buildConfigureOptionRow(
  pointer: string,
  key: string,
  option: ConfigureSchemaOption,
  configured: boolean,
): string {
  const flags = [
    option.required ? 'required' : 'optional',
    option.sensitive ? 'sensitive' : undefined,
    configured ? 'set' : 'not set',
  ]
    .filter(Boolean)
    .join(', ')
  const titleSuffix =
    option.title && option.title !== key ? ` — ${option.title}` : ''
  return `  ${pointer} ${key}${titleSuffix} (${flags})`
}

/**
 * Official display listing: the "no options" line, or the header + one row per
 * schema option + blank line + footer. `pointer` is the theme pointer glyph
 * (`J.pointer` in the official), injected so this stays pure/testable.
 */
export function buildConfigureDisplayLines(
  displayName: string,
  pluginId: string,
  schema: ConfigureSchema,
  configuredKeys: ReadonlyArray<string>,
  pointer: string,
): string[] {
  if (Object.keys(schema).length === 0) {
    return [`${displayName} (${pluginId}) has no options to set.`]
  }
  const lines = [`Options for ${displayName} (${pluginId}):`]
  for (const [key, option] of Object.entries(schema)) {
    lines.push(
      buildConfigureOptionRow(pointer, key, option, configuredKeys.includes(key)),
    )
  }
  lines.push('', PLUGIN_CONFIGURE_DISPLAY_FOOTER)
  return lines
}

/** Official refused JSON envelope (`--json` value-refused path). */
export function buildConfigureRefusedJson(
  pluginId: string,
  displayName: string,
  option: string | undefined,
  message: string,
): {
  pluginId: string
  displayName: string
  refused: { option: string | undefined; message: string }
} {
  return { pluginId, displayName, refused: { option, message } }
}

/** Official saved JSON envelope (`--json` values-stdin success path). */
export function buildConfigureSavedJson(
  pluginId: string,
  displayName: string,
  saved: ReadonlyArray<string>,
  unconfigured: ReadonlyArray<string> | undefined,
): Record<string, unknown> {
  return {
    pluginId,
    displayName,
    saved,
    ...(unconfigured === undefined ? {} : { unconfigured }),
  }
}

/** Official display JSON envelope (`--json` listing path). */
export function buildConfigureDisplayJson(
  pluginId: string,
  displayName: string,
  schema: ConfigureSchema,
  inputs: Record<string, unknown>,
  choices: Record<string, unknown>,
  configured: ReadonlyArray<string>,
  unconfigured: ReadonlyArray<string>,
): Record<string, unknown> {
  return {
    pluginId,
    displayName,
    schema,
    inputs,
    choices,
    configured,
    unconfigured,
  }
}
