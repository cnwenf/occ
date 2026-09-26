import { plural } from '../utils/stringUtils.js'
import { chordToString, parseChord, parseKeystroke } from './parser.js'
import {
  getReservedShortcuts,
  normalizeKeyForComparison,
} from './reservedShortcuts.js'
import type {
  KeybindingBlock,
  KeybindingContextName,
  ParsedBinding,
} from './types.js'

/**
 * Types of validation issues that can occur with keybindings.
 */
export type KeybindingWarningType =
  | 'parse_error'
  | 'duplicate'
  | 'reserved'
  | 'invalid_context'
  | 'invalid_action'

/**
 * A warning or error about a keybinding configuration issue.
 */
export type KeybindingWarning = {
  type: KeybindingWarningType
  severity: 'error' | 'warning'
  message: string
  key?: string
  context?: string
  action?: string
  suggestion?: string
}

/**
 * Type guard to check if an object is a valid KeybindingBlock.
 */
function isKeybindingBlock(obj: unknown): obj is KeybindingBlock {
  if (typeof obj !== 'object' || obj === null) return false
  const b = obj as Record<string, unknown>
  return (
    typeof b.context === 'string' &&
    typeof b.bindings === 'object' &&
    b.bindings !== null
  )
}

/**
 * Type guard to check if an array contains only valid KeybindingBlocks.
 */
function isKeybindingBlockArray(arr: unknown): arr is KeybindingBlock[] {
  return Array.isArray(arr) && arr.every(isKeybindingBlock)
}

/**
 * Valid context names for keybindings.
 * Must match KeybindingContextName in types.ts
 */
const VALID_CONTEXTS: KeybindingContextName[] = [
  'Global',
  'Chat',
  'Autocomplete',
  'Confirmation',
  'Help',
  'Transcript',
  'HistorySearch',
  'Task',
  'ThemePicker',
  'Settings',
  'Tabs',
  'Attachments',
  'Footer',
  'MessageSelector',
  'DiffDialog',
  'ModelPicker',
  'Select',
  'Plugin',
]

/**
 * Type guard to check if a string is a valid context name.
 */
function isValidContext(value: string): value is KeybindingContextName {
  return (VALID_CONTEXTS as readonly string[]).includes(value)
}

/**
 * 2.1.283 (OCC-138 / G2): modifier metadata for the misspelled-modifier
 * validator. Byte-verified against the official v2.1.283 ELF keybindings
 * chunk (`ce` / `Ie` @210292592-region companion definitions):
 *   ce = [{name:"ctrl",aliases:["control"]},{name:"alt",aliases:["opt","option"]},
 *         {name:"shift"},{name:"meta"},{name:"cmd",aliases:["command","super","win"]}]
 *   Ie = ["ctrl","alt","shift","meta","super"]
 */
type ModifierDefinition = { name: string; aliases?: string[] }

const MODIFIER_DEFINITIONS: ModifierDefinition[] = [
  { name: 'ctrl', aliases: ['control'] },
  { name: 'alt', aliases: ['opt', 'option'] },
  { name: 'shift' },
  { name: 'meta' },
  { name: 'cmd', aliases: ['command', 'super', 'win'] },
]

/** ParsedKeystroke boolean flags checked for an already-set modifier. */
const MODIFIER_FLAGS = ['ctrl', 'alt', 'shift', 'meta', 'super'] as const

/**
 * Damerau-Levenshtein distance (transposition-aware). Official 283 `_6`,
 * byte-for-byte logic from the ELF @196737282 region.
 */
