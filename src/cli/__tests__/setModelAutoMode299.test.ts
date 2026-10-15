/**
 * CC 2.1.299 #041 — headless/SDK set_model must kick the session out of auto
 * mode when the new model doesn't support auto mode.
 *
 * Changelog: "Fixed SDK and headless sessions staying in auto mode after the
 * host switched to a model that doesn't support auto mode."
 *
 * Official v299 evidence: the set_model control handler awaits an auto-mode
 * re-verification after applying the model
 * (`ge=async()=>{let ae=await UUo(V,xd); if(ae.ok){sd(), await hs(); ...}`),
 * where `hs()` re-runs the gate check; the resulting mode change surfaces via
 * the status/metadata channel. OCC mirrors the interactive kick-out
 * (useKickOffCheckAndDisableAutoModeIfNeeded): resetAutoModeGateCheck() +
 * checkAndDisableAutoModeIfNeeded() in the print.ts set_model branch.
 *
 * These tests replicate the exact gate block added to print.ts's set_model
 * handler (the handler itself is inline in runHeadless and not directly
 * callable) against the REAL permission machinery — no mocks:
 *   - set_model to a non-auto model while in auto → mode downgraded to
 *     'default', isAutoModeAvailable false, notification queued, and the
 *     sync re-entry gate (isAutoModeGateEnabled) rejects auto.
 *   - set_model to an auto-supporting model while in auto → stays auto.
 *   - set_model to a non-auto model while NOT in auto → untouched.
 *
 * Deterministic provider: the CLAUDE_CODE_USE_* env vars are cleared so
 * getAPIProvider() === 'firstParty' and modelSupportsAutoMode uses the exact
 * official denylist branch (haiku-4-5 denied, sonnet-4-6 allowed) regardless
 * of the ambient environment. CLAUDE_CONFIG_DIR points at a tmpdir so real
 * user settings can't set disableAutoMode.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'
import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import { modelSupportsAutoMode } from '../../utils/betas.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  checkAndDisableAutoModeIfNeeded,
  resetAutoModeGateCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import {
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
} from '../../utils/permissions/permissionSetup.js'
import { isAutoModeActive } from '../../utils/permissions/autoModeState.js'

const NON_AUTO_MODEL = 'claude-haiku-4-5'
const AUTO_MODEL = 'claude-sonnet-4-6'

type FakeState = {
  toolPermissionContext: ReturnType<typeof getEmptyToolPermissionContext>
  fastMode: boolean
  notifications: { queue: Array<{ key: string; text: string }> }
}

function makeState(mode: 'auto' | 'default'): FakeState {
  return {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode,
      isAutoModeAvailable: mode === 'auto',
    },
    fastMode: false,
    notifications: { queue: [] },
  }
}

/**
 * Replica of the print.ts set_model auto-mode gate block (CC 2.1.299 #041).
 * Keep in sync with src/cli/print.ts `message.request.subtype === 'set_model'`.
 */
async function runSetModelAutoModeGate(
  model: string,
  state: FakeState,
): Promise<FakeState> {
  let current = state
  const setAppState = (f: (prev: AppState) => AppState): void => {
    current = f(current as unknown as AppState) as unknown as FakeState
  }
  setMainLoopModelOverride(model)
  if (
    !modelSupportsAutoMode(model) &&
    current.toolPermissionContext.mode === 'auto'
  ) {
    resetAutoModeGateCheck()
    await checkAndDisableAutoModeIfNeeded(
      current.toolPermissionContext,
      setAppState,
      current.fastMode,
    )
  }
  return current
}

let configDir: string
let savedConfigDir: string | undefined
let savedUserType: string | undefined
const PROVIDER_ENV_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
] as const
const savedProviderEnv = new Map<string, string | undefined>()

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-set-model-299-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  savedUserType = process.env.USER_TYPE
  process.env.CLAUDE_CONFIG_DIR = configDir
  // External (non-ant) denylist branch of modelSupportsAutoMode; the ant
  // branch of parseUserSpecifiedModel calls resolveAntModel, which is not
  // wired in OCC (ReferenceError), so USER_TYPE must NOT be 'ant' here.
  delete process.env.USER_TYPE
  for (const key of PROVIDER_ENV_VARS) {
    savedProviderEnv.set(key, process.env[key])
    delete process.env[key]
  }
  const { resetSettingsCache } = require('../../utils/settings/settingsCache.js')
  resetSettingsCache()
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
  for (const [key, value] of savedProviderEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(configDir, { recursive: true, force: true })
  const { resetSettingsCache } = require('../../utils/settings/settingsCache.js')
  resetSettingsCache()
  setMainLoopModelOverride(null)
})

beforeEach(() => {
  // The run-once flag and the model override are module-global; reset both so
  // each test starts from a clean gate (the handler resets the flag itself).
  resetAutoModeGateCheck()
  setMainLoopModelOverride(null)
})

describe('CC 2.1.299 #041 — headless set_model kicks out of auto mode', () => {
  test('model fixture sanity: denylist/allowlist branch is active', () => {
    expect(modelSupportsAutoMode(NON_AUTO_MODEL)).toBe(false)
    expect(modelSupportsAutoMode(AUTO_MODEL)).toBe(true)
  })

  test('set_model to non-auto model while in auto → downgraded to default', async () => {
    const after = await runSetModelAutoModeGate(NON_AUTO_MODEL, makeState('auto'))
    expect(after.toolPermissionContext.mode).toBe('default')
    expect(after.toolPermissionContext.isAutoModeAvailable).toBe(false)
    // Classifier circuit deactivated (mirrors interactive kick-out semantics).
    expect(isAutoModeActive()).toBe(false)
    // Notification surfaced through the existing appState channel.
    expect(
      after.notifications.queue.some(n => n.key === 'auto-mode-gate-notification'),
    ).toBe(true)
    // Sync re-entry gate now rejects auto for this model — a subsequent
    // set_permission_mode auto control request errors out (handleSetPermissionMode
    // gates on isAutoModeGateEnabled()).
    expect(isAutoModeGateEnabled()).toBe(false)
    expect(getAutoModeUnavailableReason()).toBe('model')
  })

  test('set_model to auto-supporting model while in auto → stays auto', async () => {
    const after = await runSetModelAutoModeGate(AUTO_MODEL, makeState('auto'))
    expect(after.toolPermissionContext.mode).toBe('auto')
    expect(after.notifications.queue).toEqual([])
  })

  test('set_model to non-auto model while NOT in auto → untouched', async () => {
    const after = await runSetModelAutoModeGate(NON_AUTO_MODEL, makeState('default'))
    expect(after.toolPermissionContext.mode).toBe('default')
    // Gate never fired: no notification, context object identity preserved.
    expect(after.notifications.queue).toEqual([])
  })
})
