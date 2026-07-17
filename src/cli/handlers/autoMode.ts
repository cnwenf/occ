/**
 * Auto mode subcommand handlers — dump default/merged classifier rules and
 * critique user-written rules. Dynamically imported when `claude auto-mode ...` runs.
 */

import { readFileSync } from 'node:fs'
import * as readline from 'node:readline/promises'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  type AutoModeRules,
  buildDefaultExternalSystemPrompt,
  getDefaultExternalAutoModeRules,
} from '../../utils/permissions/yoloClassifier.js'
import { logEvent } from '../../services/analytics/index.js'
import { plural } from '../../utils/stringUtils.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getSettingsFilePathForSource,
  parseSettingsFile,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { SettingsSchema, type SettingsJson } from '../../utils/settings/types.js'
import type { ValidationError } from '../../utils/settings/validation.js'
import { getAutoModeConfig } from '../../utils/settings/settings.js'
import { sideQuery } from '../../utils/sideQuery.js'

function writeRules(rules: AutoModeRules): void {
  process.stdout.write(jsonStringify(rules, null, 2) + '\n')
}

export function autoModeDefaultsHandler(): void {
  writeRules(getDefaultExternalAutoModeRules())
}

/**
 * Dump the effective auto mode config: user settings where provided, external
 * defaults otherwise. Per-section REPLACE semantics — matches how
 * buildYoloSystemPrompt resolves the external template (a non-empty user
 * section replaces that section's defaults entirely; an empty/absent section
 * falls through to defaults).
 */
export function autoModeConfigHandler(): void {
  const config = getAutoModeConfig()
  const defaults = getDefaultExternalAutoModeRules()
  writeRules({
    allow: config?.allow?.length ? config.allow : defaults.allow,
    soft_deny: config?.soft_deny?.length
      ? config.soft_deny
      : defaults.soft_deny,
    environment: config?.environment?.length
      ? config.environment
      : defaults.environment,
  })
}

const CRITIQUE_SYSTEM_PROMPT =
  'You are an expert reviewer of auto mode classifier rules for Claude Code.\n' +
  '\n' +
  'Claude Code has an "auto mode" that uses an AI classifier to decide whether ' +
  'tool calls should be auto-approved or require user confirmation. Users can ' +
  'write custom rules in three categories:\n' +
  '\n' +
  '- **allow**: Actions the classifier should auto-approve\n' +
  '- **soft_deny**: Actions the classifier should block (require user confirmation)\n' +
  "- **environment**: Context about the user's setup that helps the classifier make decisions\n" +
  '\n' +
  "Your job is to critique the user's custom rules for clarity, completeness, " +
  'and potential issues. The classifier is an LLM that reads these rules as ' +
  'part of its system prompt.\n' +
  '\n' +
  'For each rule, evaluate:\n' +
  '1. **Clarity**: Is the rule unambiguous? Could the classifier misinterpret it?\n' +
  "2. **Completeness**: Are there gaps or edge cases the rule doesn't cover?\n" +
  '3. **Conflicts**: Do any of the rules conflict with each other?\n' +
  '4. **Actionability**: Is the rule specific enough for the classifier to act on?\n' +
  '\n' +
  'Be concise and constructive. Only comment on rules that could be improved. ' +
  'If all rules look good, say so.'

export async function autoModeCritiqueHandler(options: {
  model?: string
}): Promise<void> {
  const config = getAutoModeConfig()
  const hasCustomRules =
    (config?.allow?.length ?? 0) > 0 ||
    (config?.soft_deny?.length ?? 0) > 0 ||
    (config?.environment?.length ?? 0) > 0

  if (!hasCustomRules) {
    process.stdout.write(
      'No custom auto mode rules found.\n\n' +
        'Add rules to your settings file under autoMode.{allow, soft_deny, environment}.\n' +
        'Run `claude auto-mode defaults` to see the default rules for reference.\n',
    )
    return
  }

  const model = options.model
    ? parseUserSpecifiedModel(options.model)
    : getMainLoopModel()

  const defaults = getDefaultExternalAutoModeRules()
  const classifierPrompt = buildDefaultExternalSystemPrompt()

  const userRulesSummary =
    formatRulesForCritique('allow', config?.allow ?? [], defaults.allow) +
    formatRulesForCritique(
      'soft_deny',
      config?.soft_deny ?? [],
      defaults.soft_deny,
    ) +
    formatRulesForCritique(
      'environment',
      config?.environment ?? [],
      defaults.environment,
    )

  process.stdout.write('Analyzing your auto mode rules…\n\n')

  let response
  try {
    response = await sideQuery({
      querySource: 'auto_mode_critique',
      model,
      system: CRITIQUE_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content:
            'Here is the full classifier system prompt that the auto mode classifier receives:\n\n' +
            '<classifier_system_prompt>\n' +
            classifierPrompt +
            '\n</classifier_system_prompt>\n\n' +
            "Here are the user's custom rules that REPLACE the corresponding default sections:\n\n" +
            userRulesSummary +
            '\nPlease critique these custom rules.',
        },
      ],
    })
  } catch (error) {
    process.stderr.write(
      'Failed to analyze rules: ' + errorMessage(error) + '\n',
    )
    process.exitCode = 1
    return
  }

  const textBlock = response.content.find(block => block.type === 'text')
  if (textBlock?.type === 'text') {
    process.stdout.write(textBlock.text + '\n')
  } else {
    process.stdout.write('No critique was generated. Please try again.\n')
  }
}

