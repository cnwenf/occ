import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import {
  getMemoryFiles,
  type MemoryFileInfo,
  processMdRules,
  processMemoryFile,
  resetGetMemoryFilesCache,
} from '../claudemd.js'
import {
  foldedAutomountPrefix,
  isAutomounterMapDir,
  isAutomountPrefixPath,
  isDeniedMemoryPath,
  isDeniedUncPath,
  isFoldedBareNet,
  isFoldedNetworkFirstSegment,
  isKernelResolvedPathPrefix,
  isUncPath,
  isWindowsDevicePath,
  isWslUncPath,
  shouldRefuseMemorySymlink,
} from '../macosKernelPaths.js'
import { getPlatform } from '../platform.js'
import type { SettingSource } from '../settings/constants.js'

/**
 * CC 2.1.282 changelog (security) — CLAUDE.md/rules STARTUP symlink
 * containment. Unit tests for the `nE`/`ZO` port (macosKernelPaths.ts) plus
 * fixture-repo integration tests against the REAL loaders in claudemd.ts.
 *
 * Byte-verified against the official v2.1.282 linux-x64 ELF:
 *   nE @201925278 · ZO @201920217 · H$ @193979174 · C · dA · S_ @193976417 ·
 *   Hb @193980152 · mL/Nt @193980350 · Hi/Vhe/Et @193979593 · Hn @193975759 ·
 *   gL @193990346 · Ph @193975861 · wl · uA @193980691 (=!1 linux stub) ·
 *   Ho @194177371 · macOS deny message @211555751.
 *
 * INFERRED (not in the linux binary): the two darwin arms of H$ — reconstructed
 * as `platform === 'macos'` gates for /Network/Servers/<host> (len-3 C arm)
 * and /home, /home/<user> (len≤2 "home" arm), corroborated by the macOS deny
 * message @211555751 ("automounter map directory (/net, /net/<host>; macOS
 * /Network, /home)").
 *
 * Documented OCC deviations (task-instructed or fail-closed):
 *  - isDeniedMemoryPath includes the mL "network" first-segment arm — a
 *    strict SUPERSET of official nE (mL only appears in ZO's exception there).
 *  - shouldRefuseMemorySymlink fails CLOSED on unverifiable ancestry
 *    (dangling / ELOOP / EACCES) — the OCC equivalent of the official
 *    "\x00unverified-ancestry" refusal.
 *  - Official parity KEPT: plain out-of-repo symlink targets (e.g.
 *    /etc/passwd on linux) are NOT denied — the official has no general
 *    out-of-repo containment at these surfaces, and neither does OCC.
 */

// projectSettings + localSettings drive the fixtures; userSettings excluded so
// ~/.claude memory can't pollute assertions (convention: agentsMdDiscovery277).
const FIXTURE_SOURCES: SettingSource[] = [
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

// lodash memoize keys by first argument; getPlatform takes none → key undefined.
const PLATFORM_CACHE_KEY = undefined
type PlatformName = ReturnType<typeof getPlatform>

/** Run `body` with getPlatform()'s memo cache primed to `platform`. */
async function withPrimedPlatform(
  platform: PlatformName,
  body: () => Promise<void>,
): Promise<void> {
  const cache = getPlatform.cache
  const had = cache.has(PLATFORM_CACHE_KEY)
  const previous = cache.get(PLATFORM_CACHE_KEY) as PlatformName | undefined
  cache.set(PLATFORM_CACHE_KEY, platform)
  try {
    await body()
  } finally {
    if (had) {
      cache.set(PLATFORM_CACHE_KEY, previous as PlatformName)
    } else {
      cache.delete(PLATFORM_CACHE_KEY)
    }
  }
}

let tmpDir: string
let savedSources: SettingSource[]
let savedCwd: string
let savedAutoMemEnv: string | undefined

beforeAll(() => {
  savedSources = getAllowedSettingSources()
  savedCwd = process.cwd()
  savedAutoMemEnv = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  // Deterministic: keep AutoMem out of the loaded set.
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  setAllowedSettingSources(FIXTURE_SOURCES)
})

afterAll(() => {
  setAllowedSettingSources(savedSources)
  setOriginalCwd(savedCwd)
  if (savedAutoMemEnv === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  } else {
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = savedAutoMemEnv
  }
})

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'occ-memsym282-'))
  setOriginalCwd(tmpDir)
  resetGetMemoryFilesCache()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ─── fixture helpers ────────────────────────────────────────────────────────

