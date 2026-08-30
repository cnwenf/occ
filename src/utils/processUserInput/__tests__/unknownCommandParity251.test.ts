import { beforeAll, describe, expect, test } from 'bun:test'
import { getCommands } from 'src/commands.js'
import type { Command } from 'src/commands.js'
import type { ProcessUserInputContext } from '../processUserInput.js'
import {
  damerauLevenshtein,
  findBestCommandSuggestion,
  looksLikeCommand,
  processSlashCommand,
  truncateForUnknownMessage,
} from '../processSlashCommand.js'

/**
 * Gap-110d (2.1.251, OCC-110): unknown slash-command message parity.
 * Byte-verified against the official 2.1.251 binary (minified `jee`/`zee`,
 * recovered verbatim) — ONE code path for both interactive (REPL) and
 * non-interactive (-p) sessions:
 *   `Unknown command: /${name}. Did you mean /${suggestion}?` when a visible
 *   command name/alias is within Damerau-Levenshtein distance ≤2, else
 *   `Unknown command: /${name}`. The suggestion is the BEST match (strictly
 *   lowest distance, first wins ties) — NOT the first candidate within the
 *   threshold. Live-verified in the official 2.1.251 REPL:
 *   `/definitely-not-a-cmd` → no suggestion; `/hel` → "Did you mean /help?"
 *   (distance 1 beats the earlier-registered `/new` at distance 2).
 */

let realCommands: Command[] = []

beforeAll(async () => {
  realCommands = await getCommands(process.cwd())
})

function minimalContext(overrides: Record<string, unknown> = {}) {
  return {
    options: { commands: realCommands, ...overrides },
  } as unknown as ProcessUserInputContext
}

const NOOP_SET_TOOL_JSX = () => {}

async function unknownCommandResultText(
  input: string,
  overrides: Record<string, unknown> = {},
): Promise<string | undefined> {
  const result = await processSlashCommand(
    input,
    [],
    [],
    [],
    minimalContext(overrides),
    NOOP_SET_TOOL_JSX,
  )
  return result.resultText
}

describe('2.1.251 unknown slash-command message (Gap-110d)', () => {
  test('unknown command keeps the leading slash: "Unknown command: /<name>"', async () => {
    const text = await unknownCommandResultText('/definitely-not-a-cmd')
    expect(text).toBe('Unknown command: /definitely-not-a-cmd')
  })

  test('best match wins: /hel suggests /help (distance 1), not /new (distance 2)', async () => {
    const text = await unknownCommandResultText('/hel')
    expect(text).toBe('Unknown command: /hel. Did you mean /help?')
  })

  test('another distance-1 typo resolves its suggestion', async () => {
    const text = await unknownCommandResultText('/statu')
    expect(text).toBe('Unknown command: /statu. Did you mean /status?')
  })

  test('non-interactive (-p) uses the SAME message — one code path', async () => {
    const text = await unknownCommandResultText('/definitely-not-a-cmd', {
      isNonInteractiveSession: true,
    })
    expect(text).toBe('Unknown command: /definitely-not-a-cmd')
  })
})

describe('findBestCommandSuggestion — official jee() semantics (Gap-110d)', () => {
  test('strictly lowest distance wins regardless of candidate order', () => {
    // "new" is listed first and within distance 2, but "help" is closer.
    const candidates = ['new', 'help', 'status']
    expect(findBestCommandSuggestion('hel', candidates, 2)).toBe('help')
  })

  test('ties keep the first candidate', () => {
    const candidates = ['cat', 'bat']
    expect(findBestCommandSuggestion('hat', candidates, 2)).toBe('cat')
  })

  test('candidates with length difference > maxEditDistance are skipped', () => {
    // "clear" differs from "cl" by 3 → skipped even though it shares a prefix.
    expect(findBestCommandSuggestion('cl', ['clear', 'cd'], 2)).toBe('cd')
  })

  test('returns undefined when nothing is within the threshold', () => {
    expect(
      findBestCommandSuggestion('definitely-not-a-cmd', ['help', 'status'], 2),
    ).toBeUndefined()
  })
})

describe('damerauLevenshtein — official zee() semantics (Gap-110d)', () => {
  test('identical strings are distance 0', () => {
    expect(damerauLevenshtein('help', 'help')).toBe(0)
  })

  test('adjacent transposition costs 1 (Damerau, not plain Levenshtein)', () => {
    // hlep → help: plain Levenshtein is 2, Damerau counts the swap as 1.
    expect(damerauLevenshtein('hlep', 'help')).toBe(1)
  })

  test('single substitution is distance 1', () => {
    expect(damerauLevenshtein('hel', 'new')).toBe(2)
    expect(damerauLevenshtein('status', 'statu')).toBe(1)
  })
})

describe('truncateForUnknownMessage — official Tr() observable surface (Gap-110d)', () => {
  test('values within the limit pass through unchanged', () => {
    expect(truncateForUnknownMessage('status', 512)).toBe('status')
  })

  test('overlong values are cut with a trailing ellipsis', () => {
    const long = 'a'.repeat(600)
    expect(truncateForUnknownMessage(long, 512)).toBe(`${'a'.repeat(512)}…`)
  })
})

describe('looksLikeCommand gate (Gap-110d)', () => {
  test('command-shaped names pass', () => {
    expect(looksLikeCommand('help')).toBe(true)
    expect(looksLikeCommand('my-command')).toBe(true)
    expect(looksLikeCommand('ns:cmd_2')).toBe(true)
  })

  test('file-path-shaped input does not pass (falls through to prompt)', () => {
    expect(looksLikeCommand('some/file')).toBe(false)
    expect(looksLikeCommand('has space')).toBe(false)
    expect(looksLikeCommand('path.ts')).toBe(false)
  })
})
