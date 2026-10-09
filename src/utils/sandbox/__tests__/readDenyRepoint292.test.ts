import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SettingSource } from '../../settings/constants.js'
import type { SettingsJson } from '../../settings/types.js'

/**
 * CC 2.1.292 security fix — managed-sandbox read-deny path that APPEARS or
 * RE-POINTS mid-session must drop project grants inside it.
 *
 * Official changelog (byte-verbatim from the 2.1.293 ELF's embedded 2.1.292
 * changelog block @30917516): "Fixed a managed sandbox read-deny path (and
 * user ones beside it) that appears or re-points mid-session not dropping
 * project grants inside it or ending credential injection from files it
 * covers."
 *
 * Official schema describe evidence (2.1.292 linux-x64 ELF):
 *  - Bc @14021955 (allowRead side): "A value inside a directory sandboxed
 *    commands can write is re-checked before every command and dropped once
 *    it has been re-pointed into a denied path."
 *  - Wc @11317030 (allowWrite side): "A value inside a directory sandboxed
 *    commands can already write is re-checked before every command and
 *    dropped once it has been re-pointed into a denied read path."
 *
 * OCC port shape: the screening itself (candidateUnderDeniedRead with live
 * realpathExistingPrefix resolution) is the 2.1.285 machinery already in
 * convertToSandboxRuntimeConfig — what 292 adds is the RE-CHECK CADENCE:
 * wrapWithSandbox() now calls refreshConfig() before every command, so the
 * live-resolution screening re-runs per command and a re-pointed grant is
 * dropped at the next command boundary. The credential-injection leg of the
 * changelog has no OCC surface (no sandbox.credentials.files setting —
 * trustedTierGrants.ts header).
 *
 * Harness: the trustedTierGrants285 pattern — per-source settings seeded
 * through setCachedSettingsForSource (no disk reads for settings), only
 * debug.js mock.module'd (log capture) with OCC-97 snapshot/restore hygiene.
 * The grant paths themselves are REAL filesystem objects (mkdtemp + symlinks)
 * because the fix under test is live filesystem resolution.
 */

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

// Snapshot the REAL debug namespace BEFORE any mock.module registration.
const actualDebugModule = await import('../../debug.js')
const actualDebugExports = { ...actualDebugModule }

const debugLines: string[] = []

mock.module('../../debug.js', () => ({
  ...actualDebugExports,
  logForDebugging: (message: string) => {
    debugLines.push(message)
  },
}))

afterAll(() => {
  mock.module('../../debug.js', () => ({ ...actualDebugExports }))
})

// Import AFTER the debug mock so the adapter captures the spy.
const { setCachedSettingsForSource, resetSettingsCache } = await import(
  '../../settings/settingsCache.js'
)
const {
  convertToSandboxRuntimeConfig,
  _resetAllowedDomainsWarningForTesting,
  _resetFilesystemGrantsWarningForTesting,
  _resetNetworkAllowancesWarningForTesting,
} = await import('../sandbox-adapter.js')

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const adapterSrc = readFileSync(
  join(REPO_ROOT, 'src/utils/sandbox/sandbox-adapter.ts'),
  'utf8',
)
const sandboxTypesSrc = readFileSync(
  join(REPO_ROOT, 'src/entrypoints/sandboxTypes.ts'),
  'utf8',
)

/** Seed every source through the settings cache (null = no settings). */
function seed(bySource: Partial<Record<SettingSource, SettingsJson>>): void {
  for (const source of ALL_SOURCES) {
    setCachedSettingsForSource(source, bySource[source] ?? null)
  }
}

beforeEach(() => {
  resetSettingsCache()
  seed({})
  debugLines.length = 0
  _resetAllowedDomainsWarningForTesting()
  _resetFilesystemGrantsWarningForTesting()
  _resetNetworkAllowancesWarningForTesting()
})

// ---------------------------------------------------------------------------
// Real-filesystem fixtures. Everything is realpath-normalized up front so the
// deny baseline and the candidate resolutions compare in the same namespace
// (macOS tmpdir symlinks /var → /private/var).
// ---------------------------------------------------------------------------
const tmpRoots: string[] = []

interface RepointFixture {
  root: string
  denied: string // trusted read-deny directory
  benign: string // allowed directory the grant starts out pointing at
  grant: string // the untrusted grant path (symlink the test re-points)
  secretFile: string // sensitive file inside denied
}