function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0
  const aLen = a.length
  const bLen = b.length
  const d: number[][] = Array.from({ length: aLen + 1 }, (_, i) =>
    Array.from({ length: bLen + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      )
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[aLen][bLen]
}

/**
 * Closest modifier name/alias within maxEditDistance, or undefined.
 * Official 283 `CJ` (flattens names+aliases, length-diff prefilter, strict
 * `<` best-distance comparison so the FIRST closest candidate wins).
 */
function closestModifierMatch(
  input: string,
  maxEditDistance = 1,
): string | undefined {
  const candidates = MODIFIER_DEFINITIONS.flatMap(m => [
    m.name,
    ...(m.aliases ?? []),
  ])
  let best: string | undefined
  let bestDistance = maxEditDistance + 1
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - input.length) > maxEditDistance) continue
    const distance = damerauLevenshtein(input, candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

/**
 * Validate a single key (chord) string and return any parse errors.
 *
 * 2.1.283 (OCC-138 / G2): faithful port of the official `Me(e,r)` validator
 * (byte-extracted from the v2.1.283 ELF keybindings chunk). Replaces the
 * 2.1.282 `Se(e)` empty-part-only check (which OCC had extended with an
 * unreachable "Could not parse keystroke" branch — the official has no such
 * message and parseKeystroke's default branch makes the condition dead code).
 *
 * Behavior: after the unchanged empty-part check, each whitespace-separated
 * keystroke is scanned for tokens BEFORE the real key that parse as a key
 * (i.e. are not modifiers) — a misspelled modifier like `ctl+k` or two keys
 * joined with `+` instead of a space like `k+s`. Misplaced tokens are
 * fuzzy-matched (Damerau-Levenshtein, distance ≤1) against the modifier
 * names/aliases; when every one matches, the suggestion is the rebuilt
 * binding (`Did you mean "ctrl+k"?`), otherwise the generic space-vs-plus
 * guidance. `context` (official `r`) is woven into the message as ` in X`.
 */
function validateKeystroke(
  keystroke: string,
  context?: string,
): KeybindingWarning | null {
  const parts = keystroke.toLowerCase().split('+')

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) {
      return {
        type: 'parse_error',
        severity: 'error',
        message: `Empty key part in "${keystroke}"`,
        key: keystroke,
        suggestion: 'Remove extra "+" characters',
      }
    }
  }

  const misplaced: string[] = []
  const rebuiltGroups: string[] = []
  let allFuzzyMatched = true

  for (const keystrokePart of keystroke.trim().split(/\s+/)) {
    const tokens = keystrokePart.split('+')
    const realKeyIndex = tokens.findLastIndex(
      token => parseKeystroke(token).key !== '',
    )
    const group: string[] = []
    for (const [index, token] of tokens.entries()) {
      if (index === realKeyIndex || parseKeystroke(token).key === '') {
        group.push(token)
        continue
      }
      misplaced.push(token)
      const match = closestModifierMatch(token.toLowerCase())
      const combined = parseKeystroke([keystrokePart, ...group].join('+'))
      if (match === undefined) {
        allFuzzyMatched = false
      } else if (
        !MODIFIER_FLAGS.some(
          flag => combined[flag] && parseKeystroke(match)[flag],
        )
      ) {
        group.push(match)
      }
    }
    rebuiltGroups.push(group.join('+'))
  }

  if (misplaced.length === 0) return null

  const uniqueMisplaced = [...new Set(misplaced)]
  const badList = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    uniqueMisplaced.map(token => `"${token}"`),
  )
  const modifierNames = new Intl.ListFormat('en', {
    type: 'disjunction',
  }).format(MODIFIER_DEFINITIONS.map(m => m.name))
  const copula =
    uniqueMisplaced.length === 1 ? 'is not a modifier' : 'are not modifiers'
  const contextSuffix = context ? ` in ${context}` : ''

  return {
    type: 'parse_error',
    severity: 'error',
    message: `${badList} ${copula}, so "${keystroke}"${contextSuffix} applies to "${chordToString(parseChord(keystroke))}" instead`,
    key: keystroke,
    suggestion: allFuzzyMatched
      ? `Did you mean "${rebuiltGroups.join(' ')}"?`
      : `Use ${modifierNames} before "+"; for keys pressed one after another, put a space between them, as in "ctrl+x ctrl+s"`,
  }
}

/**
 * Validate a keybinding block from user config.
 */
