/**
 * CC 2.1.304 #10 — mounted-drive `rm -r` safety prompt.
 *
 * Official changelog 304 #10: recursive `rm` against a mounted drive (macOS
 * `/Volumes`, `/System/Volumes`; Linux `/mnt/<name>`, WSL `/mnt/<l>/<name>`;
 * `/media`, `/run/media` + shallow children) now asks with a dedicated
 * 3-paragraph message and a `circuitBreaker:'dangerousRemoval'` safetyCheck
 * decisionReason (no permission rule, bypass mode, or classifier may
 * auto-allow). The arm is DEFERRED in the official analyzer (`XG`: only runs
 * when no earlier arm produced a result) and is gated by
 * `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT` (raw truthiness) +
 * `GX()`/`tengu_bright_lake` (default-on → always-on in OCC per the tengu_*
 * porting convention, destructiveCommandWarning.ts:1416). Shape telemetry:
 * official `yze` classifier's third value `"mounted_drive_path"` feeds
 * `tengu_bash_dangerous_rm_shape`.
 *
 * Harness follows dangerousRm296.test.ts (MACRO polyfill guard, mock.module
 * before import, bashToolHasPermission integration).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from '../../../Tool.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// Capture analytics so the shape-telemetry assertion has a spy (the analytics
// package is a stubbed no-op in OCC; mock.module must precede the imports).
const actualAnalytics = {
  ...(await import('../../../services/analytics/index.js')),
}
const loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    loggedEvents.push({ name, metadata: metadata ?? {} })
  },
}))

const {
  hasRecursiveRmFlagV304,
  MOUNTED_DRIVE_PATH_RE,
  MOUNTED_DRIVE_RM_KILL_SWITCH_ENV_VAR,
} = await import('../pathValidation.js')
const { bashToolHasPermission } = await import('../bashPermissions.js')
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
const { getDefaultAppState } = await import('../../../state/AppStateStore.js')

afterAll(() => {
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalytics,
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

// PermissionResult is a discriminated union whose non-ask arms lack
// `message`/`suggestions`; the harness widens it once so the assertions below
// read without repeated narrowing (runtime behavior is unchanged).
type CheckResult = {
  behavior: string
  message?: string
  decisionReason?: {
    type?: string
    reason?: string
    classifierApprovable?: boolean
    circuitBreaker?: string
  }
  suggestions?: unknown[]
}

async function check(
  command: string,
  mode = 'default',
): Promise<CheckResult> {
  return (await bashToolHasPermission(
    { command, description: '' },
    makeContext(mode),
  )) as unknown as CheckResult
}

function isMountedDriveAsk(result: CheckResult): boolean {
  return (
    result.decisionReason?.type === 'safetyCheck' &&
    result.decisionReason.circuitBreaker === 'dangerousRemoval'
  )
}

// The official 3-paragraph ask message, byte-verbatim (ver @246328119–246332549)
// for display='/Volumes/Backup'.
const VERBATIM_MESSAGE =
  `Dangerous rm operation detected: '/Volumes/Backup'\n\n` +
  `This command would remove a mounted drive, the folder that holds mounted drives, or a file or folder at the top level of a drive. This requires explicit approval and cannot be auto-allowed by permission rules.\n\n` +
  `If you meant something deeper inside, name it by its full path.`

describe('2.1.304 #10: G$o regex is byte-verbatim', () => {
  test('MOUNTED_DRIVE_PATH_RE source + flags match the official binary constant', () => {
    expect(MOUNTED_DRIVE_PATH_RE.source).toBe(
      String.raw`^\/(?:system\/)?volumes(?:\/[^/]+){0,2}$|^\/mnt\/(?:[^/]+|[a-z]\/[^/]+)$|^\/(?:run\/)?media(?:\/[^/]+){0,3}$`,
    )
    expect(MOUNTED_DRIVE_PATH_RE.flags).toBe('i')
  })

  test('regex accepts/rejects the official coverage table', () => {
    const matching = [
      '/Volumes',
      '/Volumes/Backup',
      '/Volumes/Backup/photos', // ≤2 children: top-level folder of a drive
      '/System/Volumes',
      '/System/Volumes/Data',
      '/system/volumes/data', // case-insensitive
      '/mnt/data',
      '/mnt/c/Users', // WSL
      '/media',
      '/media/user',
      '/media/user/usb',
      '/media/user/usb/part1', // ≤3 children
      '/run/media/user/usb',
    ]
    const nonMatching = [
      '/Volumes/Backup/photos/2024', // 3 children — too deep
      '/mnt', // parent of the mount folder, not a mount itself
      '/mnt/data/x', // below a Linux mount
      '/mnt/cd/extra/deep',
      '/media/user/usb/part1/x', // 4 children — too deep
      '/home/user/Volumes/Backup', // not rooted at /Volumes
      'Volumes/Backup', // relative
    ]
    for (const path of matching) {
      expect(MOUNTED_DRIVE_PATH_RE.test(path)).toBe(true)
    }
    for (const path of nonMatching) {
      expect(MOUNTED_DRIVE_PATH_RE.test(path)).toBe(false)
    }
  })
})

describe('2.1.304 #10: hasRecursiveRmFlagV304 (official `_e` detector)', () => {
  test('static recursive flag forms are detected', () => {
    expect(hasRecursiveRmFlagV304(['-rf', '/Volumes/Backup'])).toBe(true)
    expect(hasRecursiveRmFlagV304(['-r', '-f'])).toBe(true)
    expect(hasRecursiveRmFlagV304(['-fr'])).toBe(true)
    expect(hasRecursiveRmFlagV304(['-R'])).toBe(true)
    expect(hasRecursiveRmFlagV304(['--recursive'])).toBe(true)
    expect(hasRecursiveRmFlagV304(['--remove'])).toBe(true) // /^--r/ official
  })

  test('non-recursive forms are not detected', () => {
    expect(hasRecursiveRmFlagV304([])).toBe(false)
    expect(hasRecursiveRmFlagV304(['-f', '/x'])).toBe(false)
    expect(hasRecursiveRmFlagV304(['-i'])).toBe(false)
    expect(hasRecursiveRmFlagV304(['/Volumes/Backup'])).toBe(false)
  })

  test('only flags BEFORE the first `--` count (official slice)', () => {
    expect(hasRecursiveRmFlagV304(['--', '--recursive'])).toBe(false)
    expect(hasRecursiveRmFlagV304(['-f', '--', '-rf'])).toBe(false)
    expect(hasRecursiveRmFlagV304(['-rf', '--'])).toBe(true)
  })

  test('dynamic expansion fragments are detected (OCC untokenized adaptation)', () => {
    // shell-quote fragments of `-$(echo r)f`: the `-$` piece leads with `-`,
    // carries no `/`, and bears a raw `$` expansion marker.
    expect(hasRecursiveRmFlagV304(['-$', '(', 'echo', 'r', ')f'])).toBe(true)
    // Backtick form
    expect(hasRecursiveRmFlagV304(['-`echo r`'])).toBe(true)
    // Official placeholder forms
    expect(hasRecursiveRmFlagV304(['__CMDSUB__'])).toBe(true)
    expect(hasRecursiveRmFlagV304(['__CMDSUB_OUTPUT__x'])).toBe(true)
    expect(hasRecursiveRmFlagV304(['__TRACKED_VAR__flags'])).toBe(true)
  })

  test('dynamic forms with `/` or without a flag/placeholder lead are rejected', () => {
    expect(hasRecursiveRmFlagV304(['-x/y$z'])).toBe(false) // contains `/`
    expect(hasRecursiveRmFlagV304(['$(pwd)'])).toBe(false) // no flag lead
    expect(hasRecursiveRmFlagV304(['$FLAGS'])).toBe(false) // no flag lead
  })
})

describe('2.1.304 #10: mounted-drive rm ask (integration via bashToolHasPermission)', () => {
  beforeAll(() => {
    delete process.env[MOUNTED_DRIVE_RM_KILL_SWITCH_ENV_VAR]
  })

  test('rm -rf /Volumes/Backup asks with the verbatim message + breaker shape', async () => {
    loggedEvents.length = 0
    const result = await check('rm -rf /Volumes/Backup')

    expect(result.behavior).toBe('ask')
    expect(result.message).toBe(VERBATIM_MESSAGE)
    expect(result.decisionReason).toEqual({
      type: 'safetyCheck',
      reason: 'Dangerous rm operation on mounted drive path: /Volumes/Backup',
      classifierApprovable: false,
      circuitBreaker: 'dangerousRemoval',
    })
    expect(result.suggestions ?? []).toEqual([])
    // Official shape classifier third value feeds tengu_bash_dangerous_rm_shape
    expect(loggedEvents).toContainEqual({
      name: 'tengu_bash_dangerous_rm_shape',
      metadata: { shape: 'mounted_drive_path' },
    })
  })

  test('rm -rf /mnt/data (Linux mount) asks', async () => {
    const result = await check('rm -rf /mnt/data')
    expect(result.behavior).toBe('ask')
    expect(isMountedDriveAsk(result)).toBe(true)
    expect(result.message).toContain("Dangerous rm operation detected: '/mnt/data'")
  })

  test('rm -rf /mnt/c/Users (WSL two-level form) asks', async () => {
    const result = await check('rm -rf /mnt/c/Users')
    expect(result.behavior).toBe('ask')
    expect(isMountedDriveAsk(result)).toBe(true)
  })

  test('trailing slash is stripped before the match (official normalize step)', async () => {
    const result = await check('rm -rf /mnt/data/')
    expect(result.behavior).toBe('ask')
    expect(isMountedDriveAsk(result)).toBe(true)
  })

  test('matching is case-insensitive', async () => {
    const result = await check('rm -rf /VOLUMES/Backup')
    expect(result.behavior).toBe('ask')
    expect(isMountedDriveAsk(result)).toBe(true)
  })

  test('paths deeper than the coverage table do NOT get the mounted-drive ask', async () => {
    const result = await check('rm -rf /Volumes/Backup/photos/2024/jan')
    // Still an ask (outside the working dir) — but NOT the safetyCheck breaker
    expect(result.behavior).toBe('ask')
    expect(isMountedDriveAsk(result)).toBe(false)
  })

  test('non-recursive rm does NOT fire the arm', async () => {
    const result = await check('rm /Volumes/Backup')
    expect(isMountedDriveAsk(result)).toBe(false)
  })

  test('rmdir never fires the arm (official: rm only)', async () => {
    const result = await check('rmdir /Volumes/Backup')
    expect(isMountedDriveAsk(result)).toBe(false)
  })

  test('bypassPermissions: the breaker ask survives (circuitBreaker contract)', async () => {
    const result = await check('rm -rf /Volumes/Backup', 'bypassPermissions')
    expect(result.behavior).toBe('ask')
    expect(isMountedDriveAsk(result)).toBe(true)
  })

  test('critical-path arm keeps priority (deferred-arm semantics)', async () => {
    // `rm -rf /` is catastrophic (hard deny upstream of the analyzer) and
    // `rm -rf /usr` hits the critical-path arm — the mounted-drive arm must
    // not shadow either.
    const root = await check('rm -rf /')
    expect(root.behavior).toBe('deny')
    const usr = await check('rm -rf /usr')
    expect(usr.behavior).toBe('ask')
    expect(usr.message).toContain('critical system directory')
  })
})

describe('2.1.304 #10: kill-switch CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT', () => {
  const saved = process.env[MOUNTED_DRIVE_RM_KILL_SWITCH_ENV_VAR]
  afterAll(() => {
    if (saved === undefined) {
      delete process.env[MOUNTED_DRIVE_RM_KILL_SWITCH_ENV_VAR]
    } else {
      process.env[MOUNTED_DRIVE_RM_KILL_SWITCH_ENV_VAR] = saved
    }
  })

  test('env var name is the official byte-verbatim constant', () => {
    expect(MOUNTED_DRIVE_RM_KILL_SWITCH_ENV_VAR).toBe(
      'CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT',
    )
  })

  test('any non-empty value disables the arm (raw truthiness, even "0")', async () => {
    process.env[MOUNTED_DRIVE_RM_KILL_SWITCH_ENV_VAR] = '0'
    try {
      const result = await check('rm -rf /Volumes/Backup')
      expect(isMountedDriveAsk(result)).toBe(false)
    } finally {
      delete process.env[MOUNTED_DRIVE_RM_KILL_SWITCH_ENV_VAR]
    }
  })

  test('arm re-fires after the kill-switch is removed', async () => {
    const result = await check('rm -rf /Volumes/Backup')
    expect(isMountedDriveAsk(result)).toBe(true)
  })
})
