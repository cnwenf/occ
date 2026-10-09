import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { PermissionResult } from '../../../types/permissions.js'
import {
  checkNetworkMountReadSurface,
  checkReadPermissionForTool,
  networkMountSafetyAsk,
} from '../filesystem.js'
import { checkRuleBasedPermissions } from '../permissions.js'

// The permission path reads MACRO.VERSION (via getBundledSkillsRoot) at runtime.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * OCC-150 (CC 2.1.292 P0 security): pins on the ported official read-side
 * network-mount defense-in-depth surface — `AHe` @17945150 + `Xe` @17962440 of
 * the 2.1.292 linux-x64 ELF (byte-verified from the s292 strings dump).
 *
 * The changelog fix ("PreToolUse hook approvals + auto mode bypassing the
 * prompt for UNC network paths") is realized by flipping the ask's
 * decisionReason from the pre-292 `{type:'other'}` to a NON-classifier-approvable
 * `{type:'safetyCheck', classifierApprovable:false}` (official `Xe`). Two
 * independent bypasses are closed and both are pinned here:
 *
 *  1. PreToolUse-hook-allow bypass — checkRuleBasedPermissions step 1g only
 *     propagates safetyCheck/subcommandResults/rule asks (official `NA`/`Nd`);
 *     a `{type:'other'}` ask fell through to null and the hook allow stood.
 *  2. auto-mode-classifier bypass — the wrapper's immunity block only catches
 *     `type==='safetyCheck' && !classifierApprovable` (official `Nt`); anything
 *     else flowed to the transcript classifier which could approve it.
 *
 * Pure surface logic (checkNetworkMountReadSurface / networkMountSafetyAsk /
 * checkReadPermissionForTool) is tested by import; the auto-mode immunity half
 * lives in the hasPermissionsToUseTool wrapper, which pulls in the hook +
 * classifier chain that cannot be imported hermetically under `bun test`, so it
 * is pinned with source-anchored readFileSync assertions (established OCC
 * convention — see hookJudgment294.test.ts).
 */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const filesystemSrc = readFileSync(
  join(REPO_ROOT, 'src/utils/permissions/filesystem.ts'),
  'utf8',
)
const permissionsSrc = readFileSync(
  join(REPO_ROOT, 'src/utils/permissions/permissions.ts'),
  'utf8',
)

// Official reason strings (byte-verbatim from `AHe` @17945150). Pinned
// independently here so any drift in filesystem.ts fails loudly.
const UNC_PATH_ASK_REASON = 'UNC path detected (defense-in-depth check)'
const AUTOMOUNT_HOSTS_ASK_REASON =
  'Automount -hosts path detected (defense-in-depth check)'
const KERNEL_RESOLVED_ASK_REASON =
  'Kernel-resolved path prefix (/.vol etc.) detected (defense-in-depth check)'
const UNC_GLOB_ASK_REASON = 'UNC glob pattern detected (defense-in-depth check)'
const AUTOMOUNT_HOSTS_GLOB_ASK_REASON =
  'Automount -hosts glob pattern detected (defense-in-depth check)'
const KERNEL_RESOLVED_GLOB_ASK_REASON =
  'Kernel-resolved path prefix (/.vol etc.) glob pattern detected (defense-in-depth check)'

const readTool = { name: 'Read' } as unknown as Tool
const globTool = { name: 'Glob' } as unknown as Tool

/** Direct AHe call with a single-spelling pathsToCheck (isolates the surface). */
function surface(
  tool: Tool,
  path: string,
  input: Record<string, unknown> = {},
) {
  return checkNetworkMountReadSurface(tool, path, [path], input)
}

function reasonOf(decision: unknown): {
  type?: string
  classifierApprovable?: boolean
  reason?: string
} {
  return (decision as { decisionReason?: never })?.decisionReason ?? {}
}

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'occ-unc292-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Xe — the official safety-ask builder shape
// ---------------------------------------------------------------------------
describe('2.1.292 networkMountSafetyAsk (official Xe @17962440)', () => {
  test('builds the exact non-classifier-approvable safetyCheck ask', () => {
    expect(networkMountSafetyAsk('MSG', 'RSN')).toEqual({
      behavior: 'ask',
      message: 'MSG',
      decisionReason: {
        type: 'safetyCheck',
        classifierApprovable: false,
        reason: 'RSN',
      },
    })
  })
})

// ---------------------------------------------------------------------------
// AHe — read-side network-mount surface (path arms)
// ---------------------------------------------------------------------------
describe('2.1.292 checkNetworkMountReadSurface — path arms (official AHe)', () => {
  test('UNC path (// host) → safetyCheck ask with the UNC reason', () => {
    const r = surface(readTool, '//evil.example.com/share/data.txt')
    expect(r?.behavior).toBe('ask')
    const reason = reasonOf(r)
    expect(reason.type).toBe('safetyCheck')
    expect(reason.classifierApprovable).toBe(false)
    expect(reason.reason).toBe(UNC_PATH_ASK_REASON)
    expect(r?.message).toContain('//evil.example.com/share/data.txt')
    expect(r?.message).toContain('appears to be a UNC path')
  })

  test('UNC path (\\\\ host, backslash form) → safetyCheck ask', () => {
    const r = surface(readTool, '\\\\evil.example.com\\share')
    expect(r?.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(UNC_PATH_ASK_REASON)
    expect(reasonOf(r).type).toBe('safetyCheck')
  })

  test('Windows device-namespace path (\\??\\) is treated as UNC (superset)', () => {
    const r = surface(readTool, '\\??\\evil')
    expect(r?.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(UNC_PATH_ASK_REASON)
    expect(reasonOf(r).classifierApprovable).toBe(false)
  })

  test('WSL-distro UNC share is EXEMPT on this surface (official Ba) → null', () => {
    // \\\\wsl.localhost\Ubuntu\tmp\x — isUncPath true but isWslUncPath true →
    // isDeniedUncPath false. No automount/kernel surface either → null.
    // SCOPE (OCC-152): the exemption holds on the ISOLATED AHe surface only.
    // In the production entry checkReadPermissionForTool the OCC-side step-1b
    // leg (containsVulnerableUncPath, Windows-gated) re-hits \\wsl.localhost\ /
    // \\wsl$\ spellings, so on Windows a WSL-distro UNC read STILL asks
    // (safetyCheck, bypass-immune) — pinned by the Windows-gated integration
    // tests in filesystem.unc.test.ts. Do not read this null as "WSL UNC reads
    // are allowed end-to-end".
    expect(surface(readTool, '\\\\wsl.localhost\\Ubuntu\\tmp\\x')).toBeNull()
  })

  test('automount -hosts path (/net/<host>/…) → safetyCheck ask', () => {
    const r = surface(readTool, '/net/evil.example.com/exports/data')
    expect(r?.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(AUTOMOUNT_HOSTS_ASK_REASON)
    expect(r?.message).toContain('/net automount map')
    expect(r?.message).toContain('DNS lookup and NFS mount')
  })

  test('bare folded /net → automount -hosts safetyCheck ask', () => {
    const r = surface(readTool, '/net')
    expect(r?.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(AUTOMOUNT_HOSTS_ASK_REASON)
  })

  test('kernel-resolved prefix (/.vol/…) → safetyCheck ask', () => {
    const r = surface(readTool, '/.vol/evil.example.com/data')
    expect(r?.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(KERNEL_RESOLVED_ASK_REASON)
    expect(r?.message).toContain('/.vol, /.file, /.nofollow or /.resolve')
  })

  test('benign in-repo path → null (no false positive)', () => {
    expect(surface(readTool, '/home/user/project/package.json')).toBeNull()
  })

  test('/Network/Servers/<host>/… IS an automount-hosts map prefix (Hi) → asks on ALL platforms', () => {
    // isAutomountPrefixPath (official Hi/Vhe) matches /Network/Servers/<host>
    // and is NOT macOS-gated, so this fires even on linux (safe: ask, not deny).
    const r = surface(readTool, '/Network/Servers/evil.example.com/data')
    expect(r?.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(AUTOMOUNT_HOSTS_ASK_REASON)
  })

  test('browse-ONLY surface (/network/<x>, not a map prefix) is macOS-gated (Ax stub `return!1`) → null on linux', () => {
    // isAutomountBrowsePath matches (first segment 'network'), but it is NOT an
    // automount-hosts map prefix (Hi/Hb) nor kernel/UNC. Official Ax is
    // `return!1` on linux; OCC gates it on getPlatform()==='macos', so no ask
    // here. (On macOS this same path returns AUTOMOUNT_BROWSE_ASK_REASON.)
    expect(surface(readTool, '/network/shared/data')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AHe — Glob pattern arm (official `e.name===ao`, ao="Glob")
// ---------------------------------------------------------------------------
describe('2.1.292 checkNetworkMountReadSurface — Glob arm (official AHe glob branch)', () => {
  test('UNC glob pattern → safetyCheck ask with the raw pattern in the message', () => {
    const r = surface(globTool, '/some/dir', { pattern: '//evil/**/*.ts' })
    expect(r?.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(UNC_GLOB_ASK_REASON)
    expect(reasonOf(r).classifierApprovable).toBe(false)
    // Glob messages interpolate the RAW pattern (no display escaping), official.
    expect(r?.message).toContain('to glob //evil/**/*.ts')
    expect(r?.message).toContain('UNC pattern')
  })

  test('automount -hosts glob pattern → safetyCheck ask', () => {
    const r = surface(globTool, '/some/dir', { pattern: '/net/x/**' })
    expect(r?.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(AUTOMOUNT_HOSTS_GLOB_ASK_REASON)
    expect(r?.message).toContain('to glob /net/x/**')
  })

  test('kernel-resolved glob pattern → safetyCheck ask', () => {
    const r = surface(globTool, '/some/dir', { pattern: '/.vol/x/*' })
    expect(r?.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(KERNEL_RESOLVED_GLOB_ASK_REASON)
  })

  test('the glob arm does NOT fire for a non-Glob tool with the same pattern', () => {
    // Read tool with a UNC-looking `pattern` field: no glob branch (name!=Glob),
    // and the benign path/spellings produce null.
    expect(surface(readTool, '/some/dir', { pattern: '//evil/**/*.ts' })).toBeNull()
  })

  test('benign glob pattern → null', () => {
    expect(surface(globTool, '/some/dir', { pattern: 'src/**/*.ts' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// checkReadPermissionForTool — end-to-end wiring (getPath → AHe → early return)
// ---------------------------------------------------------------------------
function makePathReadTool(): Tool {
  return {
    name: 'Read',
    getPath: (input: { file_path?: unknown }) => String(input.file_path),
    userFacingName: () => 'Read',
    inputSchema: {
      parse: (i: unknown) => i,
      safeParse: (i: unknown) => ({ success: true, data: i }),
    },
    checkPermissions: async () => ({ behavior: 'allow', message: '' }),
    description: async () => 'Read',
    requiresUserInteraction: undefined,
    isMcp: false,
  } as unknown as Tool
}

describe('2.1.292 checkReadPermissionForTool integration', () => {
  test('a UNC read returns the safetyCheck ask (step 1, before deny/ask rules)', () => {
    // '//' short-circuits getPathsForPermissionCheck → zero fs access, hermetic.
    const r = checkReadPermissionForTool(
      makePathReadTool(),
      { file_path: '//evil.example.com/share/data.txt' },
      getEmptyToolPermissionContext(),
    )
    expect(r.behavior).toBe('ask')
    const reason = reasonOf(r)
    expect(reason.type).toBe('safetyCheck')
    expect(reason.classifierApprovable).toBe(false)
    expect(reason.reason).toBe(UNC_PATH_ASK_REASON)
    expect(r.message).toContain('//evil.example.com/share/data.txt')
  })

  test('a UNC Glob pattern reaches the glob arm end-to-end', () => {
    const dir = mkTmp() // real, benign base dir → getPathsForPermissionCheck is safe
    const tool = {
      name: 'Glob',
      getPath: () => dir,
      userFacingName: () => 'Glob',
      inputSchema: {
        parse: (i: unknown) => i,
        safeParse: (i: unknown) => ({ success: true, data: i }),
      },
      checkPermissions: async () => ({ behavior: 'allow', message: '' }),
      description: async () => 'Glob',
      requiresUserInteraction: undefined,
      isMcp: false,
    } as unknown as Tool
    const r = checkReadPermissionForTool(
      tool,
      { pattern: '//evil/**/*.ts' },
      getEmptyToolPermissionContext(),
    )
    expect(r.behavior).toBe('ask')
    expect(reasonOf(r).reason).toBe(UNC_GLOB_ASK_REASON)
  })
})

// ---------------------------------------------------------------------------
// Bypass half 1 — PreToolUse-hook-allow: checkRuleBasedPermissions propagation
// (official NA/Nd: only safetyCheck/subcommandResults/rule asks survive a hook
// allow; a {type:'other'} ask falls through to null → the hook allow stood)
// ---------------------------------------------------------------------------
function makeTool(checkPermissionsResult: PermissionResult): Tool {
  return {
    name: 'Read',
    userFacingName: () => 'Read',
    inputSchema: {
      parse: (input: unknown) => input,
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    checkPermissions: async () => checkPermissionsResult,
    description: async () => 'Read',
    requiresUserInteraction: undefined,
    isMcp: false,
  } as unknown as Tool
}

function makeContext(mode = 'default'): ToolUseContext {
  return {
    abortController: { signal: { aborted: false } },
    getAppState: () => ({
      toolPermissionContext: {
        mode,
        shouldAvoidPermissionPrompts: false,
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
      },
    }),
    options: { isNonInteractiveSession: false, tools: [] },
  } as unknown as ToolUseContext
}

describe('2.1.292 hook-allow bypass closed — checkRuleBasedPermissions (step 1g)', () => {
  test('the UNC safetyCheck ask PROPAGATES (a hook allow cannot bypass it)', async () => {
    const ask = networkMountSafetyAsk(
      'Claude requested permissions to read from //evil…, which appears to be a UNC path that could access network resources.',
      UNC_PATH_ASK_REASON,
    ) as PermissionResult
    const result = await checkRuleBasedPermissions(
      makeTool(ask),
      { file_path: '//evil.example.com/share' },
      makeContext(),
    )
    expect(result).not.toBeNull()
    expect(result?.behavior).toBe('ask')
    expect(reasonOf(result).type).toBe('safetyCheck')
  })

  test('CONTRAST: the pre-292 {type:"other"} UNC ask is DROPPED (the live bypass)', async () => {
    const legacyAsk = {
      behavior: 'ask',
      message: 'UNC path detected',
      decisionReason: { type: 'other', reason: UNC_PATH_ASK_REASON },
    } as PermissionResult
    const result = await checkRuleBasedPermissions(
      makeTool(legacyAsk),
      { file_path: '//evil.example.com/share' },
      makeContext(),
    )
    // Neither step 1f (rule ask) nor 1g (safetyCheck) matches → null → a
    // PreToolUse hook allow would have stood. This is exactly the 2.1.292 bug.
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Bypass half 2 — auto-mode classifier: immunity block source pins
// ---------------------------------------------------------------------------
describe('2.1.292 auto-mode bypass closed — source pins', () => {
  test('permissions.ts immunity block gates on safetyCheck + !classifierApprovable', () => {
    expect(permissionsSrc).toContain(
      "result.decisionReason?.type === 'safetyCheck'",
    )
    expect(permissionsSrc).toContain('!result.decisionReason.classifierApprovable')
  })

  test('filesystem.ts networkMountSafetyAsk sets classifierApprovable: false', () => {
    expect(filesystemSrc).toContain('classifierApprovable: false')
    expect(filesystemSrc).toContain('export function networkMountSafetyAsk(')
  })

  test('filesystem.ts step 1 is now the network-mount surface (pre-292 UNC-only block removed)', () => {
    expect(filesystemSrc).toContain('network-mount read surface')
    expect(filesystemSrc).not.toContain('Block UNC paths early')
    // The ask is routed through the Xe builder, not an inline type:'other'.
    expect(filesystemSrc).toContain('checkNetworkMountReadSurface(')
  })

  test('all eight official reason strings are present byte-verbatim', () => {
    for (const reason of [
      UNC_PATH_ASK_REASON,
      AUTOMOUNT_HOSTS_ASK_REASON,
      'Automount browse surface detected (defense-in-depth check)',
      KERNEL_RESOLVED_ASK_REASON,
      UNC_GLOB_ASK_REASON,
      AUTOMOUNT_HOSTS_GLOB_ASK_REASON,
      'Automount browse surface glob pattern detected (defense-in-depth check)',
      KERNEL_RESOLVED_GLOB_ASK_REASON,
    ]) {
      expect(filesystemSrc).toContain(reason)
    }
  })
})