function stageFile(relPath: string, content: string): string {
  const full = join(tmpDir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf-8')
  return full
}

function stageLink(relPath: string, target: string): string {
  const full = join(tmpDir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  symlinkSync(target, full)
  return full
}

/**
 * Stages the macOS automount tree layout under tmpDir so a link to the
 * root-literal target has a realistic mirror (the root-literal itself does
 * NOT exist on the linux test host — that absence is exactly the
 * unverifiable-ancestry case the ZO port fails closed on).
 */
function stageMirrorNetworkTree(marker: string): string {
  return stageFile(
    join('mirror', 'Network', 'host', 'x', 'CLAUDE.md'),
    marker,
  )
}

function projectOwnPaths(files: MemoryFileInfo[]): string[] {
  return files
    .filter(f => f.type === 'Project' || f.type === 'Local')
    .map(f => f.path)
}

function joinedContent(files: MemoryFileInfo[]): string {
  return files.map(f => f.content).join('\n')
}

// ─── unit: H$ (isAutomounterMapDir) ─────────────────────────────────────────

describe('CC 2.1.282 H$ — isAutomounterMapDir', () => {
  test('/net and /net/<host> denied on ALL platforms', () => {
    for (const platform of ['linux', 'macos', 'windows', 'wsl'] as const) {
      expect(isAutomounterMapDir('/net', platform)).toBe(true)
      expect(isAutomounterMapDir('/net/host', platform)).toBe(true)
      expect(isAutomounterMapDir('/net/', platform)).toBe(true)
    }
  })

  test('/net/host denied via case-folded dA arm, incl. invisible chars', () => {
    // Official C() folds with dA: strip invisible format chars + case-fold.
    expect(isAutomounterMapDir('/NET/HOST', 'linux')).toBe(true)
    expect(isAutomounterMapDir('/ne\u200ct/host', 'linux')).toBe(true)
    expect(isAutomounterMapDir('/net\u202e/host', 'linux')).toBe(true)
  })

  test('/home and /home/<user> denied ONLY on darwin (inferred arms)', () => {
    expect(isAutomounterMapDir('/home', 'macos')).toBe(true)
    expect(isAutomounterMapDir('/home/user', 'macos')).toBe(true)
    // Official parity on linux: /home is an ordinary directory.
    expect(isAutomounterMapDir('/home', 'linux')).toBe(false)
    expect(isAutomounterMapDir('/home/user', 'linux')).toBe(false)
    expect(isAutomounterMapDir('/home/user', 'windows')).toBe(false)
  })

  test('/Network/Servers/<host> len-3 C arm: linux stub !1, darwin inferred', () => {
    // Linux build source: `if(C(e)&&(e.length===2||!1))return!0` — the len-3
    // arm is compiled out (Hi denies this prefix on every platform anyway).
    expect(isAutomounterMapDir('/Network/Servers/host', 'linux')).toBe(false)
    expect(isAutomounterMapDir('/Network/Servers/host', 'macos')).toBe(true)
  })

  test('more than 3 normalized segments allowed (not a map dir)', () => {
    expect(isAutomounterMapDir('/home/a/b/c', 'macos')).toBe(false)
    expect(isAutomounterMapDir('/net/a/b/c', 'linux')).toBe(false)
    expect(isAutomounterMapDir('/net/a/b', 'linux')).toBe(false)
  })

  test('paths containing ".." refused outright (H$ does not fold)', () => {
    expect(isAutomounterMapDir('/net/../etc', 'linux')).toBe(false)
    expect(isAutomounterMapDir('/work/../net', 'linux')).toBe(false)
    expect(isAutomounterMapDir('/home/../home', 'macos')).toBe(false)
  })

  test('non-absolute and empty inputs refused', () => {
    expect(isAutomounterMapDir('net/host', 'linux')).toBe(false)
    expect(isAutomounterMapDir('', 'linux')).toBe(false)
    expect(isAutomounterMapDir('/', 'linux')).toBe(false)
    expect(isAutomounterMapDir('C:\\net', 'windows')).toBe(false)
  })
})

// ─── unit: S_ (kernel-resolved prefix) ──────────────────────────────────────

describe('CC 2.1.282 S_ — isKernelResolvedPathPrefix (..-fold + case)', () => {
  test('first normalized segment kernel dotdir denied, case-insensitive', () => {
    expect(isKernelResolvedPathPrefix('/.vol/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.Vol/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.VOL/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.file/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.nofollow/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.resolve/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.vol')).toBe(true)
  })

  test('".." folding can bring a dotdir into first position', () => {
    expect(isKernelResolvedPathPrefix('/work/../.vol/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/a/b/../../.file/x')).toBe(true)
  })

  test('dotdir NOT in first normalized position allowed', () => {
    expect(isKernelResolvedPathPrefix('/a/.vol/x')).toBe(false)
    expect(isKernelResolvedPathPrefix('/etc/passwd')).toBe(false)
    expect(isKernelResolvedPathPrefix('.vol/x')).toBe(false)
  })
})

// ─── unit: Hb / mL / Hi (folded surfaces) ───────────────────────────────────

describe('CC 2.1.282 Hb — isFoldedBareNet', () => {
  test('exactly /net after ".." folding', () => {
    expect(isFoldedBareNet('/net')).toBe(true)
    expect(isFoldedBareNet('/net/')).toBe(true)
    expect(isFoldedBareNet('/NET')).toBe(true)
    expect(isFoldedBareNet('/work/../net')).toBe(true)
    expect(isFoldedBareNet('/net/x')).toBe(false)
    expect(isFoldedBareNet('/net/../etc')).toBe(false)
    expect(isFoldedBareNet('net')).toBe(false)
  })
})

describe('CC 2.1.282 mL — isFoldedNetworkFirstSegment', () => {
  test('first folded segment "network", any depth, case-insensitive', () => {
    expect(isFoldedNetworkFirstSegment('/Network/foo')).toBe(true)
    expect(isFoldedNetworkFirstSegment('/network')).toBe(true)
    expect(isFoldedNetworkFirstSegment('/NETWORK/a/b/c')).toBe(true)
    expect(isFoldedNetworkFirstSegment('/a/Network/b')).toBe(false)
    expect(isFoldedNetworkFirstSegment('Network/x')).toBe(false)
    expect(isFoldedNetworkFirstSegment('')).toBe(false)
  })

  test('folded "/work/../Network/foo" denied (required case)', () => {
    expect(isFoldedNetworkFirstSegment('/work/../Network/foo')).toBe(true)
    expect(isDeniedMemoryPath('/work/../Network/foo', 'linux')).toBe(true)
  })

  test('memoization consistent; >4096-char paths bypass memo (Wt cap)', () => {
    const long = `/Network/${'a/'.repeat(3000)}x`
    expect(long.length).toBeGreaterThan(4096)
    expect(isFoldedNetworkFirstSegment(long)).toBe(true)
    // Repeat calls (memo hit vs direct compute) agree.
    const short = '/Network/memo-consistency'
    expect(isFoldedNetworkFirstSegment(short)).toBe(true)
    expect(isFoldedNetworkFirstSegment(short)).toBe(true)
    expect(isFoldedNetworkFirstSegment('/tmp/memo-consistency')).toBe(false)
    expect(isFoldedNetworkFirstSegment('/tmp/memo-consistency')).toBe(false)
  })
})

describe('CC 2.1.282 Hi/Vhe/Et — foldedAutomountPrefix', () => {
  test('root-anchored /net/<host> prefix at any depth (raw-case return)', () => {
    expect(foldedAutomountPrefix('/net/host')).toBe('/net/host')
    expect(foldedAutomountPrefix('/net/host/a/b')).toBe('/net/host')
    expect(foldedAutomountPrefix('/work/../net/host')).toBe('/net/host')
    expect(foldedAutomountPrefix('/NET/HOST/x')).toBe('/NET/HOST')
    expect(isAutomountPrefixPath('/net/host/x')).toBe(true)
  })

  test('/Network/Servers/<host> prefix matched at len 3', () => {
    expect(foldedAutomountPrefix('/Network/Servers/h/x')).toBe(
      '/Network/Servers/h',
    )
    expect(foldedAutomountPrefix('/a/../Network/Servers/h')).toBe(
      '/Network/Servers/h',
    )
  })

  test('non-matching shapes return null', () => {
    expect(foldedAutomountPrefix('/net')).toBeNull()
    expect(foldedAutomountPrefix('/Network/Servers')).toBeNull()
    expect(foldedAutomountPrefix('/a/net/host')).toBeNull()
    expect(foldedAutomountPrefix('net/host')).toBeNull()
    expect(isAutomountPrefixPath('/tmp/net/host')).toBe(false)
  })
})

// ─── unit: UNC / device namespace (Hn, gL, Ph, wl) ──────────────────────────

describe('CC 2.1.282 Hn/gL/Ph/wl — UNC minus WSL exception', () => {
  test('UNC prefixes detected (both slash styles)', () => {
    expect(isUncPath('//host/share')).toBe(true)
    expect(isUncPath('\\\\host\\share')).toBe(true)
    expect(isUncPath('/single/slash')).toBe(false)
  })

  test('WSL distro shares take the wl exception', () => {
    expect(isWslUncPath('//wsl$/Ubuntu/x')).toBe(true)
    expect(isWslUncPath('//wsl.localhost/Ubuntu/x')).toBe(true)
    expect(isWslUncPath('\\\\wsl.localhost\\Debian')).toBe(true)
    expect(isWslUncPath('//host/share')).toBe(false)
    // Dot/space-only hosts do NOT take the exception (official guard regex).
    expect(isWslUncPath('//wsl$/..')).toBe(false)
    expect(isWslUncPath('//wsl.localhost/.')).toBe(false)
  })

  test('isDeniedUncPath = Hn && !wl', () => {
    expect(isDeniedUncPath('//host/share')).toBe(true)
    expect(isDeniedUncPath('//wsl$/Ubuntu/x')).toBe(false)
    expect(isDeniedUncPath('/tmp/x')).toBe(false)
  })

  test('device-namespace paths (Ph/$t) detected', () => {
    expect(isWindowsDevicePath('/??/C:/x')).toBe(true)
    expect(isWindowsDevicePath('\\??\\C:\\x')).toBe(true)
    expect(isWindowsDevicePath('/a??b')).toBe(false)
  })
})

// ─── unit: aggregate nE port (isDeniedMemoryPath) ───────────────────────────

describe('CC 2.1.282 nE — isDeniedMemoryPath aggregate', () => {
  test('every official arm denies on linux', () => {
    const denied = [
      '//host/share/CLAUDE.md', // Hn && !wl
      '/net/host/x/CLAUDE.md', // Hi
      '/net', // Hb
      '/net/x', // H$ (net/<host>, all platforms)
      '/Network/Servers/h/x', // Hi (all platforms)
      '/.vol/x/CLAUDE.md', // S_
      '/.Vol/x/CLAUDE.md', // S_ case-insensitive
      '/work/../.file/x', // S_ folded
      '/??/C:/Users/x/CLAUDE.md', // Ph
    ]
    for (const p of denied) {
      expect(isDeniedMemoryPath(p, 'linux')).toBe(true)
    }
  })

  test('mL arm — OCC instructed superset of nE', () => {
    // Official nE does NOT include mL; OCC's port adds it (task spec),
    // consistent with the pre-existing any-depth /Network posture.
    expect(isDeniedMemoryPath('/Network/foo/CLAUDE.md', 'linux')).toBe(true)
    expect(isDeniedMemoryPath('/work/../Network/foo', 'linux')).toBe(true)
  })

  test('ordinary paths allowed (official parity — no general containment)', () => {
    const allowed = [
      '/home/user/project/CLAUDE.md', // /home NOT denied on linux
      '/home', // H$ home arm is darwin-only
      '/etc/passwd', // parity: plain out-of-root paths are not denied
      '/tmp/occ-memsym282-x/CLAUDE.md',
      '/Users/x/CLAUDE.md',
      '/net/../home/x', // folds to /home/x — allowed on linux
      'relative/CLAUDE.md',
      '',
    ]
    for (const p of allowed) {
      expect(isDeniedMemoryPath(p, 'linux')).toBe(false)
    }
  })

  test('darwin-gated arms fire only for macos platform', () => {
    expect(isDeniedMemoryPath('/home', 'macos')).toBe(true)
    expect(isDeniedMemoryPath('/home/user', 'macos')).toBe(true)
    expect(isDeniedMemoryPath('/home/a/b/c', 'macos')).toBe(false)
    expect(isDeniedMemoryPath('/home', 'linux')).toBe(false)
    expect(isDeniedMemoryPath('/home', 'windows')).toBe(false)
  })
})

// ─── unit: ZO port (shouldRefuseMemorySymlink), real fs ─────────────────────

describe('CC 2.1.282 ZO — shouldRefuseMemorySymlink (real temp fs)', () => {
  test('non-symlink existing file and missing path allowed', () => {
    const file = stageFile('plain.md', '# plain\n')
    expect(shouldRefuseMemorySymlink(file, 'linux')).toBe(false)
    expect(shouldRefuseMemorySymlink(join(tmpDir, 'missing.md'), 'linux')).toBe(
      false,
    )
    expect(shouldRefuseMemorySymlink(tmpDir, 'linux')).toBe(false)
  })

  test('dangling symlink refused (fail-closed ≡ unverified ancestry)', () => {
    const link = stageLink('dangling.md', join(tmpDir, 'nowhere.md'))
    expect(shouldRefuseMemorySymlink(link, 'linux')).toBe(true)
  })

  test('symlink loop refused (ELOOP → fail-closed)', () => {
    const link = stageLink('loop.md', join(tmpDir, 'loop.md'))
    expect(shouldRefuseMemorySymlink(link, 'linux')).toBe(true)
  })

  test('link → /etc/passwd ALLOWED on linux (official parity — documented)', () => {
    // The official has NO general out-of-repo containment at these surfaces:
    // a symlink resolving to an ordinary existing path is allowed. This
    // assertion pins that parity deliberately (task-mandated).
    if (!existsSync('/etc/passwd')) return
    const link = stageLink('passwd.md', '/etc/passwd')
    expect(shouldRefuseMemorySymlink(link, 'linux')).toBe(false)
  })

  test('link → staged tmp "Network/host/x" tree refused', () => {
    // The mirror stages the macOS automount layout under tmpDir; the link
    // uses the root-literal target spelling. On linux that absolute target
    // does not exist → realpath throws → fail-closed refusal (the official
    // refuses the same link on macOS via unverifiable ancestry OR, when the
    // mount is live, via nE(resolved)). The second assertion proves the
    // resolved-surface arm: were /Network/host/x/CLAUDE.md to exist (macOS),
    // the resolved path itself is denied.
    const mirror = stageMirrorNetworkTree('MIRROR-SECRET-282\n')
    expect(existsSync(mirror)).toBe(true)
    const link = stageLink('to-network.md', '/Network/host/x/CLAUDE.md')
    expect(shouldRefuseMemorySymlink(link, 'linux')).toBe(true)
    expect(isDeniedMemoryPath('/Network/host/x/CLAUDE.md', 'linux')).toBe(true)
  })

  test('in-repo benign symlink allowed', () => {
    const target = stageFile(join('repo', 'real.md'), '# real\n')
    const link = stageLink(join('repo', 'link.md'), target)
    expect(shouldRefuseMemorySymlink(link, 'linux')).toBe(false)
  })

  test('multi-hop chain to benign target allowed', () => {
    const target = stageFile(join('repo', 'final.md'), '# final\n')
    const mid = stageLink(join('repo', 'mid.md'), target)
    const outer = stageLink(join('repo', 'outer.md'), mid)
    expect(shouldRefuseMemorySymlink(outer, 'linux')).toBe(false)
  })

  test('link → /home refused on darwin, allowed on linux', async () => {
    if (!existsSync('/home')) return
    const link = stageLink('home-link.md', '/home')
    expect(shouldRefuseMemorySymlink(link, 'linux')).toBe(false)
    expect(shouldRefuseMemorySymlink(link, 'macos')).toBe(true)
    // Default-parameter path: getPlatform memo cache primed to 'macos'.
    await withPrimedPlatform('macos', async () => {
      expect(shouldRefuseMemorySymlink(link)).toBe(true)
    })
  })
})

// ─── integration: processMemoryFile (W6/K7e gates) ──────────────────────────

describe('CC 2.1.282 integration — processMemoryFile containment', () => {
  test('benign repo CLAUDE.md still loads (regression)', async () => {
    const claudeMd = stageFile(
      join('repo', 'CLAUDE.md'),
      '# Benign 282 marker\n',
    )
    const files = await processMemoryFile(
      claudeMd,
      'Project',
      new Set<string>(),
      true,
    )
    expect(files.map(f => f.path)).toContain(claudeMd)
    expect(joinedContent(files)).toContain('Benign 282 marker')
  })

  test('CLAUDE.md symlink → denied surface: content absent, silent skip', async () => {
    stageMirrorNetworkTree('MIRROR-SECRET-282\n')
    const link = stageLink(
      join('repo', 'CLAUDE.md'),
      '/Network/host/x/CLAUDE.md',
    )
    const files = await processMemoryFile(
      link,
      'Project',
      new Set<string>(),
      true,
    )
    expect(files).toEqual([])
    expect(joinedContent(files)).not.toContain('MIRROR-SECRET-282')
  })

  test('CLAUDE.md dangling symlink refused (fail-closed)', async () => {
    const link = stageLink(
      join('repo', 'CLAUDE.md'),
      join(tmpDir, 'nowhere', 'CLAUDE.md'),
    )
    const files = await processMemoryFile(
      link,
      'Project',
      new Set<string>(),
      true,
    )
    expect(files).toEqual([])
  })

  test('literal denied path refused even before resolution (K7e arm)', async () => {
    // Non-existent literal under a denied surface: safeResolvePath falls
    // back to the literal, and the K7e-equivalent gate refuses it directly.
    const files = await processMemoryFile(
      '/net/host/CLAUDE.md',
      'Project',
      new Set<string>(),
      true,
    )
    expect(files).toEqual([])
  })

  test('symlink → /etc/passwd on linux still readable (official parity)', async () => {
    // Parity assertion (task-mandated, documented): the official 282 fix
    // denies only the automount/kernel/UNC/network surfaces plus
    // unverifiable ancestry — NOT ordinary out-of-repo targets.
    if (!existsSync('/etc/passwd')) return
    const link = stageLink(join('repo', 'CLAUDE.md'), '/etc/passwd')
    const files = await processMemoryFile(
      link,
      'Project',
      new Set<string>(),
      true,
    )
    expect(files.length).toBe(1)
    expect(files[0]?.path).toBe(link)
  })

  test('@include targets gated: denied include skipped, benign include loads', async () => {
    stageFile(join('repo', 'incl-ok.md'), 'INCLUDED-OK-282\n')
    const claudeMd = stageFile(
      join('repo', 'CLAUDE.md'),
      '# top\n\n@./incl-ok.md\n\n@/net/host/incl.md\n',
    )
    const files = await processMemoryFile(
      claudeMd,
      'Project',
      new Set<string>(),
      true,
    )
    const paths = files.map(f => f.path)
    expect(paths).toContain(claudeMd)
    expect(paths).toContain(join(tmpDir, 'repo', 'incl-ok.md'))
    expect(paths).not.toContain('/net/host/incl.md')
    expect(joinedContent(files)).toContain('INCLUDED-OK-282')
  })
})

// ─── integration: processMdRules (cHe gates) ────────────────────────────────

describe('CC 2.1.282 integration — processMdRules containment', () => {
  async function walkRules(rulesDir: string): Promise<MemoryFileInfo[]> {
    return processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: new Set<string>(),
      includeExternal: true,
      conditionalRule: false,
    })
  }

  test('benign rules dir loads, incl. symlinked dir → staged benign tree', async () => {
    stageFile(join('staged', 'rules-real', 'good.md'), 'RULE-GOOD-282\n')
    mkdirSync(join(tmpDir, 'repo', '.claude'), { recursive: true })
    symlinkSync(
      join(tmpDir, 'staged', 'rules-real'),
      join(tmpDir, 'repo', '.claude', 'rules'),
    )
    const files = await walkRules(join(tmpDir, 'repo', '.claude', 'rules'))
    expect(files.map(f => f.path)).toContain(
      join(tmpDir, 'staged', 'rules-real', 'good.md'),
    )
    expect(joinedContent(files)).toContain('RULE-GOOD-282')
  })

  test('rules dir symlink → denied surface skips whole subtree', async () => {
    mkdirSync(join(tmpDir, 'repo', '.claude'), { recursive: true })
    symlinkSync(
      '/Network/Servers/host/rules',
      join(tmpDir, 'repo', '.claude', 'rules'),
    )
    const files = await walkRules(join(tmpDir, 'repo', '.claude', 'rules'))
    expect(files).toEqual([])
  })

  test('rules dir symlink → dangling skipped (fail-closed)', async () => {
    mkdirSync(join(tmpDir, 'repo', '.claude'), { recursive: true })
    symlinkSync(
      join(tmpDir, 'nowhere-rules'),
      join(tmpDir, 'repo', '.claude', 'rules'),
    )
    const files = await walkRules(join(tmpDir, 'repo', '.claude', 'rules'))
    expect(files).toEqual([])
  })

  test('per-entry: denied/dangling/loop links skipped, benign sibling loads', async () => {
    stageFile(join('repo', '.claude', 'rules', 'good.md'), 'RULE-GOOD-282\n')
    stageMirrorNetworkTree('MIRROR-SECRET-282\n')
    stageLink(
      join('repo', '.claude', 'rules', 'evil.md'),
      '/net/host/evil.md',
    )
    stageLink(
      join('repo', '.claude', 'rules', 'dangling.md'),
      join(tmpDir, 'nowhere.md'),
    )
    stageLink(
      join('repo', '.claude', 'rules', 'loop.md'),
      join(tmpDir, 'repo', '.claude', 'rules', 'loop.md'),
    )
    const files = await walkRules(join(tmpDir, 'repo', '.claude', 'rules'))
    const paths = files.map(f => f.path)
    expect(paths).toContain(
      join(tmpDir, 'repo', '.claude', 'rules', 'good.md'),
    )
    expect(paths.length).toBe(1)
    expect(joinedContent(files)).not.toContain('MIRROR-SECRET-282')
  })

  test('darwin: rules link → /home skipped (platform-gated H$ arm)', async () => {
    if (!existsSync('/home')) return
    stageFile(join('repo', '.claude', 'rules', 'good.md'), 'RULE-GOOD-282\n')
    stageLink(join('repo', '.claude', 'rules', 'home-link'), '/home')
    await withPrimedPlatform('macos', async () => {
      const files = await walkRules(join(tmpDir, 'repo', '.claude', 'rules'))
      const paths = files.map(f => f.path)
      expect(paths).toContain(
        join(tmpDir, 'repo', '.claude', 'rules', 'good.md'),
      )
      // Nothing from under /home may enter the walk.
      for (const p of paths) {
        expect(p.startsWith('/home')).toBe(false)
      }
    })
  })
})

