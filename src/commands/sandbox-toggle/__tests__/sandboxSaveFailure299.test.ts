import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * PORT TEST (CC 2.1.299, gap entry #040): /sandbox must not report success
 * when the settings save failed.
 *
 * Official v299 byte-exact references (linux-x64 ELF, strings/dd only):
 *   - `qeo` @227983933 (NEW in v299; 0 hits in v296):
 *       "✗ Sandbox settings not changed: "
 *   - formatter `v({error}, successText)` @255246300 region: error === null →
 *     success text; else unwrap `error.cause instanceof Error ? cause : error`,
 *     errno via `E(d)`, path `hn("localSettings") ?? ".claude/settings.local.json"`,
 *     errno ∈ {EACCES, EPERM, EROFS} (`Do`) appends
 *     " Start Claude Code in a project folder you can write to."
 *   - success strings (OCC already byte-matched): "✓ Sandbox enabled with
 *     auto-allow for bash commands" / "✓ Sandbox enabled with regular bash
 *     permissions" / "○ Sandbox disabled".
 *
 * Cross-agent note: src/utils/sandbox/sandbox-adapter.ts is owned by another
 * concurrent agent — NOT edited here. Its setSandboxSettings currently returns
 * Promise<void> and addToExcludedCommands returns {outcome,...}; both discard
 * the updateSettingsForSource `{error}` result. The production code consumes
 * results DEFENSIVELY (undefined / missing .error / {error:null} → success),
 * and this suite mocks the adapter seam to prove that WHEN the adapter
 * surfaces `{error}`, the ✗ message is printed and the success message is not.
 *
 * Mock.module hygiene per OCC-97: snapshot real namespaces into plain objects
 * BEFORE any mock.module call, restore in afterAll.
 */

// --- Mocks -------------------------------------------------------------------

const actualSettingsModule = await import('../../../utils/settings/settings.js')
const actualSettingsExports = { ...actualSettingsModule }
const actualAdapterModule = await import('../../../utils/sandbox/sandbox-adapter.js')
const actualAdapterExports = { ...actualAdapterModule }

let excludeResult: unknown = { outcome: 'added', settingsSource: 'localSettings' }

mock.module('../../../utils/settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => ({}),
}))
mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
  ...actualAdapterExports,
  addToExcludedCommands: () => excludeResult,
  SandboxManager: {
    ...actualAdapterExports.SandboxManager,
    isSupportedPlatform: () => true,
    isPlatformInEnabledList: () => true,
    areSandboxSettingsLockedByPolicy: () => false,
    checkDependencies: () => ({ errors: [], warnings: [] }),
  },
}))

const { call } = await import('../sandbox-toggle.js')
const {
  SANDBOX_SETTINGS_NOT_CHANGED_PREFIX,
  extractSandboxSaveError,
  formatSandboxSaveFailure,
  formatSandboxSaveResult,
  visualizeWhitespace,
  wrapInBackticks,
} = await import('../sandboxSaveFailure.js')

afterAll(() => {
  mock.module('../../../utils/settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
  mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
    ...actualAdapterExports,
  }))
})

beforeEach(() => {
  excludeResult = { outcome: 'added', settingsSource: 'localSettings' }
})

const errnoError = (code: string, message = 'write failed'): Error => {
  const err = new Error(message) as Error & { code?: string }
  err.code = code
  return err
}

// --- Pure formatter (official v() / Ky / Vc semantics) -----------------------

describe('formatSandboxSaveResult — official v() success/failure split', () => {
  test('void result (current Promise<void> adapter API) → success text passthrough', () => {
    expect(
      formatSandboxSaveResult(undefined, '✓ Sandbox enabled with regular bash permissions'),
    ).toBe('✓ Sandbox enabled with regular bash permissions')
  })

  test('{error: null} result (updateSettingsForSource shape) → success text', () => {
    expect(formatSandboxSaveResult({ error: null }, '○ Sandbox disabled')).toBe(
      '○ Sandbox disabled',
    )
  })

  test('result without .error (e.g. {outcome:"added"}) → success text', () => {
    expect(
      formatSandboxSaveResult({ outcome: 'added' }, '✓ Sandbox disabled'),
    ).toBe('✓ Sandbox disabled')
  })

  test('failing save → honest ✗ message, success text NOT returned', () => {
    const out = formatSandboxSaveResult(
      { error: errnoError('EACCES', 'permission denied') },
      '✓ Sandbox enabled with auto-allow for bash commands',
    )
    expect(out).toContain(SANDBOX_SETTINGS_NOT_CHANGED_PREFIX)
    expect(out).not.toContain('✓')
    expect(out).toContain("couldn't be updated")
  })
})