function makeFixture(prefix: string): RepointFixture {
  const raw = mkdtempSync(join(tmpdir(), `occ-repoint292-${prefix}-`))
  const root = realpathSync(raw)
  tmpRoots.push(raw)
  const denied = join(root, 'secret')
  const benign = join(root, 'benign')
  const grant = join(root, 'grant-link')
  mkdirSync(denied)
  mkdirSync(benign)
  const secretFile = join(denied, 'token.txt')
  writeFileSync(secretFile, 's3cr3t')
  writeFileSync(join(benign, 'ok.txt'), 'public')
  symlinkSync(benign, grant)
  return { root, denied, benign, grant, secretFile }
}

function repoint(f: RepointFixture, target: string): void {
  unlinkSync(f.grant)
  symlinkSync(target, f.grant)
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
})

/** Trusted (--settings tier) denyRead baseline + untrusted project grant. */
function seedDenyAndGrant(f: RepointFixture, grantPaths: string[]): void {
  seed({
    flagSettings: {
      sandbox: { filesystem: { denyRead: [f.denied] } },
    } as SettingsJson,
    projectSettings: {
      sandbox: { filesystem: { allowRead: grantPaths } },
    } as SettingsJson,
  })
}

// ---------------------------------------------------------------------------
// Behavior — the re-point / appears-mid-session drop (live re-resolution)
// ---------------------------------------------------------------------------
describe('CC 2.1.292 — read-deny re-point drops untrusted grants on rebuild', () => {
  test('grant through a symlink into a BENIGN dir survives; after re-point into the denied dir it is dropped', () => {
    const f = makeFixture('read')
    seedDenyAndGrant(f, [f.grant])

    // Session start: grant-link → benign/ — not under the deny baseline.
    const before = convertToSandboxRuntimeConfig({})
    expect(before.filesystem.allowRead).toContain(f.grant)
    expect(before.filesystem.denyRead).toContain(f.denied)

    // Mid-session: a sandboxed command (which can write the directory holding
    // the link) re-points grant-link → secret/. The NEXT config build — which
    // 292 makes happen before every command — must drop the grant.
    repoint(f, f.denied)
    _resetFilesystemGrantsWarningForTesting()
    const after = convertToSandboxRuntimeConfig({})
    expect(after.filesystem.allowRead).not.toContain(f.grant)
    // The deny itself is untouched (a deny is never narrowed by this fix).
    expect(after.filesystem.denyRead).toContain(f.denied)
    // The drop is counted + logged through the 285 one-shot machinery.
    expect(
      debugLines.filter((l) =>
        l.startsWith('[sandbox] filesystem grants restricted'),
      ).length,
    ).toBe(1)
  })

  test('APPEARS mid-session: grant to an absent path survives, then the path materializes as a symlink into the denied dir → dropped', () => {
    const f = makeFixture('appears')
    const later = join(f.root, 'later')
    seedDenyAndGrant(f, [later])

    // Absent at build time: realpathExistingPrefix falls back to the longest
    // existing ancestor (f.root), which is not under the deny baseline.
    const before = convertToSandboxRuntimeConfig({})
    expect(before.filesystem.allowRead).toContain(later)

    // The path appears mid-session pointing INTO the denied directory.
    symlinkSync(f.denied, later)
    const after = convertToSandboxRuntimeConfig({})
    expect(after.filesystem.allowRead).not.toContain(later)
  })

  test('allowWrite leg: a re-pointed WRITE grant is dropped the same way (Rc screening)', () => {
    const f = makeFixture('write')
    seed({
      flagSettings: {
        sandbox: { filesystem: { denyRead: [f.denied] } },
      } as SettingsJson,
      projectSettings: {
        sandbox: { filesystem: { allowWrite: [f.grant] } },
      } as SettingsJson,
    })

    const before = convertToSandboxRuntimeConfig({})
    expect(before.filesystem.allowWrite).toContain(f.grant)

    repoint(f, f.denied)
    const after = convertToSandboxRuntimeConfig({})
    expect(after.filesystem.allowWrite).not.toContain(f.grant)
  })

  test('TRUSTED-tier grant is NOT screened (a re-pointed user grant survives — screening stays untrusted-only)', () => {
    const f = makeFixture('trusted')
    seed({
      flagSettings: {
        sandbox: {
          filesystem: { denyRead: [f.denied], allowRead: [f.grant] },
        },
      } as SettingsJson,
    })

    const before = convertToSandboxRuntimeConfig({})
    expect(before.filesystem.allowRead).toContain(f.grant)

    repoint(f, f.denied)
    const after = convertToSandboxRuntimeConfig({})
    // Trusted tiers keep their grants — the 285/292 screening only drops
    // project/local (untrusted) values.
    expect(after.filesystem.allowRead).toContain(f.grant)
  })

  test('benign re-point (denied → benign) RE-ADMITs the grant: the re-check is live in both directions', () => {
    const f = makeFixture('readmit')
    // Start pointed at the denied dir → dropped.
    repoint(f, f.denied)
    seedDenyAndGrant(f, [f.grant])
    const deniedBuild = convertToSandboxRuntimeConfig({})
    expect(deniedBuild.filesystem.allowRead).not.toContain(f.grant)

    // Re-point back to benign → admitted again on the next build.
    repoint(f, f.benign)
    const benignBuild = convertToSandboxRuntimeConfig({})
    expect(benignBuild.filesystem.allowRead).toContain(f.grant)
  })
})

