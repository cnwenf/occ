import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { PermissionResult } from '../../../types/permissions.js'
import type { ToolPermissionContext } from '../../../Tool.js'

// The permission path reads MACRO.VERSION at runtime — mirror the cli.tsx
// polyfill (same convention as compoundNestedAsk289/filesystem tests).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.292 security fix (official changelog, verbatim):
 *   "Security: Fixed PreToolUse hook approvals and auto mode bypassing the
 *    permission prompt for file reads from network (UNC) paths"
 *
 * OCC port (docs/gap-research-293/security-cluster-292.md §1.3):
 *   Step A — the UNC read ask in checkReadPermissionForTool is reclassified
 *     from decisionReason.type 'other' to 'safetyCheck' with
 *     classifierApprovable:false, so the three bypass-immunity floors that
 *     key off safetyCheck all hold simultaneously:
 *       · permissions.ts step 1g  (PreToolUse-hook-allow cannot stand)
 *       · permissions.ts auto lane (non-classifier-approvable safetyChecks
 *         are immune to the acceptEdits fast-path, the YOLO allowlist
 *         fast-path, and the classifier)
 *       · permissions.ts bypassPermissions floor (1g runs before 2a)
 *   Step B — detection extends from prefix-only startsWith('\\\\'/'//') to
 *     ANYWHERE-match via the reused containsVulnerableUncPath helper
 *     (DavWWWRoot / @SSL@ / mixed separators), matching the official (A)
 *     layer's anywhere-in-path triggers.
 */

// ── platform override (containsVulnerableUncPath is windows-gated) ──

// Mock hygiene per the OCC-97 lesson (sandboxLocalBinding281.test.ts):
// snapshot the real namespace into a PLAIN object BEFORE mocking — spreading
// the live namespace inside the factory recurses into the mock and deadlocks.
const actualPlatformModule = await import('../../platform.js')
const actualPlatformExports = { ...actualPlatformModule }
let platformOverride: 'windows' | null = null

mock.module('../../platform.js', () => ({
  ...actualPlatformExports,
  getPlatform: () => platformOverride ?? actualPlatformExports.getPlatform(),
}))

afterAll(() => {
  platformOverride = null
  mock.module('../../platform.js', () => ({
    ...actualPlatformExports,
  }))
})

// Import AFTER the platform mock so readOnlyCommandValidation sees it.
const { checkReadPermissionForTool, checkNetworkMountReadSurface } =
  await import('../filesystem.js')
const { checkRuleBasedPermissions, hasPermissionsToUseTool } = await import(
  '../permissions.js'
)

// ── helpers ──

type ReadCheckTool = Parameters<typeof checkReadPermissionForTool>[0]
const fakeReadTool = {
  name: 'Read',
  getPath: (input: { file_path: string }) => input.file_path,
} as unknown as ReadCheckTool

function makePermissionContext(mode = 'default'): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    shouldAvoidPermissionPrompts: false,
  } as ToolPermissionContext
}

