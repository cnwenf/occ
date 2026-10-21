import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'path'
import type { SettingSource } from '../../settings/constants.js'
import type { SettingsJson } from '../../settings/types.js'

/**
 * CC 2.1.305 — `sandbox.allowNestedUserNamespaces` settings key + runtime
 * enforcement backport onto the patched @anthropic-ai/sandbox-runtime@0.0.44.
 *
 * Byte evidence (official 2.1.306 linux-x64 ELF, /tmp/cc-diff-306/v306 —
 * strings/byte reads only, never executed):
 *  - CC settings schema describe @238321756 (896 chars incl. the `${je}`
 *    interpolant resolved to the literal "project settings (.claude/
 *    settings.json and .claude/settings.local.json)" string @129034724).
 *  - Official trusted-tier read `Mp(e,n){return e===!1?!1:my(n)}` @244325168
 *    + `my` walk of `gy()` (policy → --settings → user) @244270329;
 *    builtConfig passthrough @244386980.
 *  - Official policy-lock table `Xe` @238346103: `{path:["sandbox",
 *    "allowNestedUserNamespaces"],restrictive:!1}` right after allowAppleEvents.
 *  - Official `Xi` valid-nested-key list @238365501.
 *  - Runtime enforcement (official vendored sandbox-runtime inside the ELF):
 *    `SRT_ALLOW_NESTED_USERNS` env prefix helper `b8`, memoized `bwrap --help`
 *    probe `S8` (setuid check `mode & 2048`, no memoize on error/empty
 *    output), warn-once latch `M1` with the verbatim warn string @244152829,
 *    unconditional `--unsetenv SRT_ALLOW_NESTED_USERNS`, and default-block
 *    gate `seccompFilterPath === undefined && flag !== true` with
 *    `enableWeakerNestedSandbox ? null : which('bwrap')`.
 *    Runtime schema describe @263352133.
 *
 * Deviations documented in docs/gap-research-306/impl-WP5.md:
 *  - OCC's merged read is NOT tier-filtered (plain deep merge), so the
 *    adapter implements the official `Mp` false-sticky trusted-tier scan
 *    instead of a plain merged read.
 *  - The official `Pu()&&c8()` force-false leg (subprocess env-scrub mode)
 *    has no OCC equivalent and is not ported.
 *  - 0.0.44's native apply-seccomp ignores SRT_ALLOW_NESTED_USERNS (it only
 *    blocks socket(AF_UNIX)); the env prefix is forward-compat parity. Full
 *    default-block parity under the helper path needs the newer native
 *    binary, which 0.0.44 does not ship.
 *
 * Harness: per-source settings seeded through the settings cache test hook
 * (setCachedSettingsForSource — trustedTierGrants285 pattern, no disk reads).
 * Runtime-layer tests exercise the PATCHED node_modules copy directly
 * (sandboxRuntimeZshTrapPatch pattern + functional wrap calls).
 */

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const RUNTIME_DIST = join(
  REPO_ROOT,
  'node_modules/@anthropic-ai/sandbox-runtime/dist',
)
const LINUX_UTILS_FILE = join(RUNTIME_DIST, 'sandbox/linux-sandbox-utils.js')
const SANDBOX_CONFIG_FILE = join(RUNTIME_DIST, 'sandbox/sandbox-config.js')
const PATCH_FILE = join(
  REPO_ROOT,
  'patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch',
)

/** Official CC-side describe (v306 @238321756, `${je}` substituted). */
const OFFICIAL_CC_DESCRIBE =
  "Linux/WSL only: Let sandboxed commands create user namespaces of their own, which the sandbox refuses by default. Needed by tools that sandbox themselves that way, such as Chromium's and Electron's sandbox, rootless podman or buildah, a nested bubblewrap, and `unshare`. " +
  '**Removes code-execution isolation** — in any folder a hostile command may write, it can then bypass filesystem.denyWrite, filesystem.denyRead, credentials.files entries and the paths the sandbox always write-protects (such as .claude/settings.json, git hooks and git config), ' +
  'and so plant code that later runs outside the sandbox; while autoAllowBashIfSandboxed is on, the command that plants it needs no approval. Default: false. ' +
  'Only honored from user, managed/policy, or CLI (--settings) settings — ' +
  'true from project settings (.claude/settings.json and .claude/settings.local.json) is ignored (false there still applies).'

