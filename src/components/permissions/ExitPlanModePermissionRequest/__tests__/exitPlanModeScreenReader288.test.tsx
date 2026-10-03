/**
 * CC 2.1.288 gap #7 — SR announcement of the permission mode on plan approval.
 *
 * Official v288 (binary wins over the gap report; both agreed — verified with
 * dd on /tmp/cc-diff-288/v288/package/claude):
 *
 *   @229358293  function HE(h){QW(`[${TL(h)} on]`,{hold:!0})}
 *   @229364175  E(Kr()),HE("auto")          — auto keep-context row, UNCONDITIONAL
 *   @229364489  …E(Kr())!==!1)HE(bs)        — keep-context row (bs = keepContextMode)
 *   @229365336  …!==!1)HE("default")        — empty-plan 'yes' row
 *   @229541912  let xt=N.getState().toolPermissionContext.mode;
 *               if(Ct.mode&&xt===Ct.mode)QW(`[${TL(xt)} on]`,{hold:!0});
 *                                          — REPL initialMessage consumer
 *
 * The clearContext rows do NOT announce in the dialog — the REPL
 * initialMessage consumer covers them (also the Shift+Tab keyboard path).
 *
 * DIVERGENCE (expected): official guards the keep-context / empty-plan sites
 * with `!==!1` because official onAllow returns a boolean; OCC's onAllow
 * returns void (src/components/permissions/PermissionRequest.tsx:124), so the
 * guard cannot be mirrored — OCC announces unconditionally after the call.
 *
 * Test strategy: the component's handleResponse / handleEmptyPlanResponse are
 * internal closures wired to <Select onChange>. We mock Select to capture the
 * onChange handler during an isolated render (renderIsolated280 harness, the
 * pattern used by searchBoxScreenReader287.test.tsx / reducedMotionWiring287),
 * then invoke it directly with each ResponseValue — no component refactor.
 */
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { type AppState, AppStateProvider, getDefaultAppState } from '../../../../state/AppState.js'
import { renderToStringIsolated } from '../../../CustomSelect/__tests__/renderIsolated280.js'
import {
  consumeScreenReaderAnnouncementHoldMs,
  drainScreenReaderAnnouncements,
  pushScreenReaderAnnouncement,
  resetScreenReaderAnnouncements,
} from '../../../../utils/screenReader.js'
import { permissionModeIndicator } from '../../../../utils/permissions/PermissionMode.js'

// ---------------------------------------------------------------------------
// Mock plumbing — installed BEFORE importing the module under test
// (OCC-97/129 convention, same as reducedMotionWiring287.test.tsx).
// ---------------------------------------------------------------------------

// 1) Select — capture the onChange handler the component wires up.
const actualSelectModule = await import('../../../CustomSelect/index.js')
type SelectOnChange = (value: never) => unknown
const capturedOnChange: SelectOnChange[] = []
mock.module('../../../CustomSelect/index.js', () => ({
  ...actualSelectModule,
  Select: (props: { onChange: SelectOnChange }) => {
    capturedOnChange.push(props.onChange)
    return null
  },
}))

// 2) Markdown — light stub (the plan body is irrelevant to announcements).
//    Must render inside <Text> — bare strings make ink's reconciler throw.
const actualMarkdownModule = await import('../../../Markdown.js')
const { Text } = await import('../../../../ink.js')
mock.module('../../../Markdown.js', () => ({
  ...actualMarkdownModule,
  Markdown: ({ children }: { children?: React.ReactNode }) => <Text>{String(children ?? '')}</Text>,
}))

// 3) generateSessionName — never hit the network from autoNameSessionFromPlan.
const actualRenameModule = await import('../../../../commands/rename/generateSessionName.js')
mock.module('../../../../commands/rename/generateSessionName.js', () => ({
  ...actualRenameModule,
  generateSessionName: async () => undefined,
}))

// 4) permissionSetup — force the auto-mode gate ON so the
//    'yes-resume-auto-mode' keep-context branch is reachable deterministically
//    (the real gate depends on getMainLoopModel()/settings in the test env).
const actualPermissionSetupModule = await import('../../../../utils/permissions/permissionSetup.js')
mock.module('../../../../utils/permissions/permissionSetup.js', () => ({
  ...actualPermissionSetupModule,
  isAutoModeGateEnabled: () => true,
}))

