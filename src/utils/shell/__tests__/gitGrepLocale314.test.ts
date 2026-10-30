import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type {
  ParseForSecurityResult,
  SimpleCommand,
} from '../../bash/ast.js'
import type { Platform } from '../../platform.js'

/**
 * CC 2.1.314 #94 — "macOS: `git grep` in Claude-run commands uses the C
 * locale (regex memory-leak avoidance)."
 *
 * Byte-verified official v314 mechanism (scratch-occ138/v314/package/claude):
 *  - `ESn` @256139513 (async): gates `M()!=="macos"`, must contain both
 *    "git" and "grep", length<=1000, no `/[\u0080-\uFFFF]/`; parses via
 *    `EN`; requires kind "simple", `yst(...).ok`, zero bare assignments, no
 *    command with envVars; per command finds git via `w2o(s,!0,(S)=>S==="git")`,
 *    skips git global opts (`NKr` two-arg set), requires the subcommand
 *    `grep`; rejects when any grep arg matches
 *    `/^(?:--p|--op|--textc|-[A-Za-z0-9]*[OPf])/`; returns
 *    `{ ${_Vt(kwr)}; }`.
 *  - `TSn`/`kwr` @256139001: a `function git { ... }` wrapper that reroutes
 *    `git grep` through `'/usr/bin/env' LC_ALL=C 'git'` — installed only when
 *    git is not already a shell function/alias (`typeset -f`/`alias` guard).
 *  - Helpers @251810800 region: `XC`/`JC`/`Lh`/`ju` regexes, `QC`/`NKr`
 *    sets, `Fh` git-path predicate, `w2o` wrapper-aware argv scanner
 *    (noglob/nocorrect/builtin/command/exec/nohup/time/nice/env/timeout/
 *    gtimeout). `vSn`/`_Vt` single-quote escaping @256140xxx/@250532471.
 *  - v312 absence verified: `function git { 'local'` → 0 hits;
 *    `case"gtimeout"` → 0 hits (v314: 1 hit @251812249).
 *  - Preamble slot @256158096: pushed after `eTr()` (unsetenv cleanup),
 *    awaited with the NORMALIZED command (`De=LSn(L)`, the `2>nul`→
 *    `2>/dev/null` rewrite — OCC: normalizedCommand).
 *
 * darwin-only behavior — unit-tested as pure decision functions with the
 * platform mocked to 'macos' (host is linux), per the cluster test rules.
 */

const actualPlatformModule = await import('../../platform.js')
const actualPlatformExports = { ...actualPlatformModule }
const actualAstModule = await import('../../bash/ast.js')
const actualAstExports = { ...actualAstModule }
const actualParseForSecurity = actualAstExports.parseForSecurity

let platform: Platform = 'macos'
mock.module('../../platform.js', () => ({
  ...actualPlatformExports,
  getPlatform: () => platform,
}))

let parseOverride: ParseForSecurityResult | 'throw' | null = null
let parseCalls = 0
mock.module('../../bash/ast.js', () => ({
  ...actualAstExports,
  parseForSecurity: async (
    command: string,
    options?: Parameters<typeof actualParseForSecurity>[1],
  ) => {
    parseCalls += 1
    if (parseOverride === 'throw') {
      throw new Error('parse boom')
    }
    if (parseOverride !== null) {
      return parseOverride
    }
    return actualParseForSecurity(command, options)
  },
}))

afterAll(() => {
  mock.module('../../platform.js', () => ({ ...actualPlatformExports }))
  mock.module('../../bash/ast.js', () => ({ ...actualAstExports }))
})

const {
  GIT_GREP_WRAPPER_FUNCTION,
  GIT_GREP_WRAPPER_INSTALL_GUARD,
  GIT_GREP_LOCALE_COMMAND_LENGTH_LIMIT,
  buildGitGrepLocalePrefix,
  findWrappedCommandIndex,
} = await import('../gitGrepLocale.js')

// ---- Byte-exact official fixtures (v314 @256139001) ----

