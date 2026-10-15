import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// MACRO polyfill (repo convention — ide.ts reads MACRO.VERSION via
// getClaudeCodeVersion()). A valid semver is required because the installer
// compares the detected extension version with lt(). Per-file test runs
// (`bun test <file>`) guarantee MACRO is undefined here, so this value wins.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: '2.1.300' }
}
const BUNDLED_VERSION = String(
  (globalThis as { MACRO: { VERSION: string } }).MACRO.VERSION,
)

/**
 * CC 2.1.300 (#34) — "Fixed starting Claude Code in a VS Code, Cursor or
 * Devin Desktop integrated terminal launching the editor's command-line tool
 * twice to check for the extension; it now launches it once."
 *
 * Byte evidence (docs/gap-research-300/triage-T4.md §34):
 *   v299 orchestrator `ino` @227223885 (DOUBLE launch):
 *     if(fEe(w))sEn(w).then(async(H)=>{JWr(w,y).catch(...).then((G)=>{...
 *       if(!H&&G?.installed===!0&&!Vur())r(G)})})
 *     — `sEn` = isIDEExtensionInstalled (bare `--list-extensions` spawn #1),
 *     `JWr` = maybeInstall (whose installer spawns `--list-extensions
 *     --show-versions` = check spawn #2).
 *   v300 orchestrator `Eio` @228451039 (SINGLE launch):
 *     if(Cxe(w))P6r(w,y).catch((H)=>({installed:!1,error:H.message||
 *       "Installation failed",installedVersion:null,ideType:w})).then((H)=>{
 *       if(s(H),H?.installed&&!h?.aborted)ygr().then(e);
 *       if(H?.installed===!0&&!H.previouslyInstalled&&!vgr())r(H)});
 *     else if(Hbe(w))I6r(w).then(async(H)=>{if(H&&!vgr())r(null)})
 *     — pre-check gone; onboarding gated on `!H.previouslyInstalled`.
 *     JetBrains branch unchanged (still uses the installed-check).
 *   v300 installer `O6r` @228445620:
 *     let r=await D6r(n),s=r!==null;if(!r||pM(r,qxn())){await X(500);
 *       let h=await ct(n,["--force","--install-extension",
 *       "anthropic.claude-code"],{env:Ttt()});if(h.code!==0)throw ...;
 *       r=qxn()}return{installedVersion:r,previouslyInstalled:s}
 *     … tail: return{installedVersion:null,previouslyInstalled:!1}
 *   v300 maybeInstall `P6r` @228442549: success status carries
 *     `previouslyInstalled:s`; the catch path OMITS the field.
 *   v300 install env `Ttt` @228446120 (byte-verified in the same dd window):
 *     if(O()==="linux")return{...process.env,DISPLAY:"",WAYLAND_DISPLAY:""}
 *   `previouslyInstalled` string hits: v299 → 0, v300 → 6, OCC → 0.
 *
 * Test seam: the editor CLI ('code'/'cursor') is resolved via PATH by execa,
 * and getInstallationEnv() spreads process.env — so a fake executable in a
 * tmp bin dir prepended to PATH intercepts every spawn. The fake appends one
 * line (its argv) per invocation to a log file. A live-pid lockfile under a
 * tmp CLAUDE_CONFIG_DIR (+ CLAUDE_CODE_IDE_SKIP_VALID_CHECK) makes
 * findAvailableIDE() resolve on its first poll so no 30s loop dangles.
 */

// --- Mock seam (OCC-97 pattern: snapshot real exports, override narrowly,
// restore in afterAll). config.js → deterministic getGlobalConfig;
// analytics → no-op logEvent recorder. ---
const actualConfigModule = await import('../config.js')
const actualConfigExports = { ...actualConfigModule }
let mockGlobalConfig: Record<string, unknown> = {}
const savedConfigUpdaters: unknown[] = []
mock.module('../config.js', () => ({
  ...actualConfigExports,
  getGlobalConfig: () => mockGlobalConfig,
  saveGlobalConfig: (updater: unknown) => {
    savedConfigUpdaters.push(updater)
  },
}))

const actualAnalyticsModule = await import('src/services/analytics/index.js')
const actualAnalyticsExports = { ...actualAnalyticsModule }
const analyticsEvents: Array<{ name: string; props: unknown }> = []
mock.module('src/services/analytics/index.js', () => ({
  ...actualAnalyticsExports,
  logEvent: (name: string, props: unknown = {}) => {
    analyticsEvents.push({ name, props })
  },
}))

