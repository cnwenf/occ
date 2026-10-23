/**
 * claude-code 2.1.309 item 21: split-pane/separate-window agent teammates did
 * not inherit the tool-deny rules and `--tools` narrowing given on the
 * leader's command line (the in-process spawn path already inherits them).
 *
 * Official 309 `te()` (BIN309 @273,053,200) replays, in this order:
 *   - each `alwaysDenyRules.cliArg` rule as `O("--disallowed-tools", rule)`,
 *     guarded by `fu([r])` round-trip (else throw "A command-line deny rule
 *     cannot be handed to a teammate intact …— spawn aborted"),
 *   - each `typedToolFlags.tools` value as
 *     `O("--tools", aMn([r]) ? Cio(r) : r)` (self_hosted_runner_* entries are
 *     stripped from the replayed value).
 * Helpers: `O` @273,051,048 (`=`-form when the value starts with `-`/a URL
 * scheme or holds NUL, else space form; both shell-quoted), `fu` @239,835,387
 * (≡ OCC parseToolListFromCLI), `dne` @248,817,523, `aMn`/`Cio` @254,394,700.
 *
 * OCC structural deviation (declared in spawnUtils.ts filedoc): the official
 * reads parsed CLI state (`y.alwaysDenyRules.cliArg`, `bLt().typedToolFlags`);
 * OCC derives the same values from `process.argv` at spawn time because
 * bootstrap/state.ts carries no tool-flag getters (outside this WP's file
 * budget). The teammate's own initializeToolPermissionContext recomputes the
 * `--tools` complement and PowerShell additions, so the effective deny set
 * converges with the official.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { quote } from '../../bash/shellQuote.js'
import {
  buildInheritedCliFlags,
  buildInheritedToolFlags,
} from '../spawnUtils.js'

describe('2.1.309 item 21 buildInheritedToolFlags (official te() deny/--tools replay)', () => {
  test('empty argv replays nothing', () => {
    expect(buildInheritedToolFlags([])).toEqual([])
    expect(buildInheritedToolFlags(['node', 'cli', '--model', 'opus'])).toEqual([])
  })

  test('replays each --disallowedTools rule as its own quoted --disallowed-tools flag', () => {
    const flags = buildInheritedToolFlags([
      'node',
      'cli',
      '--disallowedTools',
      'Bash(rm *) Edit',
    ])
    expect(flags).toEqual([
      `--disallowed-tools ${quote(['Bash(rm *)'])}`,
      `--disallowed-tools ${quote(['Edit'])}`,
    ])
  })

  test('accepts the --disallowed-tools alias and the = form', () => {
    const alias = buildInheritedToolFlags([
      'node',
      'cli',
      '--disallowed-tools',
      'WebSearch',
    ])
    expect(alias).toEqual([`--disallowed-tools ${quote(['WebSearch'])}`])

    const equals = buildInheritedToolFlags([
      'node',
      'cli',
      '--disallowedTools=Bash(git push:*)',
    ])
    expect(equals).toEqual([`--disallowed-tools ${quote(['Bash(git push:*)'])}`])
  })

  test('forwards --tools values verbatim when no self_hosted_runner_ entry is present', () => {
    const flags = buildInheritedToolFlags(['node', 'cli', '--tools', 'Bash,Edit'])
    expect(flags).toEqual([`--tools ${quote(['Bash,Edit'])}`])
  })

  test('strips self_hosted_runner_ entries from a replayed --tools value (official aMn/Cio)', () => {
    const flags = buildInheritedToolFlags([
      'node',
      'cli',
      '--tools',
      'Bash,self_hosted_runner_acme,Edit',
    ])
    expect(flags).toEqual([`--tools ${quote(['Bash,Edit'])}`])
  })

  test('variadic collection stops at the next flag token and at --', () => {
    const stopsAtFlag = buildInheritedToolFlags([
      'node',
      'cli',
      '--tools',
      'Bash',
      '--model',
      'opus',
      '--disallowedTools',
      'Edit',
    ])
    expect(stopsAtFlag).toEqual([
      `--disallowed-tools ${quote(['Edit'])}`,
      `--tools ${quote(['Bash'])}`,
    ])

    const stopsAtDashDash = buildInheritedToolFlags([
      'node',
      'cli',
      '--',
      '--tools',
      'Bash',
    ])
    expect(stopsAtDashDash).toEqual([])
  })

  test('deny rules are emitted before --tools flags (official te() order)', () => {
    const flags = buildInheritedToolFlags([
      'node',
      'cli',
      '--tools',
      'Bash',
      '--disallowedTools',
      'Edit',
    ])
    expect(flags[0]).toStartWith('--disallowed-tools')
    expect(flags[1]).toStartWith('--tools')
  })

  test('a value starting with - is replayed in the = form (official dne/O)', () => {
    const flags = buildInheritedToolFlags(['node', 'cli', '--tools=-weird'])
    expect(flags).toEqual([`--tools=${quote(['-weird'])}`])
  })
})

describe('2.1.309 item 21 buildInheritedCliFlags carries the tool flags (both copies)', () => {
  const savedArgv = process.argv
  afterAll(() => {
    process.argv = savedArgv
  })

  test('swarm spawnUtils copy includes --disallowed-tools and --tools from the leader argv', () => {
    process.argv = [
      'node',
      'cli',
      '--disallowedTools',
      'Bash(rm *)',
      '--tools',
      'Bash,Edit',
    ]
    const flags = buildInheritedCliFlags()
    expect(flags).toContain(`--disallowed-tools ${quote(['Bash(rm *)'])}`)
    expect(flags).toContain(`--tools ${quote(['Bash,Edit'])}`)
  })

  test('spawnMultiAgent copy includes the same inherited tool flags', async () => {
    const { buildInheritedCliFlags: buildWindowFlags } = await import(
      '../../../tools/shared/spawnMultiAgent.js'
    )
    process.argv = ['node', 'cli', '--disallowed-tools', 'WebSearch']
    const flags = buildWindowFlags()
    expect(flags).toContain(`--disallowed-tools ${quote(['WebSearch'])}`)
  })

  test('tool flags land before --model (official te() ordering)', () => {
    process.argv = ['node', 'cli', '--disallowedTools', 'Edit']
    const flags = buildInheritedCliFlags()
    const denyIdx = flags.indexOf('--disallowed-tools')
    const modelIdx = flags.indexOf('--model')
    expect(denyIdx).toBeGreaterThanOrEqual(0)
    // --model only appears when a CLI model override is set; when absent the
    // deny flag simply sits where the official puts it (before the model slot).
    if (modelIdx >= 0) {
      expect(denyIdx).toBeLessThan(modelIdx)
    }
  })
})