/** Official runtime-side describe (v306 vendored sandbox-runtime @263352133). */
const OFFICIAL_RUNTIME_DESCRIBE =
  'Let the sandboxed command create user namespaces of its own (Linux only), as a browser sandbox, rootless podman or a nested bubblewrap does. This gives up the write denies against a hostile command, which can then take the read-only binds that enforce denyWrite and the mandatory denies out of its own view. Default: false.'

/** Official warn-once string (v306 @244152829 region — plain " - ", not em-dash). */
const OFFICIAL_NO_HELPER_WARN =
  '[Sandbox Linux] no seccomp helper in use, and bubblewrap cannot disable user namespaces (needs 0.8.0 or later, not setuid, and no enableWeakerNestedSandbox) - a sandboxed command that creates one can undo the write denies'

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

const { setCachedSettingsForSource, resetSettingsCache } = await import(
  '../../settings/settingsCache.js'
)
const { convertToSandboxRuntimeConfig } = await import('../sandbox-adapter.js')
const { SandboxSettingsSchema } = await import(
  '../../../entrypoints/sandboxTypes.js'
)
const { RESTRICTIVE_ENTRIES } = await import('../../settings/policyLocks.js')
const { buildStrictPolicySchema, createPolicyIssueSink } = await import(
  '../../settings/policyStrictSchema.js'
)
const { getManagedSettingsKeysForLogging } = await import(
  '../../settings/settings.js'
)
const { wrapCommandWithSandboxLinux } = await import(
  /* webpackIgnore: true */ join(RUNTIME_DIST, 'sandbox/linux-sandbox-utils.js')
)

/** Seed every source through the settings cache (null = no settings). */
function seed(bySource: Partial<Record<SettingSource, SettingsJson>>): void {
  for (const source of ALL_SOURCES) {
    setCachedSettingsForSource(source, bySource[source] ?? null)
  }
}

/** Convert with a given merged `sandbox.allowNestedUserNamespaces` value. */
function convertWithMerged(merged: boolean | undefined): boolean | undefined {
  const settings: SettingsJson =
    merged === undefined
      ? {}
      : { sandbox: { allowNestedUserNamespaces: merged } }
  return convertToSandboxRuntimeConfig(settings)
    .allowNestedUserNamespaces as boolean | undefined
}

beforeEach(() => {
  resetSettingsCache()
  seed({})
})

// ---------------------------------------------------------------------------
// Part 1 — Layer A1: OCC settings schema (sandboxTypes.ts)
// ---------------------------------------------------------------------------

describe('2.1.305 sandbox.allowNestedUserNamespaces — CC settings schema', () => {
  test('schema accepts true and false and keeps the key through parse', () => {
    const schema = SandboxSettingsSchema()
    const t = schema.safeParse({ allowNestedUserNamespaces: true })
    const f = schema.safeParse({ allowNestedUserNamespaces: false })
    expect(t.success).toBe(true)
    expect(f.success).toBe(true)
    expect(
      (t.data as { allowNestedUserNamespaces?: boolean })
        .allowNestedUserNamespaces,
    ).toBe(true)
    expect(
      (f.data as { allowNestedUserNamespaces?: boolean })
        .allowNestedUserNamespaces,
    ).toBe(false)
  })

  test('schema rejects a non-boolean value', () => {
    const schema = SandboxSettingsSchema()
    expect(schema.safeParse({ allowNestedUserNamespaces: 'yes' }).success).toBe(
      false,
    )
    expect(schema.safeParse({ allowNestedUserNamespaces: 1 }).success).toBe(
      false,
    )
  })

  test('describe text is byte-identical to the official v306 string', () => {
    const shape = SandboxSettingsSchema().shape as Record<
      string,
      { description?: string }
    >
    expect(shape.allowNestedUserNamespaces).toBeDefined()
    expect(shape.allowNestedUserNamespaces.description).toBe(
      OFFICIAL_CC_DESCRIBE,
    )
    expect(shape.allowNestedUserNamespaces.description?.length).toBe(896)
  })

  test('key sits between enableWeakerNestedSandbox and enableWeakerNetworkIsolation (official order)', () => {
    const keys = Object.keys(SandboxSettingsSchema().shape)
    const i = keys.indexOf('allowNestedUserNamespaces')
    expect(i).toBeGreaterThan(keys.indexOf('enableWeakerNestedSandbox'))
    expect(i).toBeLessThan(keys.indexOf('enableWeakerNetworkIsolation'))
  })
})

// ---------------------------------------------------------------------------
// Part 2 — Layer A2/A3: policyLocks entry + managed fail-closed parse +
// validNestedKeys expansion
// ---------------------------------------------------------------------------

type PolicyRecord = {
  path: string
  message: string
  substituted?: boolean
}