// ---------------------------------------------------------------------------
// Cadence — the per-command re-check wiring (source pins; the wrap path pulls
// in the sandbox runtime which cannot execute hermetically under bun test)
// ---------------------------------------------------------------------------
describe('CC 2.1.292 — per-command re-check cadence (source pins)', () => {
  test('wrapWithSandbox calls refreshConfig() BEFORE delegating to the runtime', () => {
    const idxWrap = adapterSrc.indexOf('async function wrapWithSandbox(')
    const idxRefresh = adapterSrc.indexOf('refreshConfig()', idxWrap)
    const idxBase = adapterSrc.indexOf(
      'return BaseSandboxManager.wrapWithSandbox(',
      idxWrap,
    )
    expect(idxWrap).toBeGreaterThan(-1)
    expect(idxRefresh).toBeGreaterThan(idxWrap)
    expect(idxBase).toBeGreaterThan(idxRefresh)
  })

  test('the re-check is gated on sandboxing being enabled + initialized', () => {
    const idxWrap = adapterSrc.indexOf('async function wrapWithSandbox(')
    const idxEnabled = adapterSrc.indexOf('if (isSandboxingEnabled()) {', idxWrap)
    const idxRefresh = adapterSrc.indexOf('refreshConfig()', idxWrap)
    expect(idxEnabled).toBeGreaterThan(idxWrap)
    expect(idxRefresh).toBeGreaterThan(idxEnabled)
  })

  test('refreshConfig rebuilds through convertToSandboxRuntimeConfig + updateConfig (sync — no race window)', () => {
    const idx = adapterSrc.indexOf('function refreshConfig(): void')
    expect(idx).toBeGreaterThan(-1)
    const body = adapterSrc.slice(idx, idx + 400)
    expect(body).toContain('convertToSandboxRuntimeConfig(settings)')
    expect(body).toContain('BaseSandboxManager.updateConfig(newConfig)')
    expect(body).not.toContain('await')
  })

  test('the port comment cites the official describe + changelog provenance', () => {
    expect(adapterSrc).toContain(
      're-checked before every command and dropped once',
    )
    expect(adapterSrc).toContain('appears or re-points mid-session')
    expect(adapterSrc).toContain('Bc @14021955')
    expect(adapterSrc).toContain('Wc @11317030')
  })
})

// ---------------------------------------------------------------------------
// Schema describes — the official 292 re-check sentences, byte-verbatim
// ---------------------------------------------------------------------------
describe('CC 2.1.292 — sandboxTypes describes carry the official re-check sentences', () => {
  test('allowRead describe source carries the official Bc sentence fragments', () => {
    // The source splits the sentence across string-concat lines; the runtime
    // assembly is pinned by the schema-construction test below.
    expect(sandboxTypesSrc).toContain(
      "'A value inside a directory sandboxed commands can write is ' +",
    )
    expect(sandboxTypesSrc).toContain(
      "'re-pointed into a denied path.',",
    )
  })

  test('allowWrite describe source carries the official Wc sentence fragments', () => {
    expect(sandboxTypesSrc).toContain(
      "'A value inside a directory sandboxed commands can already write ' +",
    )
    expect(sandboxTypesSrc).toContain(
      "'re-pointed into a denied read path.',",
    )
  })

  test('the assembled describe strings survive schema construction', async () => {
    const { SandboxFilesystemConfigSchema } = await import(
      '../../../entrypoints/sandboxTypes.js'
    )
    // The schema is z.object({...}).optional() behind lazySchema — unwrap to
    // reach the field describes.
    const parsed: any = SandboxFilesystemConfigSchema()
    const shape = parsed.shape ?? parsed.unwrap?.().shape
    const allowReadDescribe: string = shape.allowRead.description ?? ''
    const allowWriteDescribe: string = shape.allowWrite.description ?? ''
    expect(allowReadDescribe).toContain(
      're-checked before every command and dropped once it has been re-pointed into a denied path.',
    )
    expect(allowWriteDescribe).toContain(
      're-checked before every command and dropped once it has been re-pointed into a denied read path.',
    )
  })
})
