import { afterAll, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.292 security fix — FileReadTool pre-I/O UNC reject gate (Step C of
 * docs/gap-research-293/security-cluster-292.md §1.3).
 *
 * Official changelog (verbatim):
 *   "Security: Fixed PreToolUse hook approvals and auto mode bypassing the
 *    permission prompt for file reads from network (UNC) paths"
 *
 * The official (B) layer is a hard pre-I/O REJECT (`rtn` gate, reason map
 * `kr.untrusted_unc`) inside read_file's validation, with the verbatim reason
 * string:
 *   "read_file: untrusted UNC path rejected before filesystem access"
 *
 * A validateInput reject cannot be short-circuited by a PreToolUse hook
 * 'allow' or by auto/bypass mode — it fires before any filesystem access.
 *
 * OCC scope decision (KISS option (ii) per §1.3): OCC has no
 * `trustedNetworkDirectories` settings field, so the gate rejects ALL UNC
 * reads — plan test #6 is adapted below to assert this documented divergence.
 */

// ── platform override (containsVulnerableUncPath detection is windows-gated,
//    mirroring the official platform gating) ──

// Mock hygiene per the OCC-97 lesson (sandboxLocalBinding281.test.ts):
// snapshot the real namespace into a PLAIN object BEFORE mocking — spreading
// the live namespace inside the factory recurses into the mock and deadlocks.
const actualPlatformModule = await import('../../../utils/platform.js')
const actualPlatformExports = { ...actualPlatformModule }
let platformOverride: 'windows' | null = null

mock.module('../../../utils/platform.js', () => ({
  ...actualPlatformExports,
  getPlatform: () => platformOverride ?? actualPlatformExports.getPlatform(),
}))

afterAll(() => {
  platformOverride = null
  mock.module('../../../utils/platform.js', () => ({
    ...actualPlatformExports,
  }))
})

// Import AFTER the platform mock so FileReadTool's transitive
// readOnlyCommandValidation import sees the override.
const { FileReadTool } = await import('../FileReadTool.js')

const UNC_REJECT_MESSAGE =
  'read_file: untrusted UNC path rejected before filesystem access'

function contextWithNoRules() {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        alwaysDenyRules: {},
        alwaysAllowRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map(),
      },
    }),
  } as never
}

/** Same as above but with a UNC directory listed as an allowed working dir. */
function contextWithUncWorkingDir(uncDir: string) {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        alwaysDenyRules: {},
        alwaysAllowRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map([
          [uncDir, { source: 'user' }],
        ]),
      },
    }),
  } as never
}

describe('FileReadTool UNC reject gate (CC 2.1.292)', () => {
  test('rejects a backslash UNC path before filesystem access (verbatim official reason)', async () => {
    platformOverride = 'windows'
    try {
      const result = await FileReadTool.validateInput(
        { file_path: '\\\\host\\share\\file.txt' } as never,
        contextWithNoRules(),
      )
      expect(result.result).toBe(false)
      expect(result.message).toBe(UNC_REJECT_MESSAGE)
      expect((result as { errorCode?: number }).errorCode).toBe(1)
    } finally {
      platformOverride = null
    }
  })

  test('rejects a WebDAV DavWWWRoot path with the trigger NOT at position 0 (anywhere-match)', async () => {
    platformOverride = 'windows'
    try {
      const result = await FileReadTool.validateInput(
        { file_path: 'C:\\share\\DavWWWRoot\\x.txt' } as never,
        contextWithNoRules(),
      )
      expect(result.result).toBe(false)
      expect(result.message).toBe(UNC_REJECT_MESSAGE)
    } finally {
      platformOverride = null
    }
  })

  test('rejects an @SSL@443 WebDAV port path (anywhere-match, no UNC prefix)', async () => {
    platformOverride = 'windows'
    try {
      const result = await FileReadTool.validateInput(
        { file_path: 'C:\\cache\\srv@SSL@8443\\x.txt' } as never,
        contextWithNoRules(),
      )
      expect(result.result).toBe(false)
      expect(result.message).toBe(UNC_REJECT_MESSAGE)
    } finally {
      platformOverride = null
    }
  })

  test('adapted plan #6 (documented divergence): UNC inside additionalWorkingDirectories is STILL rejected — OCC option (ii) has no trustedNetworkDirectories allowance', async () => {
    platformOverride = 'windows'
    try {
      const result = await FileReadTool.validateInput(
        { file_path: '\\\\trusted.corp\\share\\report.docx' } as never,
        contextWithUncWorkingDir('\\\\trusted.corp\\share'),
      )
      expect(result.result).toBe(false)
      expect(result.message).toBe(UNC_REJECT_MESSAGE)
    } finally {
      platformOverride = null
    }
  })

  test('regression: an ordinary local path is not rejected (gate is string-only, no I/O)', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: '/tmp/occ-unc-gate-plain.txt' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(true)
  })

  test('regression: windows-shaped paths on a POSIX runtime are plain local filenames (official platform gating — containsVulnerableUncPath is windows-only)', async () => {
    // No platform override: on POSIX, 'C:\share\DavWWWRoot\x.txt' resolves to
    // a literal local filename under cwd — no network surface exists, so the
    // gate (like the official detection) stays platform-gated.
    const result = await FileReadTool.validateInput(
      { file_path: 'C:\\share\\DavWWWRoot\\x.txt' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(true)
  })
})