function validateBlock(
  block: unknown,
  blockIndex: number,
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  if (typeof block !== 'object' || block === null) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Keybinding block ${blockIndex + 1} is not an object`,
    })
    return warnings
  }

  const b = block as Record<string, unknown>

  // Validate context - extract to narrowed variable for type safety
  const rawContext = b.context
  let contextName: string | undefined
  if (typeof rawContext !== 'string') {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Keybinding block ${blockIndex + 1} missing "context" field`,
    })
  } else if (!isValidContext(rawContext)) {
    warnings.push({
      type: 'invalid_context',
      severity: 'error',
      message: `Unknown context "${rawContext}"`,
      context: rawContext,
      suggestion: `Valid contexts: ${VALID_CONTEXTS.join(', ')}`,
    })
  } else {
    contextName = rawContext
  }

  // Validate bindings
  if (typeof b.bindings !== 'object' || b.bindings === null) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Keybinding block ${blockIndex + 1} missing "bindings" field`,
    })
    return warnings
  }

  const bindings = b.bindings as Record<string, unknown>
  for (const [key, action] of Object.entries(bindings)) {
    // Validate key syntax (official 283 Oe: `Me(k, d)` then `w.context = d`)
    const keyError = validateKeystroke(key, contextName)
    if (keyError) {
      keyError.context = contextName
      warnings.push(keyError)
    }

    // Validate action
    if (action !== null && typeof action !== 'string') {
      warnings.push({
        type: 'invalid_action',
        severity: 'error',
        message: `Invalid action for "${key}": must be a string or null`,
        key,
        context: contextName,
      })
    } else if (typeof action === 'string' && action.startsWith('command:')) {
      // Validate command binding format
      if (!/^command:[a-zA-Z0-9:\-_]+$/.test(action)) {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Invalid command binding "${action}" for "${key}": command name may only contain alphanumeric characters, colons, hyphens, and underscores`,
          key,
          context: contextName,
          action,
        })
      }
      // Command bindings must be in Chat context
      if (contextName && contextName !== 'Chat') {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Command binding "${action}" must be in "Chat" context, not "${contextName}"`,
          key,
          context: contextName,
          action,
          suggestion: 'Move this binding to a block with "context": "Chat"',
        })
      }
    } else if (action === 'voice:pushToTalk') {
      // Hold detection needs OS auto-repeat. Bare letters print into the
      // input during warmup and the activation strip is best-effort —
      // space (default) or a modifier combo like meta+k avoid that.
      const ks = parseChord(key)[0]
      if (
        ks &&
        !ks.ctrl &&
        !ks.alt &&
        !ks.shift &&
        !ks.meta &&
        !ks.super &&
        /^[a-z]$/.test(ks.key)
      ) {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Binding "${key}" to voice:pushToTalk prints into the input during warmup; use space or a modifier combo like meta+k`,
          key,
          context: contextName,
          action,
        })
      }
    }
  }

  return warnings
}

/**
 * Detect duplicate keys within the same bindings block in a JSON string.
 * JSON.parse silently uses the last value for duplicate keys,
 * so we need to check the raw string to warn users.
 *
 * Only warns about duplicates within the same context's bindings object.
 * Duplicates across different contexts are allowed (e.g., "enter" in Chat
 * and "enter" in Confirmation).
 */
export function checkDuplicateKeysInJson(
  jsonString: string,
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  // Find each "bindings" block and check for duplicates within it
  // Pattern: "bindings" : { ... }
  const bindingsBlockPattern =
    /"bindings"\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g

  let blockMatch
  while ((blockMatch = bindingsBlockPattern.exec(jsonString)) !== null) {
    const blockContent = blockMatch[1]
    if (!blockContent) continue

    // Find the context for this block by looking backwards
    const textBeforeBlock = jsonString.slice(0, blockMatch.index)
    const contextMatch = textBeforeBlock.match(
      /"context"\s*:\s*"([^"]+)"[^{]*$/,
    )
    const context = contextMatch?.[1] ?? 'unknown'

    // Find all keys within this bindings block
    const keyPattern = /"([^"]+)"\s*:/g
    const keysByName = new Map<string, number>()

    let keyMatch
    while ((keyMatch = keyPattern.exec(blockContent)) !== null) {
      const key = keyMatch[1]
      if (!key) continue

      const count = (keysByName.get(key) ?? 0) + 1
      keysByName.set(key, count)

      if (count === 2) {
        // Only warn on the second occurrence
        warnings.push({
          type: 'duplicate',
          severity: 'warning',
          message: `Duplicate key "${key}" in ${context} bindings`,
          key,
          context,
          suggestion: `This key appears multiple times in the same context. JSON uses the last value, earlier values are ignored.`,
        })
      }
    }
  }

  return warnings
}

/**
 * Validate user keybinding config and return all warnings.
 */
export function validateUserConfig(userBlocks: unknown): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  if (!Array.isArray(userBlocks)) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: 'keybindings.json must contain an array',
      suggestion: 'Wrap your bindings in [ ]',
    })
    return warnings
  }

  for (let i = 0; i < userBlocks.length; i++) {
    warnings.push(...validateBlock(userBlocks[i], i))
  }

  return warnings
}