// 5) plans — OCC's EXIT_PLAN_MODE_V2_TOOL_NAME === EXIT_PLAN_MODE_TOOL_NAME
//    ('ExitPlanMode'), so isV2 is always true and the plan body comes from
//    getPlan() (disk), not input.plan. Control it here so isEmpty is
//    deterministic per test.
const actualPlansModule = await import('../../../../utils/plans.js')
let planFileContent: string | null = null
mock.module('../../../../utils/plans.js', () => ({
  ...actualPlansModule,
  getPlan: () => planFileContent,
}))

const { ExitPlanModePermissionRequest } = await import('../ExitPlanModePermissionRequest.js')
const { setAutoModeActive } = await import('../../../../utils/permissions/autoModeState.js')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeToolUseConfirm(plan: string) {
  const onAllow = mock((_updatedInput: unknown, _permissionUpdates: unknown[], _feedback?: string) => {})
  const onConfirmReject = mock((_feedback?: string) => {})
  const toolUseConfirm = {
    assistantMessage: { message: { usage: undefined } },
    tool: { name: 'ExitPlanMode' },
    description: '',
    input: { plan },
    toolUseContext: {},
    toolUseID: 'toolu_test_288',
    permissionResult: { behavior: 'allow', updatedInput: {} },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: () => {},
    onAbort: () => {},
    onAllow,
    onReject: onConfirmReject,
    recheckPermission: async () => {},
  }
  return {
    // The dialog only reads the fields above; a full ToolUseConfirm fixture
    // would drag in the whole tool/message type graph for no coverage gain.
    toolUseConfirm: toolUseConfirm as never,
    onAllow,
    onConfirmReject,
  }
}

async function renderDialog(plan: string) {
  capturedOnChange.length = 0
  planFileContent = plan === '' ? null : plan
  const { toolUseConfirm, onAllow, onConfirmReject } = makeToolUseConfirm(plan)
  const onDone = mock(() => {})
  const onOuterReject = mock(() => {})
  await renderToStringIsolated(
    <AppStateProvider initialState={getDefaultAppState() as AppState}>
      <ExitPlanModePermissionRequest
        toolUseConfirm={toolUseConfirm}
        toolUseContext={{} as never}
        onDone={onDone}
        onReject={onOuterReject}
        verbose={false}
        workerBadge={undefined}
      />
    </AppStateProvider>,
    80,
  )
  const onChange = capturedOnChange[capturedOnChange.length - 1]
  if (!onChange) throw new Error('Select onChange was not captured — render harness broken')
  return { onChange: onChange as (value: string) => unknown, onAllow, onConfirmReject, onDone }
}

beforeEach(() => {
  resetScreenReaderAnnouncements()
  delete process.env.CLAUDE_AX_ANNOUNCEMENT_HOLD_MS
})

afterEach(() => {
  resetScreenReaderAnnouncements()
  setAutoModeActive(false)
})

// ---------------------------------------------------------------------------
// Dialog call sites (official HE("auto") / HE(bs) / HE("default"))
// ---------------------------------------------------------------------------