/** A full Read tool double whose checkPermissions yields `decision`. */
function makeReadTool(decision: PermissionResult): Tool {
  return {
    name: 'Read',
    userFacingName: () => 'Read',
    inputSchema: {
      parse: (input: unknown) => input,
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    checkPermissions: async () => decision,
    getPath: (input: { file_path: string }) => input.file_path,
    requiresUserInteraction: undefined,
    isMcp: false,
  } as unknown as Tool
}

function makeToolUseContext(mode: string): ToolUseContext {
  return {
    abortController: { signal: { aborted: false } },
    getAppState: () => ({
      toolPermissionContext: makePermissionContext(mode),
      denialTracking: undefined,
    }),
    options: { isNonInteractiveSession: false, tools: [] },
    messages: [],
  } as unknown as ToolUseContext
}

function makeMsg(): AssistantMessage {
  return { message: { id: 'm', content: [] } } as unknown as AssistantMessage
}

// ── Plan test #1: Step A reclassification ──

describe('UNC read decision is a non-classifier-approvable safetyCheck (Step A)', () => {
  test('backslash UNC \\\\host\\share\\x → ask with safetyCheck, classifierApprovable:false', () => {
    const result = checkReadPermissionForTool(
      fakeReadTool,
      { file_path: '\\\\host\\share\\x.txt' },
      makePermissionContext(),
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
    const reason = result.decisionReason as {
      classifierApprovable: boolean
      reason: string
    }
    // classifierApprovable:false is what makes the auto lane immune.
    expect(reason.classifierApprovable).toBe(false)
    // Reason string kept per plan Step A.
    expect(reason.reason).toBe('UNC path detected (defense-in-depth check)')
    // Message kept (byte-comparable to pre-fix OCC and shown in the prompt).
    expect(result.message ?? '').toContain('UNC path')
  })

  test('forward-slash UNC //host/share/x → ask with safetyCheck (POSIX surface kept)', () => {
    const result = checkReadPermissionForTool(
      fakeReadTool,
      { file_path: '//host/share/x.txt' },
      makePermissionContext(),
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
  })
})

// ── Plan test #5: Step B anywhere-match (trigger NOT at position 0) ──

describe('UNC read detection matches anywhere in the path (Step B)', () => {
  test('DavWWWRoot mid-path (C:\\share\\DavWWWRoot\\x) → gated', () => {
    platformOverride = 'windows'
    try {
      const result = checkReadPermissionForTool(
        fakeReadTool,
        { file_path: 'C:\\share\\DavWWWRoot\\x.txt' },
        makePermissionContext(),
      )
      expect(result.behavior).toBe('ask')
      expect(result.decisionReason?.type).toBe('safetyCheck')
    } finally {
      platformOverride = null
    }
  })

  test('@SSL@8443 mid-path (no UNC prefix) → gated', () => {
    platformOverride = 'windows'
    try {
      const result = checkReadPermissionForTool(
        fakeReadTool,
        { file_path: 'C:\\cache\\srv@SSL@8443\\x.txt' },
        makePermissionContext(),
      )
      expect(result.behavior).toBe('ask')
      expect(result.decisionReason?.type).toBe('safetyCheck')
    } finally {
      platformOverride = null
    }
  })
})

// ── Plan tests #2/#3/#4: bypass-immunity across the three lanes ──

describe('UNC read ask is bypass-immune (plan tests #2-#4)', () => {
  const uncInput = { file_path: '\\\\host\\share\\secret.txt' }

  test('#2 PreToolUse-hook-allow lane: checkRuleBasedPermissions objects (non-null ask), so a hook allow cannot stand', async () => {
    // Real classification feeding the real floor logic.
    const decision = checkReadPermissionForTool(
      fakeReadTool,
      uncInput,
      makePermissionContext(),
    )
    const tool = makeReadTool(decision as PermissionResult)
    const objection = await checkRuleBasedPermissions(
      tool,
      uncInput,
      makeToolUseContext('default'),
    )
    // toolHooks.ts only lets a hook 'allow' stand when this returns null.
    expect(objection).not.toBeNull()
    expect(objection?.behavior).toBe('ask')
  })

  test('#3 auto mode: UNC read is NOT auto-allowed (YOLO allowlist fast-path not taken)', async () => {
    const decision = checkReadPermissionForTool(
      fakeReadTool,
      uncInput,
      makePermissionContext(),
    )
    const tool = makeReadTool(decision as PermissionResult)
    const result = await hasPermissionsToUseTool(
      tool,
      uncInput,
      makeToolUseContext('auto'),
      makeMsg(),
      'tu_unc_auto',
    )
    // Read IS on the auto/YOLO allowlist — the safetyCheck immunity branch
    // must return the ask BEFORE the allowlist fast-path can allow it.
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
  })

  test('#4 bypassPermissions mode: UNC read still prompts (1g floor holds over 2a bypass)', async () => {
    const decision = checkReadPermissionForTool(
      fakeReadTool,
      uncInput,
      makePermissionContext(),
    )
    const tool = makeReadTool(decision as PermissionResult)
    const result = await hasPermissionsToUseTool(
      tool,
      uncInput,
      makeToolUseContext('bypassPermissions'),
      makeMsg(),
      'tu_unc_bypass',
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
  })

  test('regression: ordinary outside-working-dir read is untouched (plain ask, workingDir reason)', () => {
    const result = checkReadPermissionForTool(
      fakeReadTool,
      { file_path: '/definitely/not/inside/any/workdir/x.txt' },
      makePermissionContext(),
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).not.toBe('safetyCheck')
  })
})

// ── OCC-152: the official `Ba` WSL-distro UNC exemption is SURFACE-ONLY ──
//
// checkNetworkMountReadSurface (official AHe) exempts \\wsl.localhost\<distro>\
// and \\wsl$\<distro>\ shares (isDeniedUncPath = isUncPath && !isWslUncPath).
// That exemption does NOT reach the production entry checkReadPermissionForTool
// on Windows: the OCC-111 step-1b leg (containsVulnerableUncPath) re-hits the
// same \\wsl.localhost\ / \\wsl$\ spellings and returns a byte-identical UNC
// safetyCheck ask (and step 2 hasSuspiciousWindowsPathPattern embeds the same
// detector). These tests drive the PRODUCTION ENTRY (not the isolated helper)
// and pin the actual behavior: on Windows a WSL-distro UNC read STILL ASKS.
// No regression vs the pre-292 review base, ask-only, bypass-immune. This is
// deliberately documented rather than "fixed" — see the checkNetworkMountRead
// Surface docblock for why threading the exemption through would weaken the
// ask (downgrade to a classifier-approvable {type:'other'}) or newly allow
// unprompted WSL-distro UNC reads.

describe('WSL-distro UNC: surface exemption vs production entry (OCC-152)', () => {
  const WSL_LOCALHOST = '\\\\wsl.localhost\\Ubuntu\\tmp\\x'
  const WSL_DOLLAR = '\\\\wsl$\\Ubuntu\\file.txt'
  const UNC_REASON = 'UNC path detected (defense-in-depth check)'

  test('isolated AHe surface EXEMPTS the WSL-distro share (official Ba) → null', () => {
    // isUncPath true but isWslUncPath true → isDeniedUncPath false; no
    // automount/kernel surface either → null. This is the exemption the docs
    // claim — but it holds on THIS helper only (see the two tests below).
    expect(
      checkNetworkMountReadSurface(
        fakeReadTool,
        WSL_LOCALHOST,
        [WSL_LOCALHOST],
        {},
      ),
    ).toBeNull()
  })

  test('production entry on WINDOWS: \\\\wsl.localhost\\… STILL asks (step-1b overrides the surface exemption)', () => {
    platformOverride = 'windows'
    try {
      const result = checkReadPermissionForTool(
        fakeReadTool,
        { file_path: WSL_LOCALHOST },
        makePermissionContext(),
      )
      expect(result.behavior).toBe('ask')
      expect(result.decisionReason?.type).toBe('safetyCheck')
      const reason = result.decisionReason as {
        classifierApprovable: boolean
        reason: string
      }
      // Identical UNC safetyCheck ask (bypass-immune), NOT the exemption.
      expect(reason.classifierApprovable).toBe(false)
      expect(reason.reason).toBe(UNC_REASON)
    } finally {
      platformOverride = null
    }
  })

  test('production entry on WINDOWS: \\\\wsl$\\… legacy spelling STILL asks too', () => {
    platformOverride = 'windows'
    try {
      const result = checkReadPermissionForTool(
        fakeReadTool,
        { file_path: WSL_DOLLAR },
        makePermissionContext(),
      )
      expect(result.behavior).toBe('ask')
      expect(result.decisionReason?.type).toBe('safetyCheck')
    } finally {
      platformOverride = null
    }
  })
})