// ─── integration: getMemoryFiles end-to-end ─────────────────────────────────

describe('CC 2.1.282 integration — getMemoryFiles fixture repo', () => {
  test('denied CLAUDE.md symlink absent; benign .claude tree loads', async () => {
    stageMirrorNetworkTree('MIRROR-SECRET-282\n')
    stageLink(join('repo', 'CLAUDE.md'), '/Network/host/x/CLAUDE.md')
    stageFile(join('repo', '.claude', 'CLAUDE.md'), 'INNER-CLAUDE-282\n')
    stageFile(join('repo', '.claude', 'rules', 'good.md'), 'RULE-GOOD-282\n')
    stageLink(
      join('repo', '.claude', 'rules', 'dangling.md'),
      join(tmpDir, 'nowhere.md'),
    )
    setOriginalCwd(join(tmpDir, 'repo'))
    resetGetMemoryFilesCache()

    const files = await getMemoryFiles()
    const paths = projectOwnPaths(files)
    expect(paths).toContain(join(tmpDir, 'repo', '.claude', 'CLAUDE.md'))
    expect(paths).toContain(
      join(tmpDir, 'repo', '.claude', 'rules', 'good.md'),
    )
    expect(paths).not.toContain(join(tmpDir, 'repo', 'CLAUDE.md'))
    expect(joinedContent(files)).toContain('INNER-CLAUDE-282')
    expect(joinedContent(files)).toContain('RULE-GOOD-282')
    expect(joinedContent(files)).not.toContain('MIRROR-SECRET-282')
  })

  test('benign repo with real CLAUDE.md + symlink loads unchanged (regression)', async () => {
    stageFile(join('staged', 'linked.md'), 'LINKED-BENIGN-282\n')
    stageFile(join('repo', 'CLAUDE.md'), '# Top\n\n@./extra.md\n')
    stageFile(join('repo', 'extra.md'), 'EXTRA-BENIGN-282\n')
    stageLink(join('repo', '.claude', 'CLAUDE.md'), join(tmpDir, 'staged', 'linked.md'))
    setOriginalCwd(join(tmpDir, 'repo'))
    resetGetMemoryFilesCache()

    const files = await getMemoryFiles()
    const paths = projectOwnPaths(files)
    expect(paths).toContain(join(tmpDir, 'repo', 'CLAUDE.md'))
    expect(paths).toContain(join(tmpDir, 'repo', 'extra.md'))
    expect(paths).toContain(join(tmpDir, 'repo', '.claude', 'CLAUDE.md'))
    expect(joinedContent(files)).toContain('LINKED-BENIGN-282')
    expect(joinedContent(files)).toContain('EXTRA-BENIGN-282')
  })
})