function parseStrict(doc: unknown): {
  data: Record<string, unknown>
  errors: PolicyRecord[]
} {
  const errors: PolicyRecord[] = []
  const result = buildStrictPolicySchema(
    createPolicyIssueSink('managed-settings.json', errors),
  ).safeParse(doc)
  return {
    data: result.success ? (result.data as Record<string, unknown>) : {},
    errors,
  }
}

describe('2.1.305 allowNestedUserNamespaces — policy locks & key expansion', () => {
  test('RESTRICTIVE_ENTRIES carries the official Xe row (restrictive:false, right after allowAppleEvents)', () => {
    const paths = RESTRICTIVE_ENTRIES.map((e) => e.path.join('.'))
    const idx = paths.indexOf('sandbox.allowNestedUserNamespaces')
    expect(idx).toBeGreaterThan(-1)
    expect(RESTRICTIVE_ENTRIES[idx]?.restrictive).toBe(false)
    // Official table order @238346103: immediately after sandbox.allowAppleEvents.
    expect(idx).toBe(paths.indexOf('sandbox.allowAppleEvents') + 1)
  })

  test('invalid managed value substitutes false (fail-closed restrictive reading)', () => {
    const { data, errors } = parseStrict({
      sandbox: { allowNestedUserNamespaces: 42 },
    })
    const sandbox = data.sandbox as Record<string, unknown> | undefined
    expect(sandbox?.allowNestedUserNamespaces).toBe(false)
    const record = errors.find(
      (e) => e.path === 'sandbox.allowNestedUserNamespaces',
    )
    expect(record?.message).toContain(
      'treating it as false, its restrictive value',
    )
  })

  test('valid managed true and false pass through untouched', () => {
    const t = parseStrict({ sandbox: { allowNestedUserNamespaces: true } })
    const f = parseStrict({ sandbox: { allowNestedUserNamespaces: false } })
    expect(
      (t.data.sandbox as Record<string, unknown>)?.allowNestedUserNamespaces,
    ).toBe(true)
    expect(
      (f.data.sandbox as Record<string, unknown>)?.allowNestedUserNamespaces,
    ).toBe(false)
    expect(
      t.errors.some((e) => e.path === 'sandbox.allowNestedUserNamespaces'),
    ).toBe(false)
  })

  test('getManagedSettingsKeysForLogging expands sandbox.allowNestedUserNamespaces (validNestedKeys / official Xi list)', () => {
    const keys = getManagedSettingsKeysForLogging({
      sandbox: { allowNestedUserNamespaces: true },
    })
    expect(keys).toContain('sandbox.allowNestedUserNamespaces')
  })
})

// ---------------------------------------------------------------------------
// Part 3 — Layer A4: convertToSandboxRuntimeConfig trusted-tier passthrough
// (official Mp @244325168: merged false wins; else first DEFINED trusted-tier
// value, policy → flag → user; project/local true never honored)
// ---------------------------------------------------------------------------

