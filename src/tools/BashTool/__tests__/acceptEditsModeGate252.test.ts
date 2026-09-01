import { describe, expect, test } from 'bun:test'
import type { PermissionMode } from '../../../types/permissions.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import { createPathChecker } from '../pathValidation.js'

// Official Claude Code 2.1.252 (OCC-112 Gap-112b): the accept-edits mode
// suggestion on a Bash write/create path-validation ask is only offered when
// the session is in `default` or `plan` mode — binary gate:
//   let R=u.mode==="plan"&&(u.prePlanMode==="auto"||u.prePlanMode===
//     "bypassPermissions"||u.prePlanMode==="acceptEdits"||u.prePlanMode===
//     "dontAsk");
//   if((S==="write"||S==="create")&&(t.mode==="default"||t.mode==="plan")&&!R)
//     re.push({type:"setMode",mode:"acceptEdits",destination:"session"})

const CWD = '/tmp/occ112-cwd'
const OUTSIDE_PATH = '/tmp/occ112-elsewhere/file.txt'

function runTouchCheck(mode: PermissionMode, prePlanMode?: PermissionMode) {
  const checker = createPathChecker('touch')
  const context = { ...getEmptyToolPermissionContext(), mode, prePlanMode }
  return checker([OUTSIDE_PATH], CWD, context)
}

function suggestionTypes(result: ReturnType<ReturnType<typeof createPathChecker>>): string[] {
  if (result.behavior !== 'ask' || !result.suggestions) return []
  return result.suggestions.map(s => s.type)
}

describe('2.1.252 Gap-112b — setMode suggestion gated on session mode', () => {
  test('default mode: write ask offers setMode + addDirectories', () => {
    // Act
    const result = runTouchCheck('default')

    // Assert
    expect(result.behavior).toBe('ask')
    expect(suggestionTypes(result)).toContain('setMode')
    expect(suggestionTypes(result)).toContain('addDirectories')
    const setMode = result.behavior === 'ask'
      ? result.suggestions?.find(s => s.type === 'setMode')
      : undefined
    expect(setMode).toMatchObject({ mode: 'acceptEdits', destination: 'session' })
  })

  test('plan mode: write ask still offers setMode', () => {
    // Act
    const result = runTouchCheck('plan')

    // Assert
    expect(result.behavior).toBe('ask')
    expect(suggestionTypes(result)).toContain('setMode')
  })

  test('acceptEdits mode: no setMode suggestion (already past it)', () => {
    // Act
    const result = runTouchCheck('acceptEdits')

    // Assert — the ask + directory suggestion stay, setMode is gated out
    expect(result.behavior).toBe('ask')
    expect(suggestionTypes(result)).not.toContain('setMode')
    expect(suggestionTypes(result)).toContain('addDirectories')
  })

  test('bypassPermissions mode: no setMode suggestion', () => {
    // Act
    const result = runTouchCheck('bypassPermissions')

    // Assert
    expect(result.behavior).toBe('ask')
    expect(suggestionTypes(result)).not.toContain('setMode')
  })

  test('plan mode entered from an elevated pre-plan mode: no setMode', () => {
    // Official suppresses the suggestion when plan was entered from an
    // already-elevated mode — accepting would downgrade the session.
    for (const prePlanMode of [
      'auto',
      'bypassPermissions',
      'acceptEdits',
      'dontAsk',
    ] as const) {
      // Act
      const result = runTouchCheck('plan', prePlanMode)

      // Assert — the ask + directory suggestion stay, setMode is gated out
      expect(result.behavior).toBe('ask')
      expect(suggestionTypes(result)).not.toContain('setMode')
      expect(suggestionTypes(result)).toContain('addDirectories')
    }
  })

  test('plan mode entered from default: setMode still offered', () => {
    // Act
    const result = runTouchCheck('plan', 'default')

    // Assert — a non-elevated pre-plan mode does not suppress
    expect(result.behavior).toBe('ask')
    expect(suggestionTypes(result)).toContain('setMode')
  })
})