function formatRulesForCritique(
  section: string,
  userRules: string[],
  defaultRules: string[],
): string {
  if (userRules.length === 0) return ''
  const customLines = userRules.map(r => '- ' + r).join('\n')
  const defaultLines = defaultRules.map(r => '- ' + r).join('\n')
  return (
    '## ' +
    section +
    ' (custom rules replacing defaults)\n' +
    'Custom:\n' +
    customLines +
    '\n\n' +
    'Defaults being replaced:\n' +
    defaultLines +
    '\n\n'
  )
}

// ---------------------------------------------------------------------------
// `claude auto-mode reset` (CC 2.1.212)
//
// Restores the default auto-mode configuration by removing the `autoMode`
// section from the user settings file. Prompts for confirmation by default;
// `--yes` skips the prompt. Refuses a lossy auto-reset (`--yes`) when the
// settings file contains entries this version of Claude Code cannot parse —
// the user must run without `--yes` to review, or fix the entries first.
// Mirrors the official minified `MbS` (reset handler).
// ---------------------------------------------------------------------------

/** Outcome codes emitted with the `cli_auto_mode_reset` analytics event. */
type AutoModeResetOutcome =
  | 'no_user_settings_path'
  | 'settings_file_unreadable'
  | 'settings_file_invalid'
  | 'lossy_write_unconfirmed'
  | 'declined'
  | 'write_failed'
  | 'success'

/**
 * Injectable seams for the reset handler. Defaults call the real OCC
 * settings layer; tests substitute the boundary they need to control
 * (path resolution, raw read, write, or confirmation).
 */
export interface AutoModeResetDeps {
  /** Resolve the user settings file path. Returns undefined when unresolvable. */
  readonly resolvePath: () => string | undefined
  /**
   * Read raw file content. Returns null for a missing file (ENOENT).
   * Throws for genuine read errors (permissions, I/O).
   */
  readonly readRawFile: (path: string) => string | null
  /** Parse + validate a settings file. `settings` is null on failure. */
  readonly parseSettings: (
    path: string,
  ) => { settings: SettingsJson | null; errors: ValidationError[] }
  /** Detect unrecognized top-level keys in raw JSON content. */
  readonly detectUnrecognized: (content: string) => string[]
  /** Write the settings patch (removes autoMode). Returns error on failure. */
  readonly writeSettings: () => { error: Error | null }
  /** Confirmation prompt. Returns true to proceed. */
  readonly confirm: (message: string) => Promise<boolean>
}

/** Capture stdout writes so tests can assert on printed messages. */
type StdoutWriter = (message: string) => void

const defaultStdout: StdoutWriter = message => {
  process.stdout.write(message)
}

/**
 * Emit the `cli_auto_mode_reset` analytics event with an outcome code.
 * Mirrors the official `ib("cli_auto_mode_reset")` / outcome pattern.
 */
function emitResetMetric(outcome: AutoModeResetOutcome): void {
  logEvent('cli_auto_mode_reset', {
    outcome:
      outcome as unknown as Parameters<typeof logEvent>[1][string],
  })
}

/**
 * Format a settings-validation failure for the reset action. The official
 * delegates to a settings-error formatter keyed by path + action ("reset");
 * OCC has no such formatter, so this builds an equivalent concise message.
 */
function formatResetSettingsError(
  path: string,
  errors: ValidationError[],
): string {
  if (errors.length === 0) {
    return `Invalid settings in ${path}. Fix the errors before resetting auto mode.`
  }
  const lines = errors.map(
    e => `  - ${e.path || '(root)'}: ${e.message}`,
  )
  return `Invalid settings in ${path}:\n${lines.join('\n')}`
}

/**
 * Detect unrecognized top-level entries in raw settings JSON — keys this CLI
 * version cannot parse. The official's `validateSettingsFile` surfaces these
 * as severity="warning" errors; OCC's schema uses `.passthrough()` (preserves
 * unknown keys silently), so a strict parse is used to surface them. Matches
 * the official's lossy-write guard input.
 */
export function detectUnrecognizedEntries(content: string): string[] {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return []
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return []
  }
  const result = SettingsSchema()
    .strict()
    .safeParse(data)
  if (result.success) return []
  const entries: string[] = []
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as { keys?: string[] }).keys
      if (keys) for (const k of keys) entries.push(k)
    }
  }
  return entries
}