describe('formatSandboxSaveFailure — byte-exact official message shape', () => {
  test('prefix is byte-exact "✗ Sandbox settings not changed: " (qeo @227983933)', () => {
    expect(SANDBOX_SETTINGS_NOT_CHANGED_PREFIX).toBe(
      '✗ Sandbox settings not changed: ',
    )
    const out = formatSandboxSaveFailure(new Error('boom'))
    expect(out.startsWith('✗ Sandbox settings not changed: ')).toBe(true)
  })

  test('EACCES/EPERM/EROFS append the writable-folder hint (official Do set)', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      const out = formatSandboxSaveFailure(errnoError(code))
      expect(out).toContain(
        ' Start Claude Code in a project folder you can write to.',
      )
      expect(out).toContain(wrapInBackticks(code))
    }
  })

  test('other errno codes get no hint but still show the errno as reason', () => {
    const out = formatSandboxSaveFailure(errnoError('ENOSPC', 'no space left'))
    expect(out).not.toContain('Start Claude Code in a project folder')
    expect(out).toContain(wrapInBackticks('ENOSPC'))
  })

  test('error without errno falls back to the message as reason', () => {
    const out = formatSandboxSaveFailure(new Error('disk exploded'))
    expect(out).toContain(wrapInBackticks('disk exploded'))
    expect(out).toContain("couldn't be updated")
  })

  test('error.cause is unwrapped when it is an Error (official d = f.cause ?? f)', () => {
    const outer = new Error('wrapper')
    outer.cause = errnoError('EPERM', 'inner denied')
    const out = formatSandboxSaveFailure(outer)
    expect(out).toContain(wrapInBackticks('EPERM'))
    expect(out).toContain('Start Claude Code in a project folder you can write to.')
    expect(out).not.toContain('wrapper')
  })

  test('non-Error cause is ignored (official instanceof check)', () => {
    const outer = new Error('kept')
    outer.cause = 'string cause'
    const out = formatSandboxSaveFailure(outer)
    expect(out).toContain(wrapInBackticks('kept'))
  })

  test('non-Error thrown values are stringified, never crash', () => {
    const out = formatSandboxSaveFailure('raw string failure')
    expect(out).toContain(wrapInBackticks('raw string failure'))
  })

  test('settings path is backtick-wrapped and resolves to the localSettings file', () => {
    const out = formatSandboxSaveFailure(new Error('boom'))
    const expectedPath =
      actualSettingsExports.getSettingsFilePathForSource('localSettings') ??
      '.claude/settings.local.json'
    expect(out).toContain(wrapInBackticks(expectedPath))
    expect(expectedPath.endsWith('.claude/settings.local.json')).toBe(true)
  })
})

describe('wrapInBackticks — faithful Ky port', () => {
  test('simple payload gets single-backtick fence', () => {
    expect(wrapInBackticks('EACCES')).toBe('`EACCES`')
  })

  test('empty string maps to "` `" (official special case)', () => {
    expect(wrapInBackticks('')).toBe('` `')
  })

  test('payload containing backticks gets a longer fence', () => {
    expect(wrapInBackticks('a``b')).toBe('```a``b```')
  })

  test('payload starting/ending with a backtick gets space padding', () => {
    expect(wrapInBackticks('`x')).toBe('`` `x ``')
  })

  test('newlines collapse to spaces before fencing', () => {
    expect(wrapInBackticks('a\r\nb\rc\nd')).toBe('`a b c d`')
  })
})

describe('visualizeWhitespace — Vc port (KU grapheme visualizer omitted)', () => {
  test('newline → ␤ and tab → ␉', () => {
    expect(visualizeWhitespace('a\nb\tc')).toBe('a␤b␉c')
  })

  test('clean ASCII paths are unchanged', () => {
    expect(visualizeWhitespace('.claude/settings.local.json')).toBe(
      '.claude/settings.local.json',
    )
  })
})

describe('extractSandboxSaveError — defensive result consumption', () => {
  test('undefined / null / non-object / missing .error / {error:null} → null (success)', () => {
    expect(extractSandboxSaveError(undefined)).toBeNull()
    expect(extractSandboxSaveError(null)).toBeNull()
    expect(extractSandboxSaveError('string')).toBeNull()
    expect(extractSandboxSaveError({ outcome: 'added' })).toBeNull()
    expect(extractSandboxSaveError({ error: null })).toBeNull()
  })

  test('{error: Error} → the Error itself', () => {
    const err = new Error('save failed')
    expect(extractSandboxSaveError({ error: err })).toBe(err)
  })

  test('{error: non-Error} → wrapped Error', () => {
    const wrapped = extractSandboxSaveError({ error: 'weird' })
    expect(wrapped).toBeInstanceOf(Error)
    expect(wrapped?.message).toBe('weird')
  })
})

// --- Command level: /sandbox exclude with a failing save ---------------------

describe('/sandbox exclude — failing save prints ✗ error, never success', () => {
  const runExclude = async (pattern: string): Promise<string[]> => {
    const output: string[] = []
    await call(
      (msg?: string) => {
        if (msg !== undefined) output.push(msg)
      },
      {},
      `exclude ${pattern}`,
    )
    return output
  }

  test('adapter result carrying {error} → ✗ message printed, success NOT printed', async () => {
    excludeResult = {
      outcome: 'added',
      settingsSource: 'localSettings',
      error: errnoError('EACCES', 'permission denied'),
    }
    const output = await runExclude('"npm run test:*"')
    const text = output.join('\n')
    expect(text).toContain('✗ Sandbox settings not changed: ')
    expect(text).toContain("couldn't be updated")
    expect(text).toContain('Start Claude Code in a project folder you can write to.')
    expect(text).not.toContain('Added "npm run test:*" to excluded commands')
  })

  test('adapter result without error → success message printed (unchanged behavior)', async () => {
    const output = await runExclude('"npm run test:*"')
    const text = output.join('\n')
    expect(text).toContain('Added "npm run test:*" to excluded commands')
    expect(text).not.toContain('✗')
  })

  test('refused outcome still short-circuits before the save-error check', async () => {
    excludeResult = { outcome: 'refused', commandPattern: 'x' }
    const output = await runExclude('x')
    const text = output.join('\n')
    expect(text).toContain('was not added to excluded commands')
    expect(text).not.toContain('✗ Sandbox settings not changed')
  })
})
