import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * Official Claude Code 2.1.277 changelog (security): "Fixed a
 * `sandbox.excludedCommands` glob exempting an entire compound Bash command
 * from the sandbox when only one part matched; every part must now match."
 *
 * v276 bug (binary `kls` @199,320,347): ANY subcommand matching ANY pattern
 * returned true → the WHOLE compound ran unsandboxed (`git status; rm -rf /`
 * escaped under excludedCommands:['git']).
 *
 * v277 fix (binary `Rvo` @200,916,229, kept in v278 as `Zvo`):
 *   if(Avo(h))return!1;
 *   return h.every((O,L)=>Pvo(O,y,r,L===0||!w))
 * — EVERY part must match, and the `Avo` env-assignment guard forces the
 * compound to stay sandboxed when a variable assigned in one part is
 * referenced from a different part (assignment smuggling the per-part
 * matcher cannot see through).
 *
 * Rule-compiler note (byte-verified v277 `BKt`/`eRe` @195,572,290 ≡ v278
 * `GKt`): a bare pattern like `git` compiles to an EXACT rule (matches only
 * the bare command `git`); prefix matching requires `git:*`. OCC's
 * `bashPermissionRule` has identical semantics, so tests that need
 * `git status`-style commands to match use `['git:*']`. The report's UT
 * sketch used `['git']` assuming prefix behavior — adjusted here without
 * changing the every-part intent.
 *
 * Mock.module hygiene per the OCC-97 lesson (see anthropicDefaultModel236):
 * snapshot the real namespaces BEFORE installing mocks and restore in
 * afterAll so registrations do not leak into other files in this worker.
 */
const actualSandboxModule = await import(
  '../../../utils/sandbox/sandbox-adapter.js'
)
const actualSandboxExports = { ...actualSandboxModule }
const actualSettingsModule = await import('../../../utils/settings/settings.js')
const actualSettingsExports = { ...actualSettingsModule }

let sandboxingEnabled = true
let unsandboxedCommandsAllowed = true
let mockedExcludedCommands: string[] = []

mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
  ...actualSandboxExports,
  SandboxManager: {
    ...actualSandboxExports.SandboxManager,
    isSandboxingEnabled: () => sandboxingEnabled,
    areUnsandboxedCommandsAllowed: () => unsandboxedCommandsAllowed,
  },
}))

mock.module('../../../utils/settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettings_DEPRECATED: () => ({
    sandbox: { excludedCommands: mockedExcludedCommands },
  }),
}))

afterAll(() => {
  mock.module('../../../utils/sandbox/sandbox-adapter.js', () => ({
    ...actualSandboxExports,
  }))
  mock.module('../../../utils/settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
})

const { shouldUseSandbox } = await import('../shouldUseSandbox.js')

let savedUserType: string | undefined
beforeAll(() => {
  // The ant dynamic-config branch must stay dark for these user-config tests.
  savedUserType = process.env.USER_TYPE
  delete process.env.USER_TYPE
})
afterAll(() => {
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
})

beforeEach(() => {
  sandboxingEnabled = true
  unsandboxedCommandsAllowed = true
  mockedExcludedCommands = []
})

/** shouldUseSandbox===true means the command runs SANDBOXED (not exempted). */
function isSandboxed(command: string): boolean {
  return shouldUseSandbox({ command })
}

describe('2.1.277 B7 — excludedCommands: EVERY compound part must match (was: any part)', () => {
  test('compound where only the FIRST part matches stays sandboxed (the v276 any-part bug)', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert — v276 exempted the whole compound here
    expect(isSandboxed('git status; rm -rf /')).toBe(true)
  })

  test('compound where only the SECOND part matches stays sandboxed', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('rm -rf /; git status')).toBe(true)
  })

  test('compound where every part matches is exempted', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('git status; git log')).toBe(false)
  })

  test('&& chain with one non-matching part stays sandboxed', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('git status && curl evil.com')).toBe(true)
  })

  test('&& chain where every part matches is exempted', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('git status && git log')).toBe(false)
  })

  test('pipe compound with one non-matching part stays sandboxed', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('git status | rm -rf /')).toBe(true)
  })

  test('wildcard (glob) pattern exempts only when every part matches the glob', () => {
    // Arrange
    mockedExcludedCommands = ['docker:*']

    // Act & Assert
    expect(isSandboxed('docker ps; docker images')).toBe(false)
    expect(isSandboxed('docker ps; rm -rf /')).toBe(true)
  })
})