describe('2.1.288 #7: ExitPlanModePermissionRequest SR permission-mode announcement', () => {
  test("empty-plan 'yes' announces `[manual mode on]` with hold (official HE(\"default\") @229365336)", async () => {
    // Arrange — empty plan renders the simplified yes/no dialog whose Select
    // onChange is handleEmptyPlanResponse.
    const { onChange, onAllow } = await renderDialog('')

    // Act
    await onChange('yes')

    // Assert — verbatim official string `[${TL(mode)} on]` for 'default'.
    expect(drainScreenReaderAnnouncements()).toEqual(['[manual mode on]'])
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(1000)
    expect(onAllow).toHaveBeenCalledTimes(1)
  })

  test("keep-context approval announces the keep-context mode with hold (official HE(bs) @229364489)", async () => {
    // Arrange — default context has isBypassPermissionsModeAvailable=false,
    // so 'yes-accept-edits-keep-context' maps to keepContextMode='acceptEdits'.
    const { onChange, onAllow } = await renderDialog('# Plan\n\nDo the thing.')

    // Act
    await onChange('yes-accept-edits-keep-context')

    // Assert — verbatim string + hold, and the indicator matches the mode.
    const drained = drainScreenReaderAnnouncements()
    expect(drained).toEqual(['[accept edits on]'])
    expect(drained[0]).toBe(`[${permissionModeIndicator('acceptEdits')} on]`)
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(1000)
    expect(onAllow).toHaveBeenCalledTimes(1)
  })

  test("keep-context 'yes-default-keep-context' announces `[manual mode on]` with hold", async () => {
    // Arrange
    const { onChange } = await renderDialog('# Plan')

    // Act
    await onChange('yes-default-keep-context')

    // Assert
    expect(drainScreenReaderAnnouncements()).toEqual(['[manual mode on]'])
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(1000)
  })

  test("auto keep-context path announces `[auto mode on]` with hold (official HE(\"auto\") @229364175)", async () => {
    // Arrange — auto-mode gate mocked ON so this branch is taken.
    const { onChange, onAllow } = await renderDialog('# Plan')

    // Act
    await onChange('yes-resume-auto-mode')

    // Assert — official announces UNCONDITIONALLY right after onAllow.
    const drained = drainScreenReaderAnnouncements()
    expect(drained).toEqual(['[auto mode on]'])
    expect(drained[0]).toBe(`[${permissionModeIndicator('auto')} on]`)
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(1000)
    expect(onAllow).toHaveBeenCalledTimes(1)
  })

  test('clearContext path pushes NO dialog-level announcement (REPL initialMessage consumer covers it)', async () => {
    // Arrange — 'yes-accept-edits' is not a keep-context option: the dialog
    // sets initialMessage and rejects; official has no HE() on these rows.
    const { onChange, onAllow, onConfirmReject } = await renderDialog('# Plan')

    // Act
    await onChange('yes-accept-edits')

    // Assert — no announcement, no hold, onAllow never called (onReject path).
    expect(drainScreenReaderAnnouncements()).toEqual([])
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)
    expect(onAllow).not.toHaveBeenCalled()
    expect(onConfirmReject).toHaveBeenCalledTimes(1)
  })

  test("'no' (keep planning) pushes no announcement", async () => {
    // Arrange — 'no' with empty feedback returns early.
    const { onChange, onAllow } = await renderDialog('# Plan')

    // Act
    await onChange('no')

    // Assert
    expect(drainScreenReaderAnnouncements()).toEqual([])
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)
    expect(onAllow).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// REPL initialMessage consumer (official @229541912) — review-verified.
//
// processInitialMessage is a closure inside REPL.tsx's ~3000-line component
// (useEffect body) and is NOT exported; unit-invoking it would require
// refactoring REPL.tsx, which the port brief forbids. The consumer code added
// to src/screens/REPL.tsx (immediately after the setAppState that applies
// buildPermissionUpdates) is:
//
//   const resultingMode = store.getState().toolPermissionContext.mode
//   if (initialMsg.mode && resultingMode === initialMsg.mode) {
//     pushScreenReaderAnnouncement(`[${permissionModeIndicator(resultingMode)} on]`, { hold: true })
//   }
//
// The tests below pin the primitives that consumer relies on: the exact
// verbatim announcement string for every mode the consumer can announce, and
// the hold semantics of a {hold: true} push.
// ---------------------------------------------------------------------------

describe('2.1.288 #7: REPL initialMessage consumer primitives (review-verified)', () => {
  test('announcement template is bracket + permissionModeIndicator(mode) + " on]" for every plannable mode', () => {
    // Arrange/Act/Assert — verbatim official `[${TL(mode)} on]` shapes.
    const expected: Record<string, string> = {
      default: '[manual mode on]',
      acceptEdits: '[accept edits on]',
      bypassPermissions: '[bypass permissions on]',
      auto: '[auto mode on]',
    }
    for (const [mode, announcement] of Object.entries(expected)) {
      expect(`[${permissionModeIndicator(mode as never)} on]`).toBe(announcement)
    }
  })

  test('a {hold: true} push arms the one-shot 1000ms hold; without hold it stays 0', () => {
    // Arrange — same call shape the REPL consumer uses.
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)

    // Act — same guarded shape the REPL consumer uses: only announce when the
    // requested mode actually landed (mirrors official `Ct.mode&&xt===Ct.mode`,
    // which also absorbs OCC's TRANSCRIPT_CLASSIFIER 'auto'-override branch).
    const requestedMode = 'acceptEdits' as const
    const resultingMode = 'acceptEdits' as const
    if (requestedMode && resultingMode === requestedMode) {
      pushScreenReaderAnnouncement(`[${permissionModeIndicator(resultingMode)} on]`, { hold: true })
    }

    // Assert
    expect(drainScreenReaderAnnouncements()).toEqual(['[accept edits on]'])
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(1000)
    // One-shot: a second consume yields 0.
    expect(consumeScreenReaderAnnouncementHoldMs()).toBe(0)
  })
})