/**
 * Check for duplicate bindings within the same context.
 * Only checks user bindings (not default + user merged).
 */
export function checkDuplicates(
  blocks: KeybindingBlock[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const seenByContext = new Map<string, Map<string, string>>()

  for (const block of blocks) {
    const contextMap =
      seenByContext.get(block.context) ?? new Map<string, string>()
    seenByContext.set(block.context, contextMap)

    for (const [key, action] of Object.entries(block.bindings)) {
      const normalizedKey = normalizeKeyForComparison(key)
      const existingAction = contextMap.get(normalizedKey)

      if (existingAction && existingAction !== action) {
        warnings.push({
          type: 'duplicate',
          severity: 'warning',
          message: `Duplicate binding "${key}" in ${block.context} context`,
          key,
          context: block.context,
          action: (action as string) ?? 'null (unbind)',
          suggestion: `Previously bound to "${existingAction}". Only the last binding will be used.`,
        })
      }

      contextMap.set(normalizedKey, (action as string) ?? 'null')
    }
  }

  return warnings
}

/**
 * Check for reserved shortcuts that may not work.
 */
export function checkReservedShortcuts(
  bindings: ParsedBinding[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const reserved = getReservedShortcuts()

  for (const binding of bindings) {
    const keyDisplay = chordToString(binding.chord)
    const normalizedKey = normalizeKeyForComparison(keyDisplay)

    // Check against reserved shortcuts
    for (const res of reserved) {
      if (normalizeKeyForComparison(res.key) === normalizedKey) {
        warnings.push({
          type: 'reserved',
          severity: res.severity,
          message: `"${keyDisplay}" may not work: ${res.reason}`,
          key: keyDisplay,
          context: binding.context,
          action: binding.action ?? undefined,
        })
      }
    }
  }

  return warnings
}

/**
 * Parse user blocks into bindings for validation.
 * This is separate from the main parser to avoid importing it.
 */
function getUserBindingsForValidation(
  userBlocks: KeybindingBlock[],
): ParsedBinding[] {
  const bindings: ParsedBinding[] = []
  for (const block of userBlocks) {
    for (const [key, action] of Object.entries(block.bindings)) {
      const chord = key.split(' ').map(k => parseKeystroke(k))
      bindings.push({
        chord,
        action,
        context: block.context,
      })
    }
  }
  return bindings
}

/**
 * Run all validations and return combined warnings.
 */
export function validateBindings(
  userBlocks: unknown,
  _parsedBindings: ParsedBinding[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  // Validate user config structure
  warnings.push(...validateUserConfig(userBlocks))

  // Check for duplicates in user config
  if (isKeybindingBlockArray(userBlocks)) {
    warnings.push(...checkDuplicates(userBlocks))

    // Check for reserved/conflicting shortcuts - only check USER bindings
    const userBindings = getUserBindingsForValidation(userBlocks)
    warnings.push(...checkReservedShortcuts(userBindings))
  }

  // Deduplicate warnings (same key+context+type)
  const seen = new Set<string>()
  return warnings.filter(w => {
    const key = `${w.type}:${w.key}:${w.context}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Format a warning for display to the user.
 */
export function formatWarning(warning: KeybindingWarning): string {
  const icon = warning.severity === 'error' ? '✗' : '⚠'
  let msg = `${icon} Keybinding ${warning.severity}: ${warning.message}`

  if (warning.suggestion) {
    msg += `\n  ${warning.suggestion}`
  }

  return msg
}

/**
 * Format multiple warnings for display.
 */
export function formatWarnings(warnings: KeybindingWarning[]): string {
  if (warnings.length === 0) return ''

  const errors = warnings.filter(w => w.severity === 'error')
  const warns = warnings.filter(w => w.severity === 'warning')

  const lines: string[] = []

  if (errors.length > 0) {
    lines.push(
      `Found ${errors.length} keybinding ${plural(errors.length, 'error')}:`,
    )
    for (const e of errors) {
      lines.push(formatWarning(e))
    }
  }

  if (warns.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(
      `Found ${warns.length} keybinding ${plural(warns.length, 'warning')}:`,
    )
    for (const w of warns) {
      lines.push(formatWarning(w))
    }
  }

  return lines.join('\n')
}
