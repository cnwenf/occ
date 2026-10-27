import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { getEmptyToolPermissionContext } from '../../../../Tool.js'
import * as realLog from '../../../../utils/log.js'
import { permissionRuleValueToString } from '../../../../utils/permissions/permissionRuleParser.js'
import * as realPermissions from '../../../../utils/permissions/permissions.js'
import {
  drainScreenReaderAnnouncements,
  resetScreenReaderAnnouncements,
} from '../../../../utils/screenReader.js'

/**
 * v2.1.311 PORT #61 — permission-rule delete announces immediately to screen
 * readers (0→2 occurrences of each bracketed string; v2.1.310 has NONE).
 *
 * Byte-forensics on the official linux-x64 ELFs (/tmp/cc-diff-311):
 *
 * - `[Deleted ` — v311 ×2 @129910068 (string table) + @284334717 (code);
 *   v310 ×0.
 * - `[Could not delete ` — v311 ×2 @129910104 + @284334851; v310 ×0.
 * - Delete handler @284334700 (raw dd dump):
 *     ...bold(Ci)}]),K0(`[Deleted ${hu} rule ${yu}]`)}).catch(($h)=>{
 *       l($h),
 *       A((Bh)=>[...Bh,`Could not delete ${he.bold(Ci)} — the rule is unchanged`]),
 *       K0(`[Could not delete ${yu} — the rule is unchanged]`)}),
 *     ge(void 0)
 *   K0=pushScreenReaderAnnouncement, A=setChanges (buffered visual messages),
 *   he=chalk, l=error logger, ge=setSelectedRule(undefined) — synchronous
 *   after attaching .then/.catch (comma operator). Ci = display rule value,
 *   yu = PLAIN (unstyled) value: SR brackets carry the plain string; only the
 *   visual message is bold.
 * - The em dash is the `—` escape in the binary's template literals —
 *   runtime string U+2014 "—", mirrored as a literal em dash in TS source.
 *
 * OCC: the official chain lives inline in PermissionRuleList's memoized
 * handleDeleteRule closure; OCC extracts it verbatim into an exported
 * `runPermissionRuleDelete` helper (same file — behavior identical, testable
 * without an AppState render harness). The success visual message MOVES into
 * `.then` (official ordering) and a failure visual message is ADDED
 * (official `.catch` buffers one; v310/OCC-pre had none).
 */

// Leak-safe mock.module (settingSourcesPropagation281 pattern): the real
// exports are captured BY VALUE before the override, and the patched function
// delegates to the real one once `mockActive` flips false — bun's live-binding
// patching defeats re-spread restore, so delegation is the restore.
const realDeletePermissionRule = realPermissions.deletePermissionRule
type DeleteArgs = Parameters<typeof realDeletePermissionRule>[0]
let deleteImpl: (args: DeleteArgs) => Promise<void> = async () => {}
let mockActive = false

mock.module('../../../../utils/permissions/permissions.js', () => ({
  ...realPermissions,
  deletePermissionRule: (args: DeleteArgs) =>
    mockActive ? deleteImpl(args) : realDeletePermissionRule(args),
}))

// Same delegation pattern for the error logger — official `.catch` starts
// with `l($h)` (logError) before buffering + announcing.
const realLogError = realLog.logError
const logErrorCalls: unknown[] = []
mock.module('../../../../utils/log.js', () => ({
  ...realLog,
  logError: (...args: Parameters<typeof realLogError>) => {
    if (mockActive) {
      logErrorCalls.push(args[0])
      return
    }
    return realLogError(...args)
  },
}))

// Imported AFTER mock.module so the component module resolves the patched
// binding. RED phase: the export does not exist yet → every test fails.
const { runPermissionRuleDelete } = await import('../PermissionRuleList.js')

const RULE: DeleteArgs['rule'] = {
  source: 'userSettings',
  ruleBehavior: 'allow',
  ruleValue: { toolName: 'Bash', ruleContent: 'npm run test:*' },
}

const PLAIN = permissionRuleValueToString(RULE.ruleValue)

const DELETED_SR = `[Deleted allow rule ${PLAIN}]`
const DELETED_VISUAL = `Deleted allow rule ${chalk.bold(PLAIN)}`
// Literal U+2014 em dash — exact bytes verified in the v311 binary (—).
const COULD_NOT_DELETE_SR = `[Could not delete ${PLAIN} — the rule is unchanged]`
const COULD_NOT_DELETE_VISUAL = `Could not delete ${chalk.bold(PLAIN)} — the rule is unchanged`

function makeArgs(
  overrides?: Partial<DeleteArgs & { appendChange: (message: string) => void }>,
): DeleteArgs & { appendChange: (message: string) => void } {
  return {
    rule: RULE,
    initialContext: getEmptyToolPermissionContext(),
    setToolPermissionContext: () => {},
    appendChange: () => {},
    ...overrides,
  } as DeleteArgs & { appendChange: (message: string) => void }
}