describe('2.1.305 allowNestedUserNamespaces — adapter trusted-tier passthrough (official Mp/my)', () => {
  test('unset everywhere → undefined', () => {
    expect(convertWithMerged(undefined)).toBeUndefined()
  })

  test('project-tier true is IGNORED (merged true, no trusted value)', () => {
    seed({
      projectSettings: { sandbox: { allowNestedUserNamespaces: true } },
    })
    expect(convertWithMerged(true)).toBeUndefined()
  })

  test('local-tier true is IGNORED (merged true, no trusted value)', () => {
    seed({
      localSettings: { sandbox: { allowNestedUserNamespaces: true } },
    })
    expect(convertWithMerged(true)).toBeUndefined()
  })

  test('project-tier false STILL APPLIES (merged false wins outright)', () => {
    seed({
      projectSettings: { sandbox: { allowNestedUserNamespaces: false } },
    })
    expect(convertWithMerged(false)).toBe(false)
  })

  test('user-tier true is honored', () => {
    seed({ userSettings: { sandbox: { allowNestedUserNamespaces: true } } })
    expect(convertWithMerged(true)).toBe(true)
  })

  test('--settings (flag) tier true is honored', () => {
    seed({ flagSettings: { sandbox: { allowNestedUserNamespaces: true } } })
    expect(convertWithMerged(true)).toBe(true)
  })

  test('managed (policy) tier true is honored', () => {
    seed({ policySettings: { sandbox: { allowNestedUserNamespaces: true } } })
    expect(convertWithMerged(true)).toBe(true)
  })

  test('user false beats project true (trusted scan finds false even when merged reads true)', () => {
    // OCC merge order user → project → … means project true overrides user
    // false in the merged view — exactly why the plain merged read is unsafe
    // and the official Mp scans the trusted tiers.
    seed({
      userSettings: { sandbox: { allowNestedUserNamespaces: false } },
      projectSettings: { sandbox: { allowNestedUserNamespaces: true } },
    })
    expect(convertWithMerged(true)).toBe(false)
  })

  test('policy false wins over user true (priority order policy → flag → user)', () => {
    seed({
      policySettings: { sandbox: { allowNestedUserNamespaces: false } },
      userSettings: { sandbox: { allowNestedUserNamespaces: true } },
    })
    // Merged reads false (policy overrides last) → false-sticky leg.
    expect(convertWithMerged(false)).toBe(false)
  })

  test('flag true wins over user false (first DEFINED trusted value, flag before user)', () => {
    seed({
      flagSettings: { sandbox: { allowNestedUserNamespaces: true } },
      userSettings: { sandbox: { allowNestedUserNamespaces: false } },
    })
    // Merged reads false (user false is overridden by flag true in OCC's
    // merge order user → … → flag; flag wins) — merged true, flag scanned
    // before user → true.
    expect(convertWithMerged(true)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Part 4 — Layer B: patched runtime source guards (dependency-bump tripwires,
// sandboxRuntimeZshTrapPatch pattern)
// ---------------------------------------------------------------------------

describe('2.1.305 runtime backport — patched dependency source guards', () => {
  test('linux-sandbox-utils.js carries the enforcement machinery', () => {
    const source = readFileSync(LINUX_UTILS_FILE, 'utf8')
    expect(source).toContain("const SRT_ALLOW_NESTED_USERNS = 'SRT_ALLOW_NESTED_USERNS'")
    expect(source).toContain('nestedUsernsEnvPrefix')
    expect(source).toContain("'--unsetenv', SRT_ALLOW_NESTED_USERNS")
    expect(source).toContain("'--disable-userns'")
    // Memoized probe + setuid check + no-memoize-on-error, official S8 shape.
    expect(source).toContain('bwrapDisableUsernsSupport')
    expect(source).toContain('mode & 2048')
    expect(source).toContain("['--help']")
    // Default-block gate: no helper AND flag !== true.
    expect(source).toContain(
      'seccompFilterPath === undefined && allowNestedUserNamespaces !== true',
    )
    // enableWeakerNestedSandbox skips the probe (official `q?null:...`).
    expect(source).toContain(
      'enableWeakerNestedSandbox ? null : whichSync',
    )
    // Warn-once latch + verbatim official warn string.
    expect(source).toContain('warnedNoNestedUsernsBlock')
    expect(source).toContain(OFFICIAL_NO_HELPER_WARN)
  })

  test('sandbox-config.js schema carries the key with the official runtime describe', () => {
    const source = readFileSync(SANDBOX_CONFIG_FILE, 'utf8')
    expect(source).toContain('allowNestedUserNamespaces')
    expect(source).toContain(OFFICIAL_RUNTIME_DESCRIBE)
  })

  test('sandbox-manager.js threads the config flag into the Linux wrapper', () => {
    const source = readFileSync(
      join(RUNTIME_DIST, 'sandbox/sandbox-manager.js'),
      'utf8',
    )
    expect(source).toContain('getAllowNestedUserNamespaces')
    expect(source).toContain('allowNestedUserNamespaces: getAllowNestedUserNamespaces()')
  })

  test('patch file contains the new hunks AND preserves the pre-existing trap/glob fixes', () => {
    const patch = readFileSync(PATCH_FILE, 'utf8')
    expect(patch).toContain('allowNestedUserNamespaces')
    expect(patch).toContain('SRT_ALLOW_NESTED_USERNS')
    // 2.1.276 zsh trap fix + 2.1.304 glob fix must survive regeneration.
    expect(patch).toContain('rc=$?; kill %1 %2 2>/dev/null; exit $rc')
    expect(patch).toContain('OCC patch — CC 2.1.304 #9')
  })

  test('runtime schema accepts the key and safeParse retains it', async () => {
    const { SandboxRuntimeConfigSchema } = await import(
      /* webpackIgnore: true */ join(RUNTIME_DIST, 'sandbox/sandbox-config.js')
    )
    const parsed = SandboxRuntimeConfigSchema.safeParse({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      allowNestedUserNamespaces: true,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.allowNestedUserNamespaces).toBe(true)
    const described =
      SandboxRuntimeConfigSchema.shape.allowNestedUserNamespaces.description
    expect(described).toBe(OFFICIAL_RUNTIME_DESCRIBE)
  })
})

// ---------------------------------------------------------------------------
// Part 5 — Layer B: functional wrap tests against the patched runtime
// ---------------------------------------------------------------------------

const VENDOR_ARCH_DIR = process.arch === 'arm64' ? 'arm64' : 'x64'
const HAS_SECCOMP_HELPER =
  process.platform === 'linux' &&
  existsSync(
    join(RUNTIME_DIST, `vendor/seccomp/${VENDOR_ARCH_DIR}/apply-seccomp`),
  )

const WRAP_BASE = {
  command: 'echo hi',
  needsNetworkRestriction: false,
  writeConfig: { allowOnly: ['/tmp'] },
  binShell: 'bash',
}

describe('2.1.305 runtime backport — wrapCommandWithSandboxLinux behavior', () => {
  afterEach(() => {
    delete process.env.SRT_DEBUG
  })

  test.skipIf(!HAS_SECCOMP_HELPER)(
    'helper path: apply-seccomp invocation gets SRT_ALLOW_NESTED_USERNS=0 by default + --unsetenv',
    async () => {
      const out = await wrapCommandWithSandboxLinux({ ...WRAP_BASE })
      expect(out).toContain('SRT_ALLOW_NESTED_USERNS=0 ')
      expect(out).toContain('--unsetenv SRT_ALLOW_NESTED_USERNS')
      // The JS default-block only runs when NO helper is in use.
      expect(out).not.toContain('--disable-userns')
    },
  )

  test.skipIf(!HAS_SECCOMP_HELPER)(
    'helper path: flag true flips the env prefix to SRT_ALLOW_NESTED_USERNS=1',
    async () => {
      const out = await wrapCommandWithSandboxLinux({
        ...WRAP_BASE,
        allowNestedUserNamespaces: true,
      })
      expect(out).toContain('SRT_ALLOW_NESTED_USERNS=1 ')
      expect(out).toContain('--unsetenv SRT_ALLOW_NESTED_USERNS')
    },
  )

  test('no-helper path: default block adapts to host bwrap (probe or verbatim warn)', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    // SRT_DEBUG routes info-level runtime logs to console.error — swallow the
    // noise while keeping the warn channel observable through the spy.
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    process.env.SRT_DEBUG = '1'
    try {
      const out = await wrapCommandWithSandboxLinux({
        ...WRAP_BASE,
        allowAllUnixSockets: true, // forces seccompFilterPath === undefined
      })
      expect(out).toContain('--unsetenv SRT_ALLOW_NESTED_USERNS')
      // whichSync === Bun.which (dist/utils/which.js) — same snapshot view.
      const hostBwrap = Bun.which('bwrap')
      if (hostBwrap === null) {
        expect(out).not.toContain('--disable-userns')
        const warned = warnSpy.mock.calls.flat().join(' ')
        // Warn-once latch may already be set by an earlier suite in the same
        // process; when it fires here it must be the verbatim official string.
        if (warned.includes('[Sandbox Linux]')) {
          expect(warned).toContain(OFFICIAL_NO_HELPER_WARN)
        }
      } else {
        // Mirror the official S8 probe: not setuid AND --help lists the flag.
        const isSetuid = (statSync(hostBwrap).mode & 2048) !== 0
        const help = spawnSync(hostBwrap, ['--help'], {
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        })
        const supported =
          !isSetuid &&
          help.error === undefined &&
          ((help.stdout ?? '') + (help.stderr ?? '')).includes(
            '--disable-userns',
          )
        expect(out.includes('--disable-userns')).toBe(supported)
      }
    } finally {
      warnSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  test('no-helper path: flag true skips the default block entirely', async () => {
    const out = await wrapCommandWithSandboxLinux({
      ...WRAP_BASE,
      allowAllUnixSockets: true,
      allowNestedUserNamespaces: true,
    })
    expect(out).not.toContain('--disable-userns')
    expect(out).toContain('--unsetenv SRT_ALLOW_NESTED_USERNS')
  })

  test('no-helper path: enableWeakerNestedSandbox skips the bwrap probe (official q?null:…)', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    process.env.SRT_DEBUG = '1'
    try {
      const out = await wrapCommandWithSandboxLinux({
        ...WRAP_BASE,
        allowAllUnixSockets: true,
        enableWeakerNestedSandbox: true,
      })
      expect(out).not.toContain('--disable-userns')
    } finally {
      warnSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})