/**
 * Read the user settings file raw content. Returns null for a missing file
 * (ENOENT — treated as empty/defaults, not an error). Throws for genuine
 * read errors. Mirrors the official's `ar(c)` "is an actual error, not a
 * NotFound" check.
 */
function readUserSettingsRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return null
    throw error
  }
}

/** Default confirmation prompt via stdin (y/N). */
async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const answer = await rl.question(`${message} (y/N) `)
    const trimmed = answer.trim().toLowerCase()
    return trimmed === 'y' || trimmed === 'yes'
  } finally {
    rl.close()
  }
}

/** Default dependency wiring — calls the real OCC settings layer. */
export const defaultAutoModeResetDeps: AutoModeResetDeps = {
  resolvePath: () => getSettingsFilePathForSource('userSettings'),
  readRawFile: readUserSettingsRaw,
  parseSettings: path => parseSettingsFile(path),
  detectUnrecognized: detectUnrecognizedEntries,
  writeSettings: () =>
    updateSettingsForSource('userSettings', {
      autoMode: undefined,
    } as SettingsJson),
  confirm: defaultConfirm,
}

/**
 * `claude auto-mode reset` handler. Removes the `autoMode` section from the
 * user settings file, restoring defaults. See file-header comment for the
 * faithful outcome map.
 *
 * @param options.yes  Skip the confirmation prompt (refuses lossy writes).
 * @param deps         Injectable seams (tests substitute as needed).
 * @param stdout       Output sink (defaults to process.stdout).
 */
export async function autoModeResetHandler(
  options: { yes: boolean },
  deps: AutoModeResetDeps = defaultAutoModeResetDeps,
  stdout: StdoutWriter = defaultStdout,
): Promise<void> {
  // 1. Resolve the user settings file path.
  const path = deps.resolvePath()
  if (!path) {
    emitResetMetric('no_user_settings_path')
    stdout('Could not resolve the user settings file path.\n')
    return
  }

  // 2. Read raw content. Missing file = empty/defaults (not an error);
  //    a genuine read error is unrecoverable.
  let content: string | null
  try {
    content = deps.readRawFile(path)
  } catch (error) {
    emitResetMetric('settings_file_unreadable')
    stdout(`Could not read ${path}: ${errorMessage(error)}\n`)
    return
  }

  // 3. Parse + validate. A non-empty file that fails to parse is invalid.
  const hasContent = content !== null && content.trim() !== ''
  const parsed = hasContent ? deps.parseSettings(path) : null
  const settings = parsed?.settings ?? null
  if (hasContent && settings === null) {
    emitResetMetric('settings_file_invalid')
    stdout(formatResetSettingsError(path, parsed?.errors ?? []))
    return
  }

  // 4. If autoMode is absent, the config is already at defaults (success).
  const autoMode = settings
    ? (settings as Record<string, unknown>).autoMode
    : undefined
  if (autoMode === undefined) {
    stdout(
      `Auto mode configuration is already at defaults — ${path} has no autoMode section.\n`,
    )
    emitResetMetric('success')
    return
  }

  // 5. Detect unrecognized entries this CLI version cannot parse. These would
  //    be lost on a lossy write (the official re-serializes only known fields).
  const unrecognized = hasContent && content !== null
    ? deps.detectUnrecognized(content)
    : []

  // 6. Lossy-write guard: --yes must not silently drop unrecognized entries.
  if (unrecognized.length > 0 && options.yes) {
    emitResetMetric('lossy_write_unconfirmed')
    stdout(
      `Not resetting: ${path} also contains ${plural(
        unrecognized.length,
        'entry',
        'entries',
      )} this version of Claude Code cannot parse (${unrecognized.join(
        ', ',
      )}), and saving the file would delete ${
        unrecognized.length === 1 ? 'it' : 'them'
      } too. Fix or remove ${
        unrecognized.length === 1 ? 'that entry' : 'those entries'
      } first, or run the command without --yes to review and confirm.\n`,
    )
    return
  }

  // 7. Confirmation (skipped with --yes).
  if (!options.yes) {
    const confirmed = await deps.confirm(
      'Reset auto mode configuration to defaults?',
    )
    if (!confirmed) {
      emitResetMetric('declined')
      stdout('Aborted.\n')
      return
    }
  }

  // 8. Write — remove the autoMode section.
  const { error } = deps.writeSettings()
  if (error) {
    logError('auto-mode reset write failed: ' + error.message)
    emitResetMetric('write_failed')
    stdout(`Failed to reset auto mode: ${error.message}\n`)
    return
  }

  // 9. Success.
  emitResetMetric('success')
  stdout(
    `Auto mode configuration reset to defaults — autoMode section removed from ${path}.\nRun \`claude auto-mode config\` to see the effective rules.\n`,
  )
}
