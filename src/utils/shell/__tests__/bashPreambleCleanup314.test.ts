import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * CC 2.1.314 #86 — "Bash tool shell clears inherited `which` alias/function
 * and stops passing exported `which`/`unsetenv` functions into the shell."
 *
 * Byte-verified official v314 mechanism (scratch-occ138/v314/package/claude):
 *  - Definitions @256154751 region:
 *    `function ZSn(e){return`{ \\builtin unalias -- '${e}'; \\builtin unset -f -- '${e}'; } >/dev/null 2>&1 || true`}`
 *    `function Jwr(){return ZSn("which")}` — the which cleanup (NEW in v314)
 *    `function eTr(){return ZSn("unsetenv")}` — the unsetenv cleanup (v312 had
 *    it as `xkr()`; OCC was missing BOTH)
 *  - Gate: `var ebn="tengu_swirling_koala"`.
 *  - Preamble call site @256158096 (byte-verified ordering):
 *    `let ht=Xwr(e);if(ht)Je.push(ht);if(bn(ebn,{safe:!0}))Je.push(Jwr());Je.push(eTr());let At=await ESn(De);if(At!==null)Je.push(At);...Je.push(`eval ${ze}`)`
 *    → extglob-disable → which (gated) → unsetenv (unconditional) → eval.
 *  - v312 baseline @251450577: `Qe.push(xkr())` — unsetenv only; no which
 *    cleanup and no `tengu_swirling_koala` anywhere (both v314-new).
 *  - Bonus alignment (in the same official `Xwr`, present in v312 AND v314 —
 *    string table @123278762 + code @256154400): the PREFIX and zsh extglob
 *    strings carry `NO_BARE_GLOB_QUAL`; OCC's getDisableExtglobCommand lacked
 *    it (pre-existing divergence, fixed in the same pass).
 *  - The third leg of #86 (BASH_FUNC_ env-key denial, `tbn` @256174458 with
 *    `Zwr=new Set(Qwr.flatMap(...))` over `BASH_FUNC_which%%` etc.) is
 *    consumed ONLY by the Windows SRT `wrapWithSandboxArgv` subsystem, which
 *    OCC does not have (documented deviation, Shell.ts:512-516) → N/A.
 */

const actualGrowthbookModule = await import(
  '../../../services/analytics/growthbook.js'
)
const actualGrowthbookExports = { ...actualGrowthbookModule }
const actualSessionEnvModule = await import('../../sessionEnvironment.js')
const actualSessionEnvExports = { ...actualSessionEnvModule }
const actualGrowthbookGate =
  actualGrowthbookExports.checkStatsigFeatureGate_CACHED_MAY_BE_STALE

let swirlingKoalaGate = false

mock.module('../../../services/analytics/growthbook.js', () => ({
  ...actualGrowthbookExports,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: (gate: string) =>
    gate === 'tengu_swirling_koala'
      ? swirlingKoalaGate
      : actualGrowthbookGate(gate),
}))
mock.module('../../sessionEnvironment.js', () => ({
  ...actualSessionEnvExports,
  getSessionEnvironmentScript: async () => '',
}))

afterAll(() => {
  mock.module('../../../services/analytics/growthbook.js', () => ({
    ...actualGrowthbookExports,
  }))
  mock.module('../../sessionEnvironment.js', () => ({
    ...actualSessionEnvExports,
  }))
})

const { createBashShellProvider } = await import('../bashProvider.js')

// Runtime strings produced by the official templates (source `\\builtin`
// renders as literal backslash + `builtin`).
const WHICH_CLEANUP =
  "{ \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true"
const UNSETENV_CLEANUP =
  "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"

let savedShellPrefix: string | undefined
beforeEach(() => {
  swirlingKoalaGate = false
  savedShellPrefix = process.env.CLAUDE_CODE_SHELL_PREFIX
  delete process.env.CLAUDE_CODE_SHELL_PREFIX
})
afterEach(() => {
  if (savedShellPrefix === undefined) {
    delete process.env.CLAUDE_CODE_SHELL_PREFIX
  } else {
    process.env.CLAUDE_CODE_SHELL_PREFIX = savedShellPrefix
  }
})