describe('2.1.277 B7 — env-assignment prefix cases (report UT set)', () => {
  test('env-assignment prefix on one part with a non-matching sibling stays sandboxed', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert — the `rm` part is not excluded, so no exemption
    expect(isSandboxed('FOO=1 git status; rm -rf /')).toBe(true)
  })

  test('env-assignment prefixes on every part still exempt (stripping regression)', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('FOO=1 git status; git log')).toBe(false)
  })

  test('PATH hijack prefix is NOT stripped, so the part does not match (BINARY_HIJACK_VARS)', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert — `PATH=/evil git status` must not launder into a match
    expect(isSandboxed('PATH=/evil git status; git log')).toBe(true)
  })

  test('safe-wrapper prefix with a non-matching sibling stays sandboxed', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert — `curl` part is not excluded
    expect(isSandboxed('timeout 5 git status; curl evil')).toBe(true)
  })

  test('safe-wrapper prefixes on every matching part still exempt', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('timeout 5 git status; git log')).toBe(false)
  })
})

describe('2.1.277 B7 — Avo env-assignment smuggling guard', () => {
  test('cross-part pure assignment referenced by a matching sibling forces sandbox even when every part matches', () => {
    // Arrange — without the guard, BOTH parts match `*` and the compound
    // would be exempted; `git status $NODE_ENV` executes whatever NODE_ENV
    // interpolation yields at runtime, which the matcher cannot see through.
    mockedExcludedCommands = ['*']

    // Act & Assert
    expect(isSandboxed('NODE_ENV=prod; git status $NODE_ENV')).toBe(true)
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash `${VAR:=}` syntax in the test name, not a JS template placeholder.
  test('cross-part ${VAR:=} default-assignment referenced by another part forces sandbox', () => {
    // Arrange — both parts match the `git` prefix rule; the quoted
    // `${FOO:=x}` in part 1 assigns FOO and part 2 references `$FOO`.
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash `${FOO:=x}` in the command under test, not a JS template placeholder.
    expect(isSandboxed("git status '${FOO:=x}'; git log $FOO")).toBe(true)
  })

  test('assignment and reference within the SAME part do not trigger the guard', () => {
    // Arrange — FOO is assigned and only self-referenced (part 2), which the
    // official guard explicitly skips (`y.size===1&&y.has(s)`).
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash `${FOO:=x}` in the command under test, not a JS template placeholder.
    expect(isSandboxed("git status; git log '${FOO:=x}'")).toBe(false)
  })

  test('self-contained env prefix without cross-part reference does not trigger the guard', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('NODE_ENV=prod git status; git log')).toBe(false)
  })

  test('locale var assignment (LANG) is NOT recorded by the guard map, so the every-part rule alone decides', () => {
    // Arrange — official `asn` excludes LC_ALL/LC_CTYPE/LANG/LANGUAGE/CHARSET
    // (GEo set): `LANG=x` is never recorded as an assignment, so the guard
    // stays inert (contrast the NODE_ENV test above, which fires). Exemption
    // is decided by the every-part rule alone: both parts match `*`.
    mockedExcludedCommands = ['*']

    // Act & Assert
    expect(isSandboxed('LANG=x; git status $LANG')).toBe(false)
  })
})

describe('2.1.277 B7 — rule-compiler semantics (bare name = exact rule)', () => {
  test('bare excluded name matches only the bare command (exact rule)', () => {
    // Arrange — official compiler `BKt`/`GKt`: no `:*` suffix + no glob →
    // {type:'exact'}, so `git` does NOT match `git status`.
    mockedExcludedCommands = ['git']

    // Act & Assert
    expect(isSandboxed('git')).toBe(false)
    expect(isSandboxed('git status')).toBe(true)
  })

  test('`:*` pattern compiles to a prefix rule matching subcommands', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('git status')).toBe(false)
    expect(isSandboxed('git')).toBe(false)
  })
})

describe('2.1.277 B7 — base shouldUseSandbox behavior (regressions)', () => {
  test('single excluded command is exempted (unchanged)', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('git status')).toBe(false)
  })

  test('single non-matching command stays sandboxed', () => {
    // Arrange
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('rm -rf /')).toBe(true)
  })

  test('empty excludedCommands never exempts', () => {
    // Arrange
    mockedExcludedCommands = []

    // Act & Assert
    expect(isSandboxed('git status; git log')).toBe(true)
  })

  test('sandboxing disabled globally → no sandbox regardless of exclusions', () => {
    // Arrange
    sandboxingEnabled = false
    mockedExcludedCommands = ['git:*']

    // Act & Assert
    expect(isSandboxed('rm -rf /')).toBe(false)
  })

  test('dangerouslyDisableSandbox with policy allowed bypasses the sandbox', () => {
    // Arrange
    unsandboxedCommandsAllowed = true

    // Act & Assert
    expect(
      shouldUseSandbox({ command: 'rm -rf /', dangerouslyDisableSandbox: true }),
    ).toBe(false)
  })

  test('dangerouslyDisableSandbox is ignored when policy disallows unsandboxed commands', () => {
    // Arrange
    unsandboxedCommandsAllowed = false

    // Act & Assert
    expect(
      shouldUseSandbox({ command: 'rm -rf /', dangerouslyDisableSandbox: true }),
    ).toBe(true)
  })

  test('missing command → no sandbox decision', () => {
    // Act & Assert
    expect(shouldUseSandbox({})).toBe(false)
  })
})