afterAll(() => {
  mock.module('../config.js', () => ({ ...actualConfigExports }))
  mock.module('src/services/analytics/index.js', () => ({
    ...actualAnalyticsExports,
  }))
})

// Import AFTER mocks are registered.
const { initializeIdeIntegration, maybeInstallIDEExtension } = await import(
  '../ide.js'
)
type IdeStatus = import('../ide.js').IDEExtensionInstallationStatus & {
  previouslyInstalled?: boolean
}

// --- Fake editor CLI harness -------------------------------------------

const FAKE_CLI_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODE_LOG"
case "$1" in
  --list-extensions)
    if [ "$2" = "--show-versions" ]; then
      printf '%s\\n' "$FAKE_CODE_VERSIONS"
    else
      printf '%s\\n' "$FAKE_CODE_LIST"
    fi
    exit 0
    ;;
  --force)
    exit "\${FAKE_CODE_INSTALL_EXIT:-0}"
    ;;
esac
exit 0
`

const MANAGED_ENV_KEYS = [
  'PATH',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_IDE_SKIP_VALID_CHECK',
  'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL',
  'CLAUDE_CODE_SSE_PORT',
  'USER_TYPE',
  'TERM_PROGRAM',
  'FAKE_CODE_LOG',
  'FAKE_CODE_VERSIONS',
  'FAKE_CODE_LIST',
  'FAKE_CODE_INSTALL_EXIT',
] as const

let envSnapshot: Record<string, string | undefined> = {}
let workDir = ''
let invocationLog = ''

function readInvocations(): string[] {
  try {
    const content = readFileSync(invocationLog, 'utf-8').split('\n')
    return content.filter((line: string) => line.length > 0)
  } catch {
    return []
  }
}

function barePrecheckInvocations(): string[] {
  return readInvocations().filter(line => line === '--list-extensions')
}

beforeEach(() => {
  envSnapshot = {}
  for (const key of MANAGED_ENV_KEYS) {
    envSnapshot[key] = process.env[key]
  }

  workDir = mkdtempSync(join(tmpdir(), 'occ-ide-single-launch-300-'))
  invocationLog = join(workDir, 'invocations.log')

  // Fake editor CLIs on PATH (ide.ts resolves 'code'/'cursor' via execa/PATH).
  const fakeBin = join(workDir, 'bin')
  mkdirSync(fakeBin, { recursive: true })
  for (const name of ['code', 'cursor', 'windsurf']) {
    const scriptPath = join(fakeBin, name)
    writeFileSync(scriptPath, FAKE_CLI_SCRIPT, { mode: 0o755 })
    chmodSync(scriptPath, 0o755)
  }

  // Live-pid lockfile so findAvailableIDE() resolves on its first poll.
  const ideDir = join(workDir, 'config', 'ide')
  mkdirSync(ideDir, { recursive: true })
  writeFileSync(
    join(ideDir, '45123.lock'),
    JSON.stringify({
      pid: process.pid,
      workspaceFolders: [workDir],
      ideName: 'VS Code',
    }),
  )

  mockGlobalConfig = {
    diffTool: 'auto', // skip the saveGlobalConfig side-effect in maybeInstall
    autoInstallIdeExtension: true,
    hasIdeOnboardingBeenShown: {}, // onboarding dialog not yet shown
  }
  savedConfigUpdaters.length = 0
  analyticsEvents.length = 0

  process.env.PATH = `${fakeBin}:${process.env.PATH ?? ''}`
  process.env.CLAUDE_CONFIG_DIR = join(workDir, 'config')
  process.env.CLAUDE_CODE_IDE_SKIP_VALID_CHECK = '1'
  process.env.FAKE_CODE_LOG = invocationLog
  process.env.FAKE_CODE_VERSIONS = ''
  process.env.FAKE_CODE_LIST = ''
  delete process.env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL
  delete process.env.CLAUDE_CODE_SSE_PORT
  delete process.env.USER_TYPE
  delete process.env.TERM_PROGRAM
})

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const original = envSnapshot[key]
    if (original === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = original
    }
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true })
  }
})

function runInit(ideType: 'vscode' | 'cursor'): Promise<{
  status: IdeStatus | null
  counters: { onboardingCalls: number }
}> {
  // Mutable holder: the onboarding gate runs synchronously in the same .then
  // callback right AFTER onInstallationComplete resolves this promise, so the
  // counter must be read after the await continuation, never captured at
  // resolve time.
  const counters = { onboardingCalls: 0 }
  return new Promise(resolve => {
    void initializeIdeIntegration(
      () => {},
      ideType,
      () => {
        counters.onboardingCalls += 1
      },
      status => {
        resolve({ status: status as IdeStatus | null, counters })
      },
    )
  })
}

describe('2.1.300 #34 — editor CLI launched once to check for the IDE extension', () => {
  test('fresh install: no bare --list-extensions pre-check, status carries previouslyInstalled=false, onboarding fires', async () => {
    process.env.FAKE_CODE_VERSIONS = '' // extension not installed

    const { status, counters } = await runInit('vscode')

    // Official v300 `O6r`: ONE check spawn (`--list-extensions --show-versions`)
    // + the conditional install spawn. The v299 orchestrator pre-check
    // (`sEn` → bare `--list-extensions`) is gone.
    expect(barePrecheckInvocations()).toHaveLength(0)
    expect(readInvocations()).toEqual([
      '--list-extensions --show-versions',
      '--force --install-extension anthropic.claude-code',
    ])

    expect(status).not.toBeNull()
    expect(status?.installed).toBe(true)
    expect(status?.error).toBeNull()
    expect(status?.installedVersion).toBe(BUNDLED_VERSION)
    expect(status?.ideType).toBe('vscode')
    // Official `P6r` success shape: previouslyInstalled = (detected !== null),
    // captured BEFORE the conditional install launch.
    expect(status?.previouslyInstalled).toBe(false)

    // Official gate: installed===true && !previouslyInstalled && !beenShown.
    expect(counters.onboardingCalls).toBe(1)
  }, 15_000)

  test('already installed at bundled version: exactly ONE editor-CLI launch, previouslyInstalled=true, no onboarding', async () => {
    process.env.FAKE_CODE_VERSIONS = `anthropic.claude-code@${BUNDLED_VERSION}`

    const { status, counters } = await runInit('vscode')

    // The whole point of the fix: exactly one launch to check for the
    // extension, and no install launch (version is current).
    expect(barePrecheckInvocations()).toHaveLength(0)
    expect(readInvocations()).toEqual(['--list-extensions --show-versions'])

    expect(status?.installed).toBe(true)
    expect(status?.installedVersion).toBe(BUNDLED_VERSION)
    expect(status?.previouslyInstalled).toBe(true)
    expect(counters.onboardingCalls).toBe(0)
  }, 15_000)

  test('stale upgrade-in-place: check + install launches only, previouslyInstalled=true suppresses onboarding', async () => {
    process.env.FAKE_CODE_VERSIONS = 'anthropic.claude-code@0.0.1'

    const { status, counters } = await runInit('cursor')

    expect(barePrecheckInvocations()).toHaveLength(0)
    expect(readInvocations()).toEqual([
      '--list-extensions --show-versions',
      '--force --install-extension anthropic.claude-code',
    ])

    expect(status?.installed).toBe(true)
    expect(status?.installedVersion).toBe(BUNDLED_VERSION)
    expect(status?.ideType).toBe('cursor')
    expect(status?.previouslyInstalled).toBe(true)
    // v299 gated on the pre-check result; v300 gates on previouslyInstalled —
    // an upgrade-in-place must NOT re-trigger onboarding.
    expect(counters.onboardingCalls).toBe(0)
  }, 15_000)

  test('install failure: failure status without previouslyInstalled (official P6r catch shape), no onboarding', async () => {
    process.env.FAKE_CODE_VERSIONS = '' // not installed
    process.env.FAKE_CODE_INSTALL_EXIT = '1'

    const { status, counters } = await runInit('vscode')

    expect(barePrecheckInvocations()).toHaveLength(0)
    expect(status?.installed).toBe(false)
    expect(typeof status?.error).toBe('string')
    expect((status?.error ?? '').length).toBeGreaterThan(0)
    expect(status?.installedVersion).toBeNull()
    expect(status?.ideType).toBe('vscode')
    // Official `P6r` catch path omits previouslyInstalled entirely.
    expect(status && 'previouslyInstalled' in status).toBe(false)
    expect(counters.onboardingCalls).toBe(0)
  }, 15_000)

  test('maybeInstallIDEExtension returns the official v300 {installedVersion, previouslyInstalled} shape for an upgrade', async () => {
    process.env.FAKE_CODE_VERSIONS = 'anthropic.claude-code@0.0.1'

    const status = (await maybeInstallIDEExtension('cursor')) as IdeStatus | null

    expect(status).toEqual({
      installed: true,
      error: null,
      installedVersion: BUNDLED_VERSION,
      ideType: 'cursor',
      previouslyInstalled: true,
    })
    expect(readInvocations()).toEqual([
      '--list-extensions --show-versions',
      '--force --install-extension anthropic.claude-code',
    ])
  }, 15_000)
})