async function build(
  command: string,
  shellPath = '/bin/bash',
): Promise<string> {
  const provider = await createBashShellProvider(shellPath, {
    skipSnapshot: true,
  })
  const { commandString } = await provider.buildExecCommand(command, {
    id: '0001',
    useSandbox: false,
  })
  return commandString
}

describe('2.1.314 #86 — unsetenv cleanup (official eTr, unconditional)', () => {
  test('every built command clears an inherited unsetenv alias/function', async () => {
    // Act
    const commandString = await build('echo hi')

    // Assert — exact official ZSn("unsetenv") runtime string
    expect(commandString).toContain(UNSETENV_CLEANUP)
  })

  test('unsetenv cleanup is present with the which gate OFF', async () => {
    // Arrange
    swirlingKoalaGate = false

    // Act
    const commandString = await build('echo hi')

    // Assert
    expect(commandString).toContain(UNSETENV_CLEANUP)
    expect(commandString).not.toContain(WHICH_CLEANUP)
  })

  test('unsetenv cleanup runs BEFORE the eval of the user command', async () => {
    // Act
    const commandString = await build('echo hi')

    // Assert
    expect(commandString.indexOf(UNSETENV_CLEANUP)).toBeLessThan(
      commandString.lastIndexOf(' && eval '),
    )
  })
})

describe('2.1.314 #86 — which cleanup (official Jwr, gate tengu_swirling_koala)', () => {
  test('which cleanup is pushed when the gate is ON', async () => {
    // Arrange
    swirlingKoalaGate = true

    // Act
    const commandString = await build('echo hi')

    // Assert — exact official ZSn("which") runtime string
    expect(commandString).toContain(WHICH_CLEANUP)
  })

  test('which cleanup is absent when the gate is OFF', async () => {
    // Arrange
    swirlingKoalaGate = false

    // Act
    const commandString = await build('echo hi')

    // Assert
    expect(commandString).not.toContain(WHICH_CLEANUP)
  })

  test('official ordering: extglob → which → unsetenv → eval', async () => {
    // Arrange
    swirlingKoalaGate = true

    // Act
    const commandString = await build('echo hi')

    // Assert — v314 call site @256158096 ordering
    const extglobIdx = commandString.indexOf('shopt -u extglob')
    const whichIdx = commandString.indexOf(WHICH_CLEANUP)
    const unsetenvIdx = commandString.indexOf(UNSETENV_CLEANUP)
    const evalIdx = commandString.lastIndexOf(' && eval ')
    expect(extglobIdx).toBeGreaterThanOrEqual(0)
    expect(extglobIdx).toBeLessThan(whichIdx)
    expect(whichIdx).toBeLessThan(unsetenvIdx)
    expect(unsetenvIdx).toBeLessThan(evalIdx)
  })
})

describe('2.1.314 #86-adjacent — extglob strings carry NO_BARE_GLOB_QUAL (official Xwr)', () => {
  test('zsh shell gets setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL', async () => {
    // Act
    const commandString = await build('echo hi', '/bin/zsh')

    // Assert — official v314 Xwr zsh branch (byte-verified)
    expect(commandString).toContain(
      'setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true',
    )
  })

  test('CLAUDE_CODE_SHELL_PREFIX gets the combined bash+zsh form', async () => {
    // Arrange
    process.env.CLAUDE_CODE_SHELL_PREFIX = '/bin/sh'

    // Act
    const commandString = await build('echo hi')

    // Assert — official v314 Xwr PREFIX branch (byte-verified)
    expect(commandString).toContain(
      '{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true',
    )
  })

  test('bash shell keeps the unchanged shopt form', async () => {
    // Act
    const commandString = await build('echo hi', '/bin/bash')

    // Assert — official bash branch has no NO_BARE_GLOB_QUAL counterpart
    expect(commandString).toContain('shopt -u extglob 2>/dev/null || true')
  })
})