/** Official `vSn(e){return`'${e.replaceAll("'","'\\''")}'`}` */
function singleQuoteWrap(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`
}

/** Official `_Vt(e){return`'eval' '${e.replaceAll("'","'\\''")}' 2>/dev/null || 'true'`}` */
function evalGuard(s: string): string {
  return `'eval' ${singleQuoteWrap(s)} 2>/dev/null || 'true'`
}

const TSN_FIXTURE = [
  "function git { 'local' _cc_skip= _cc_word;",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell `${1+"$@"}` expansion in the byte-parity fixture, not a JS template placeholder.
  'for _cc_word in ${1+"$@"}; do',
  'if [ -n "$_cc_skip" ]; then _cc_skip=; continue; fi;',
  'case "$_cc_word" in',
  '-C|-c|--attr-source|--shallow-file|--git-dir|--separate-git-dir|--work-tree|--namespace|--super-prefix|--config-env) _cc_skip=1 ;;',
  '-*) ;;',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell `${1+"$@"}` expansion in the byte-parity fixture, not a JS template placeholder.
  "grep) '/usr/bin/env' LC_ALL=C 'git' ${1+\"$@\"}; 'return' ;;",
  '*) break ;;',
  'esac; done;',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell `${1+"$@"}` expansion in the byte-parity fixture, not a JS template placeholder.
  "'command' 'git' ${1+\"$@\"}; }",
].join(' ')

const KWR_FIXTURE = [
  "if ! 'typeset' -f 'git' >/dev/null 2>&1 && ! 'alias' 'git' >/dev/null 2>&1 &&",
  `( 'eval' ${singleQuoteWrap(TSN_FIXTURE)} ) >/dev/null 2>&1;`,
  `then 'eval' ${singleQuoteWrap(TSN_FIXTURE)}; fi`,
].join(' ')

const PREFIX_FIXTURE = `{ ${evalGuard(KWR_FIXTURE)}; }`

function simpleCommand(
  argv: string[],
  envVars: { name: string; value: string }[] = [],
): SimpleCommand {
  return {
    argv,
    envVars,
    redirects: [],
    text: argv.join(' '),
    hasUnquotedGlob: false,
  }
}

function simpleResult(
  commands: SimpleCommand[],
): ParseForSecurityResult {
  return { kind: 'simple', commands }
}

beforeEach(() => {
  platform = 'macos'
  parseOverride = null
  parseCalls = 0
})

describe('2.1.314 #94 — wrapper definition byte-parity (official TSn/kwr)', () => {
  test('git wrapper function matches the official TSn join byte-for-byte', () => {
    expect(GIT_GREP_WRAPPER_FUNCTION).toBe(TSN_FIXTURE)
  })

  test('install guard matches the official kwr join byte-for-byte', () => {
    expect(GIT_GREP_WRAPPER_INSTALL_GUARD).toBe(KWR_FIXTURE)
  })

  test('length limit is the official 1000', () => {
    expect(GIT_GREP_LOCALE_COMMAND_LENGTH_LIMIT).toBe(1000)
  })
})

describe('2.1.314 #94 — buildGitGrepLocalePrefix decision gates (official ESn)', () => {
  test('simple `git grep foo` on macOS gets the LC_ALL=C wrapper prefix', async () => {
    // Arrange
    parseOverride = simpleResult([simpleCommand(['git', 'grep', 'foo'])])

    // Act
    const prefix = await buildGitGrepLocalePrefix('git grep foo')

    // Assert — official return `{ ${_Vt(kwr)}; }`
    expect(prefix).toBe(PREFIX_FIXTURE)
  })

  test('non-macOS platform returns null without parsing', async () => {
    // Arrange
    platform = 'linux'

    // Act
    const prefix = await buildGitGrepLocalePrefix('git grep foo')

    // Assert
    expect(prefix).toBeNull()
    expect(parseCalls).toBe(0)
  })

  test('command without git/grep substrings short-circuits before parsing', async () => {
    // Act
    const prefix = await buildGitGrepLocalePrefix('echo hello')

    // Assert
    expect(prefix).toBeNull()
    expect(parseCalls).toBe(0)
  })

  test('command over 1000 chars short-circuits before parsing', async () => {
    // Arrange
    const long = `git grep ${'x'.repeat(1000)}`
    expect(long.length).toBeGreaterThan(1000)

    // Act
    const prefix = await buildGitGrepLocalePrefix(long)

    // Assert
    expect(prefix).toBeNull()
    expect(parseCalls).toBe(0)
  })

  test('non-ASCII command short-circuits before parsing', async () => {
    // Act
    const prefix = await buildGitGrepLocalePrefix('git grep café')

    // Assert — official /[\u0080-\uFFFF]/ gate
    expect(prefix).toBeNull()
    expect(parseCalls).toBe(0)
  })

  test('too-complex parse returns null', async () => {
    // Arrange
    parseOverride = { kind: 'too-complex', reason: 'process-substitution' }

    // Act & Assert
    expect(await buildGitGrepLocalePrefix('git grep <(echo x)')).toBeNull()
  })

  test('parse-unavailable returns null', async () => {
    // Arrange
    parseOverride = { kind: 'parse-unavailable' }

    // Act & Assert
    expect(await buildGitGrepLocalePrefix('git grep foo')).toBeNull()
  })

  test('parse rejection (throw) returns null, never propagates', async () => {
    // Arrange — official `await EN(e).catch(()=>{return})`
    parseOverride = 'throw'

    // Act & Assert
    expect(await buildGitGrepLocalePrefix('git grep foo')).toBeNull()
  })

  test('semantic-check failure returns null', async () => {
    // Arrange — real checkSemantics rejects the bogus-flag timeout wrapper
    parseOverride = simpleResult([
      simpleCommand(['git', 'grep', 'foo']),
      simpleCommand(['timeout', '--bogus', '5s', 'echo', 'x']),
    ])

    // Act & Assert
    expect(
      await buildGitGrepLocalePrefix('git grep foo && timeout --bogus 5s echo x'),
    ).toBeNull()
  })

  test('command with env-var prefixes returns null', async () => {
    // Arrange — official `n.commands.some(({envVars:s})=>s.length>0)`
    parseOverride = simpleResult([
      simpleCommand(['git', 'grep', 'foo'], [{ name: 'A', value: '1' }]),
    ])

    // Act & Assert
    expect(await buildGitGrepLocalePrefix('A=1 git grep foo')).toBeNull()
  })

  test('bare assignment (empty argv) returns null', async () => {
    // Arrange — OCC conservative equivalent of official bareAssignmentNames
    parseOverride = simpleResult([
      simpleCommand([], [{ name: 'FOO', value: 'bar' }]),
      simpleCommand(['git', 'grep', 'foo']),
    ])

    // Act & Assert
    expect(await buildGitGrepLocalePrefix('FOO=bar && git grep foo')).toBeNull()
  })

  test('bare assignment with no command word returns null', async () => {
    // Arrange
    parseOverride = simpleResult([simpleCommand(['FOO=bar'])])

    // Act & Assert
    expect(await buildGitGrepLocalePrefix('FOO=bar; git grep x')).toBeNull()
  })

  test('git without the grep subcommand returns null', async () => {
    // Arrange
    parseOverride = simpleResult([simpleCommand(['git', 'log'])])

    // Act & Assert — official `r.length===0` gate
    expect(await buildGitGrepLocalePrefix('git log')).toBeNull()
  })

  test('non-git command returns null', async () => {
    // Arrange — "grep" substring present so the fast path does not fire
    parseOverride = simpleResult([simpleCommand(['rg', 'grep', 'foo'])])

    // Act & Assert
    expect(await buildGitGrepLocalePrefix('rg grep foo')).toBeNull()
  })
})

describe('2.1.314 #94 — grep argument rejection regex (official ESn tail)', () => {
  const rejected: string[][] = [
    ['git', 'grep', '-P', 'foo'],
    ['git', 'grep', '--perl-regexp', 'foo'],
    ['git', 'grep', '--paginate'],
    ['git', 'grep', '--op', 'x'],
    ['git', 'grep', '--textconv', 'x'],
    ['git', 'grep', '-f', 'patterns.txt'],
    ['git', 'grep', '-O3'],
    ['git', 'grep', '-if', 'pat'],
  ]
  for (const argv of rejected) {
    test(`${argv.join(' ')} is rejected`, async () => {
      // Arrange
      parseOverride = simpleResult([simpleCommand(argv)])

      // Act & Assert — /^(?:--p|--op|--textc|-[A-Za-z0-9]*[OPf])/
      expect(await buildGitGrepLocalePrefix(argv.join(' '))).toBeNull()
    })
  }

  const accepted: string[][] = [
    ['git', 'grep', '-i', 'foo'],
    ['git', 'grep', '-n', 'foo', 'src/'],
    ['git', 'grep', '--line-number', 'foo'],
    ['git', '-C', '/tmp', 'grep', 'foo'],
    ['git', '-c', 'core.pager=cat', 'grep', 'foo'],
    ['git', '--git-dir=/x', 'grep', 'foo'],
    ['env', 'LC_ALL=x', 'git', 'grep', 'foo'],
    ['time', 'git', 'grep', 'foo'],
  ]
  for (const argv of accepted) {
    test(`${argv.join(' ')} gets the prefix`, async () => {
      // Arrange
      parseOverride = simpleResult([simpleCommand(argv)])

      // Act & Assert
      expect(await buildGitGrepLocalePrefix(argv.join(' '))).toBe(
        PREFIX_FIXTURE,
      )
    })
  }

  test('pipe: only the git-grep leg must qualify, others contribute nothing', async () => {
    // Arrange — official flatMap: non-git legs return []
    parseOverride = simpleResult([
      simpleCommand(['git', 'grep', 'foo']),
      simpleCommand(['head', '-1']),
    ])

    // Act & Assert
    expect(await buildGitGrepLocalePrefix('git grep foo | head -1')).toBe(
      PREFIX_FIXTURE,
    )
  })

  test('one rejected grep leg rejects the whole call', async () => {
    // Arrange
    parseOverride = simpleResult([
      simpleCommand(['git', 'grep', 'foo']),
      simpleCommand(['git', 'grep', '-P', 'bar']),
    ])

    // Act & Assert — official `r.flat().some(...)`
    expect(
      await buildGitGrepLocalePrefix('git grep foo && git grep -P bar'),
    ).toBeNull()
  })
})

describe('2.1.314 #94 — findWrappedCommandIndex (official w2o)', () => {
  const isGit = (word: string): boolean => word === 'git'

  test('bare command word', () => {
    expect(findWrappedCommandIndex(['git', 'grep'], true, isGit)).toBe(0)
  })

  test('leading assignments are skipped (official ju)', () => {
    expect(findWrappedCommandIndex(['FOO=1', 'git'], true, isGit)).toBe(1)
  })

  test('unknown wrapper returns -1', () => {
    expect(findWrappedCommandIndex(['sudo', 'git'], true, isGit)).toBe(-1)
  })

  test('non-match with notFoundIsMinusOne=false returns undefined', () => {
    expect(findWrappedCommandIndex(['env', 'A=1'], false, isGit)).toBeUndefined()
  })

  test('env wrapper skips -i and assignments', () => {
    expect(
      findWrappedCommandIndex(['env', '-i', 'A=1', 'git', 'grep'], true, isGit),
    ).toBe(3)
  })

  test('env wrapper with trailing flag returns -1', () => {
    expect(findWrappedCommandIndex(['env', '-bogus', 'git'], true, isGit)).toBe(
      -1,
    )
  })

  test('timeout wrapper parses duration forms (official JC)', () => {
    expect(
      findWrappedCommandIndex(['timeout', '5s', 'git', 'grep'], true, isGit),
    ).toBe(2)
    expect(
      findWrappedCommandIndex(
        ['timeout', '--preserve-status', '0.5', 'git'],
        true,
        isGit,
      ),
    ).toBe(3)
    expect(
      findWrappedCommandIndex(['gtimeout', '-k', '1', '2', 'git'], true, isGit),
    ).toBe(4)
  })

  test('timeout wrapper with bad flag returns -1', () => {
    expect(
      findWrappedCommandIndex(['timeout', '--bogus', '5', 'git'], true, isGit),
    ).toBe(-1)
  })

  test('nice wrapper parses -n adjustments (official XC)', () => {
    expect(
      findWrappedCommandIndex(['nice', '-n', '5', 'git'], true, isGit),
    ).toBe(3)
    expect(findWrappedCommandIndex(['nice', 'git'], true, isGit)).toBe(1)
  })

  test('exec wrapper skips -a name and -c (official Lh)', () => {
    expect(
      findWrappedCommandIndex(['exec', '-a', 'name', 'git'], true, isGit),
    ).toBe(3)
    expect(findWrappedCommandIndex(['exec', '-c', 'git'], true, isGit)).toBe(2)
    // '-aname' glued form: capture group non-empty → single-token skip
    expect(findWrappedCommandIndex(['exec', '-aname', 'git'], true, isGit)).toBe(
      2,
    )
  })

  test('command/builtin/noglob/nohup/time wrappers', () => {
    expect(findWrappedCommandIndex(['command', 'git'], true, isGit)).toBe(1)
    expect(findWrappedCommandIndex(['command', '-p', 'git'], true, isGit)).toBe(
      2,
    )
    expect(findWrappedCommandIndex(['builtin', 'git'], true, isGit)).toBe(-1)
    expect(
      findWrappedCommandIndex(['builtin', '/usr/bin/git'], true, isGit),
    ).toBe(-1)
    expect(findWrappedCommandIndex(['noglob', 'git'], true, isGit)).toBe(1)
    expect(findWrappedCommandIndex(['nohup', 'git'], true, isGit)).toBe(1)
    expect(findWrappedCommandIndex(['time', '-p', 'git'], true, isGit)).toBe(2)
  })

  test('absolute git path does NOT match the exact-equality predicate (official ESn uses S==="git"; Fh only guards the builtin branch)', () => {
    expect(
      findWrappedCommandIndex(['/usr/local/bin/git', 'grep'], true, isGit),
    ).toBe(-1)
    // Fh's role: `builtin /usr/bin/git` is rejected explicitly (-1), not
    // fallen through to the default branch
    expect(
      findWrappedCommandIndex(['builtin', '/usr/bin/git'], true, isGit),
    ).toBe(-1)
  })
})

describe('2.1.314 #94 — bashProvider wiring (official preamble slot)', () => {
  const UNSETENV_CLEANUP =
    "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"

  test('macOS git-grep command gets the prefix between unsetenv cleanup and eval', async () => {
    // Arrange
    parseOverride = simpleResult([simpleCommand(['git', 'grep', 'foo'])])
    const { createBashShellProvider } = await import('../bashProvider.js')
    const provider = await createBashShellProvider('/bin/bash', {
      skipSnapshot: true,
    })

    // Act
    const { commandString } = await provider.buildExecCommand('git grep foo', {
      id: '0001',
      useSandbox: false,
    })

    // Assert — official @256158096: eTr() → ESn(De) → eval
    expect(commandString).toContain(PREFIX_FIXTURE)
    expect(commandString.indexOf(UNSETENV_CLEANUP)).toBeLessThan(
      commandString.indexOf(PREFIX_FIXTURE),
    )
    expect(commandString.indexOf(PREFIX_FIXTURE)).toBeLessThan(
      commandString.lastIndexOf(' && eval '),
    )
  })

  test('non-macOS build omits the prefix', async () => {
    // Arrange
    platform = 'linux'
    parseOverride = simpleResult([simpleCommand(['git', 'grep', 'foo'])])
    const { createBashShellProvider } = await import('../bashProvider.js')
    const provider = await createBashShellProvider('/bin/bash', {
      skipSnapshot: true,
    })

    // Act
    const { commandString } = await provider.buildExecCommand('git grep foo', {
      id: '0001',
      useSandbox: false,
    })

    // Assert
    expect(commandString).not.toContain(PREFIX_FIXTURE)
  })
})