describe('v2.1.311 #61: permission-rule delete SR announcements', () => {
  beforeEach(() => {
    mockActive = true
    logErrorCalls.length = 0
    resetScreenReaderAnnouncements()
  })
  afterEach(() => {
    mockActive = false
    resetScreenReaderAnnouncements()
  })

  test('control: the plain rule value renders as Bash(npm run test:*)', () => {
    // Guards the fixtures below — if escaping changes, the expected strings
    // here change with it rather than silently drifting from the official.
    expect(PLAIN).toBe('Bash(npm run test:*)')
  })

  test('success: announces [Deleted <behavior> rule <plainValue>] and buffers the bold visual message', async () => {
    // Arrange
    const buffered: string[] = []
    deleteImpl = async () => {}

    // Act
    await runPermissionRuleDelete(
      makeArgs({ appendChange: message => buffered.push(message) }),
    )

    // Assert — immediate SR announcement + buffered visual message.
    expect(drainScreenReaderAnnouncements()).toEqual([DELETED_SR])
    expect(buffered).toEqual([DELETED_VISUAL])
  })

  test('success: SR brackets carry the PLAIN value; the visual message carries bold', async () => {
    // Arrange — force SGR output so the bold/plain split is observable
    // (chalk.level is 0 under the non-TTY test runner, where bold is a no-op).
    const previousLevel = chalk.level
    chalk.level = 1
    try {
      const buffered: string[] = []
      deleteImpl = async () => {}

      // Act
      await runPermissionRuleDelete(
        makeArgs({ appendChange: message => buffered.push(message) }),
      )

      // Assert — official passes yu (plain) to K0 and he.bold(Ci) to the
      // visual buffer: no ANSI inside SR brackets, ANSI present in the visual.
      const [sr] = drainScreenReaderAnnouncements()
      expect(sr).toBe(stripAnsi(sr))
      expect(sr).toBe(`[Deleted allow rule ${PLAIN}]`)
      expect(buffered[0]).not.toBe(stripAnsi(buffered[0]))
      expect(stripAnsi(buffered[0])).toBe(`Deleted allow rule ${PLAIN}`)
    } finally {
      chalk.level = previousLevel
    }
  })

  test('success: nothing lands before deletePermissionRule resolves (both messages live in .then)', async () => {
    // Arrange — deferred delete.
    let resolveDelete: () => void = () => {}
    deleteImpl = () =>
      new Promise<void>(resolve => {
        resolveDelete = resolve
      })
    const buffered: string[] = []

    // Act — start, flush microtasks, then resolve.
    const pending = runPermissionRuleDelete(
      makeArgs({ appendChange: message => buffered.push(message) }),
    )
    await Promise.resolve()

    // Assert — pending: no announcement, no visual message.
    expect(drainScreenReaderAnnouncements()).toEqual([])
    expect(buffered).toEqual([])

    // Act — resolve the delete.
    resolveDelete()
    await pending

    // Assert — both land only after success.
    expect(drainScreenReaderAnnouncements()).toEqual([DELETED_SR])
    expect(buffered).toEqual([DELETED_VISUAL])
  })

  test('failure: announces [Could not delete <plainValue> — the rule is unchanged] and buffers the failure visual message', async () => {
    // Arrange — read-only-source style rejection.
    const buffered: string[] = []
    const thrown = new Error('Cannot delete permission rules from read-only settings')
    deleteImpl = async () => {
      throw thrown
    }

    // Act
    await runPermissionRuleDelete(
      makeArgs({ appendChange: message => buffered.push(message) }),
    )

    // Assert — SR announcement is plain; visual message keeps chalk.bold;
    // official `.catch` logs the error first (`l($h)`).
    expect(logErrorCalls).toEqual([thrown])
    expect(drainScreenReaderAnnouncements()).toEqual([COULD_NOT_DELETE_SR])
    expect(buffered).toEqual([COULD_NOT_DELETE_VISUAL])
    expect(stripAnsi(buffered[0])).toBe(
      `Could not delete ${PLAIN} — the rule is unchanged`,
    )
  })

  test('failure: the rejection is handled — resolves without throwing and buffers no success message', async () => {
    // Arrange
    const buffered: string[] = []
    deleteImpl = async () => {
      throw new Error('boom')
    }

    // Act / Assert — the returned promise settles (official .catch logs and
    // continues; no unhandled rejection).
    await expect(
      runPermissionRuleDelete(
        makeArgs({ appendChange: message => buffered.push(message) }),
      ),
    ).resolves.toBeUndefined()
    expect(buffered.some(message => message.startsWith('Deleted '))).toBe(false)
    expect(drainScreenReaderAnnouncements()).toEqual([
      `[Could not delete ${PLAIN} — the rule is unchanged]`,
    ])
  })
})
