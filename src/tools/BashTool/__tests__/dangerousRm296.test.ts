/**
 * CC 2.1.296 #050 — bypass-immunity half of the Git-Bash dangerous-rm fix.
 *
 * Changelog entry 50: "Windows: Fixed `rm -rf /c/Users/<name>` in Git Bash
 * not asking in bypass permissions mode." The official dangerousRemoval ask
 * carries `circuitBreaker:"dangerousRemoval"` — no permission rule,
 * bypassPermissions mode, or auto-mode classifier may override it (see
 * src/types/permissions.ts). OCC's critical-path rm ask previously carried
 * decisionReason {type:'other'}, which maybeSuppressForBypass (G6) suppressed
 * to passthrough under bypassPermissions → generic auto-allow. v296 parity:
 * the critical-path ask now carries the official safetyCheck + circuitBreaker
 * shape (same shape the CC 2.1.288 #54 inline-shell port already uses) and
 * survives bypass; the G6 protected-path suppression stays intact for asks
 * WITHOUT the dangerousRemoval breaker.
 *
 * Platform mock follows ripgrepUnreadableWindows292.test.ts (mock before
 * import, toggle flag, restore in afterAll).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from '../../../Tool.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const actualPlatformModule = { ...(await import('../../../utils/platform.js')) }
let platformMockActive = false
mock.module('../../../utils/platform.js', () => ({
  ...actualPlatformModule,
  getPlatform: () =>
    platformMockActive ? 'windows' : actualPlatformModule.getPlatform(),
}))

const { bashToolHasPermission } = await import('../bashPermissions.js')
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
const { getDefaultAppState } = await import('../../../state/AppStateStore.js')
const { BashTool } = await import('../BashTool.js')
const { checkRuleBasedPermissions } = await import(
  '../../../utils/permissions/permissions.js'
)
const { readFileSync } = await import('fs')
const { join } = await import('path')

afterAll(() => {
  platformMockActive = false
  mock.module('../../../utils/platform.js', () => ({
    ...actualPlatformModule,
  }))
})

function makeContext(mode: string): ToolUseContext {
  const permContext = {
    ...getEmptyToolPermissionContext(),
    mode,
  } as ToolPermissionContext
  return {
    getAppState: () => ({
      ...getDefaultAppState(),
      toolPermissionContext: permContext,
    }),
    options: { tools: [] },
  } as unknown as ToolUseContext
}

async function check(command: string, mode: string) {
  return bashToolHasPermission(
    { command, description: '' },
    makeContext(mode),
  )
}

describe('2.1.296 #050: critical-path rm ask is bypass-immune', () => {
  test('default mode: rm -rf /usr asks with the official circuitBreaker shape', async () => {
    const result = await check('rm -rf /usr', 'default')
    expect(result.behavior).toBe('ask')
    expect(result.message).toContain('Dangerous rm operation detected')
    expect(result.decisionReason?.type).toBe('safetyCheck')
    if (result.decisionReason?.type === 'safetyCheck') {
      expect(result.decisionReason.circuitBreaker).toBe('dangerousRemoval')
      expect(result.decisionReason.classifierApprovable).toBe(false)
    }
  })

  test('bypassPermissions: rm -rf /usr still ASKS (was passthrough pre-296)', async () => {
    // The changelog outcome: the dangerousRemoval ask must not be swallowed
    // by --dangerously-skip-permissions. Pre-fix OCC suppressed this to
    // passthrough → generic bypass auto-allow (empirically probed).
    const result = await check('rm -rf /usr', 'bypassPermissions')
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
  })

  test('bypassPermissions: rm -rf / and rm -rf ~ stay hard-denied (regression pin)', async () => {
    // The catastrophic channel (findCatastrophicSubstitutionBlock /
    // dangerousRmAutoDeny) already ran in all modes pre-296 — unchanged.
    for (const command of ['rm -rf /', 'rm -rf ~']) {
      const result = await check(command, 'bypassPermissions')
      expect(result.behavior).toBe('deny')
    }
  })

  test('bypassPermissions: protected-path write asks stay SUPPRESSED (G6 pin)', async () => {
    // maybeSuppressForBypass keeps its G6 contract for safetyCheck asks
    // WITHOUT the dangerousRemoval breaker (.git/.claude/.vscode/shell
    // config writes) — only the dangerous-rm ask is exempt.
    const result = await check('echo x > .git/config', 'bypassPermissions')
    expect(result.behavior).not.toBe('ask')
  })
})

describe('2.1.296 #050: Git-Bash translation reaches the critical-path check', () => {
  test('windows: rm -rf /c/Users asks even under bypassPermissions', async () => {
    platformMockActive = true
    try {
      // Full changelog chain: '/c/Users' → qwr → 'C:\Users' → drive-child
      // arm of isDangerousRemovalPath → safetyCheck ask with breaker →
      // maybeSuppressForBypass exemption → ask survives bypass. (On a real
      // Windows box '/c/Users/<name>' is the home arm; the drive-child arm
      // is the testable-here equivalent.)
      const result = await check('rm -rf /c/Users', 'bypassPermissions')
      expect(result.behavior).toBe('ask')
      expect(result.decisionReason?.type).toBe('safetyCheck')
      expect(result.message).toContain('Dangerous rm operation detected')
      // The ask message embeds the RAW absolutePath ('/c/Users'); the
      // translation to 'C:\Users' happens only inside the danger predicate
      // (official wwe/Xun shape: check original first, then translated).
      expect(result.message).toContain('/c/Users')
    } finally {
      platformMockActive = false
    }
  })

  test('windows: rm -rf /cygdrive/c asks under bypassPermissions too', async () => {
    platformMockActive = true
    try {
      const result = await check('rm -rf /cygdrive/c', 'bypassPermissions')
      expect(result.behavior).toBe('ask')
      expect(result.decisionReason?.type).toBe('safetyCheck')
    } finally {
      platformMockActive = false
    }
  })

  test('linux: rm -rf /c/Users is NOT a critical-path ask (translation is windows-gated)', async () => {
    // On linux '/c/Users' is an ordinary out-of-workspace path: it must not
    // become a dangerousRemoval safetyCheck ask (platform guard parity with
    // the official `if(O()!=="windows")return`).
    const result = await check('rm -rf /c/Users', 'default')
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).not.toBe('safetyCheck')
  })
})

describe('2.1.296 #050: --dangerously-skip-protected-paths must not swallow the breaker', () => {
  const SKIP_FLAG = 'CLAUDE_CODE_SKIP_PROTECTED_PATHS'
  const savedFlag = process.env[SKIP_FLAG]
  afterAll(() => {
    if (savedFlag === undefined) {
      delete process.env[SKIP_FLAG]
    } else {
      process.env[SKIP_FLAG] = savedFlag
    }
  })

  test('step 1g (checkRuleBasedPermissions): flag ON, rm -rf /usr still ASKS with the breaker', async () => {
    process.env[SKIP_FLAG] = '1'
    try {
      const result = await checkRuleBasedPermissions(
        BashTool,
        { command: 'rm -rf /usr' },
        makeContext('default'),
      )
      expect(result?.behavior).toBe('ask')
      expect(result?.decisionReason?.type).toBe('safetyCheck')
      if (result?.decisionReason?.type === 'safetyCheck') {
        expect(result.decisionReason.circuitBreaker).toBe('dangerousRemoval')
      }
    } finally {
      delete process.env[SKIP_FLAG]
    }
  })

  test('step 1g stays NARROW: flag ON, ordinary protected-path ask is still skipped (null)', async () => {
    // The guard must not break the flag's actual contract: safetyCheck asks
    // WITHOUT the dangerousRemoval breaker (.git/.claude/.vscode/shell config
    // writes) keep returning null (no objection) when the flag is set.
    process.env[SKIP_FLAG] = '1'
    try {
      const result = await checkRuleBasedPermissions(
        BashTool,
        { command: 'echo x > .git/config' },
        makeContext('default'),
      )
      const isBreakerAsk =
        result?.behavior === 'ask' &&
        result.decisionReason?.type === 'safetyCheck' &&
        result.decisionReason.circuitBreaker === 'dangerousRemoval'
      expect(isBreakerAsk).toBe(false)
      expect(result === null || result?.behavior === 'passthrough').toBe(true)
    } finally {
      delete process.env[SKIP_FLAG]
    }
  })

  test('step 1g (hasPermissionsToUseToolInner site): guard is present at BOTH flag sites (source-anchored pin)', () => {
    // The outer wrapper pulls in the hook + classifier chain that cannot be
    // imported hermetically under bun test — pinned with source-anchored
    // readFileSync assertions (established OCC convention, see
    // uncSafetyCheck292.test.ts / hookJudgment294.test.ts).
    const permissionsSrc = readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        '..',
        'utils',
        'permissions',
        'permissions.ts',
      ),
      'utf8',
    )
    const guarded =
      /isSkipProtectedPathsEnabled\(\) &&\s*toolPermissionResult\.decisionReason\.circuitBreaker !== 'dangerousRemoval'/g
    expect((permissionsSrc.match(guarded) ?? []).length).toBe(2)
    // No UNGUARDED flag site may remain (an unguarded site reads
    // `isSkipProtectedPathsEnabled()) {` — the if-paren closes immediately).
    const unguarded = /isSkipProtectedPathsEnabled\(\)\s*\)\s*\{/g
    expect((permissionsSrc.match(unguarded) ?? []).length).toBe(0)
  })
})
