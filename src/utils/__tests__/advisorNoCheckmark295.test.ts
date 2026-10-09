/**
 * CC 2.1.295 port — `/advisor` must not present a saved advisor model that
 * is no longer available as the current selection.
 *
 * Official changelog: "Fixed the `/advisor` dialog showing a checkmark on a
 * saved advisor model that is no longer available; it now opens on 'No
 * advisor'". Official picker logic (ev/advisor_no.txt):
 *   c = a && !p && aVe(a) ? {label,value:a} : void 0
 *   v = a && aVe(a) ? c?.value ?? p ?? "off" : "off"
 * OCC has no advisor dialog; the analog surface is the no-arg `/advisor`
 * status display, wired through the pure getEffectiveAdvisorModel() helper.
 */
import { describe, expect, test } from 'bun:test'
import advisor from '../../commands/advisor.js'
import { getEffectiveAdvisorModel } from '../advisor.js'

describe('getEffectiveAdvisorModel (official aVe(a) availability gate)', () => {
  test('returns undefined when nothing is saved', () => {
    // Arrange
    const available = (): boolean => true

    // Act & Assert
    expect(getEffectiveAdvisorModel(undefined, available)).toBeUndefined()
  })

  test('returns the saved model while it is available', () => {
    expect(
      getEffectiveAdvisorModel('claude-opus-5', () => true),
    ).toBe('claude-opus-5')
  })

  test('returns undefined (official "off" / "No advisor") when the saved model is no longer available', () => {
    expect(
      getEffectiveAdvisorModel('claude-opus-99-gone', () => false),
    ).toBeUndefined()
  })

  test('consults the availability predicate with the saved model', () => {
    // Arrange
    const seen: string[] = []

    // Act
    getEffectiveAdvisorModel('claude-sonnet-5', model => {
      seen.push(model)
      return true
    })

    // Assert
    expect(seen).toEqual(['claude-sonnet-5'])
  })
})

/** Minimal fake LocalJSXCommandContext for the no-arg display path. */
function fakeContext(advisorModel: string | undefined) {
  const stateUpdates: unknown[] = []
  const context = {
    getAppState: () => ({
      advisorModel,
      mainLoopModel: 'claude-opus-5',
    }),
    setAppState: (updater: unknown) => {
      stateUpdates.push(updater)
    },
  }
  return { context: context as any, stateUpdates }
}

async function callNoArgAdvisor(
  advisorModel: string | undefined,
): Promise<{ value: string; stateUpdates: unknown[] }> {
  const { call } = await advisor.load()
  const { context, stateUpdates } = fakeContext(advisorModel)
  const result = await call('', context)
  if (result.type !== 'text') {
    throw new Error(`expected a text result, got ${result.type}`)
  }
  return { value: result.value, stateUpdates }
}

describe('/advisor no-arg display (CC 2.1.295 — opens on "No advisor")', () => {
  test('a saved model that is no longer a valid advisor model reads as not set', async () => {
    // Arrange — 'claude-opus-99-gone' fails isValidAdvisorModel (no such
    // advisor_rank in the catalog), the OCC analog of the official aVe(a)
    // availability check.

    // Act
    const { value, stateUpdates } = await callNoArgAdvisor(
      'claude-opus-99-gone',
    )

    // Assert — the pre-fix display was "Advisor: claude-opus-99-gone" (the
    // "checkmark" the official fix removed); now the not-set text is shown
    // and the display-only fix leaves the saved setting untouched.
    expect(value).toBe(
      'Advisor: not set\nUse "/advisor <model>" to enable (e.g. "/advisor opus").',
    )
    expect(value).not.toContain('claude-opus-99-gone')
    expect(stateUpdates).toEqual([])
  })

  test('a saved model that is still available is shown as before', async () => {
    const { value, stateUpdates } = await callNoArgAdvisor('claude-opus-5')

    expect(value).toBe(
      'Advisor: claude-opus-5\nUse "/advisor unset" to disable or "/advisor <model>" to change.',
    )
    expect(stateUpdates).toEqual([])
  })

  test('no saved model keeps the not-set text (regression)', async () => {
    const { value } = await callNoArgAdvisor(undefined)

    expect(value).toBe(
      'Advisor: not set\nUse "/advisor <model>" to enable (e.g. "/advisor opus").',
    )
  })
})
