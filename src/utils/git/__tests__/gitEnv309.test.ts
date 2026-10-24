/**
 * Official Claude Code 2.1.309 git-env hardening subsystem — changelog items
 * 10 (worktree/branch-checkout ignore replace refs) + 44 (C locale on git
 * spawns) + the shared internal builder the 2.1.285 hardening effort needs.
 *
 * Source of truth: BIN309 git-env module @240284681..240287300 (byte-verified
 * verbatim, never executed). Official symbols → OCC names:
 *   _n   → GIT_HOOKS_DISABLED_ARGS      (@240284681)
 *   oir  → GIT_LFS_SKIP_SMUDGE_ENV       (@240284911)
 *   jRe  → GIT_ALLOW_PROTOCOL_NONE = "/" (@240284946)
 *   d/p  → GIT_CONFIG_ALIAS_NEUTRALIZERS / GIT_CONFIG_PARAMETERS_BASE (@240284951)
 *   M    → GIT_HARDENED_ENV              (@240285063)
 *   b    → GIT_C_LOCALE_ENV              (@240285228)
 *   F    → GIT_SSH_DISABLED_ENV          (@240285269)
 *   vTt  → GIT_HARDENED_ARG_PREFIX       (@240285325)
 *   Cot/wZ/K → GIT_ENV_SCRUB_*           (@240285455)
 *   Ts   → buildHardenedGitEnv           (@240285945)
 *   air  → buildMergedGitEnv             (@240286082)
 *   E    → mergeAndScrubGitEnv (internal)
 *   Y    → applyGitAllowProtocol (internal)
 *   B    → sanitizeGitEnvPath (internal)
 *
 * 308→309 delta (item 10): `aor`→`air` — default-inject GIT_NO_REPLACE_OBJECTS
 * "1" and drop it from the merge scrub list (BIN309 @240286112, absent 308).
 */
import { describe, expect, test } from 'bun:test'
import { execFileNoThrowWithCwd } from '../../execFileNoThrow.js'
import {
  GIT_ALLOW_PROTOCOL_NONE,
  GIT_C_LOCALE_ENV,
  GIT_CONFIG_PARAMETERS_BASE,
  GIT_HARDENED_ARG_PREFIX,
  GIT_HARDENED_ENV,
  GIT_LFS_SKIP_SMUDGE_ENV,
  GIT_SSH_DISABLED_ENV,
  buildHardenedGitEnv,
  buildMergedGitEnv,
} from '../gitEnv.js'

describe('gitEnv frozen sets (official M/b/F/oir/_n/vTt)', () => {
  test('GIT_HARDENED_ENV (M) matches the official frozen set byte-for-byte', () => {
    expect(GIT_HARDENED_ENV).toEqual({
      GIT_ALLOW_PROTOCOL: '/',
      GIT_CONFIG_PARAMETERS: GIT_CONFIG_PARAMETERS_BASE,
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
    })
    expect(Object.isFrozen(GIT_HARDENED_ENV)).toBe(true)
  })

  test('GIT_CONFIG_PARAMETERS_BASE (p) is the alias-neutralizer join', () => {
    expect(GIT_CONFIG_PARAMETERS_BASE).toBe(
      "'alias.remote-none=version' 'alias.remote-none.command=version' " +
        "'alias.remote-/.command=version' 'fetch.bundleURI=' 'help.autocorrect=0'",
    )
  })

  test('locale (b), ssh-disable (F), lfs (oir), protocol-none (jRe) sets', () => {
    expect(GIT_C_LOCALE_ENV).toEqual({ LC_ALL: 'C', LANGUAGE: 'C' })
    expect(Object.isFrozen(GIT_C_LOCALE_ENV)).toBe(true)
    expect(GIT_SSH_DISABLED_ENV).toEqual({ GIT_SSH_COMMAND: 'false' })
    expect(Object.isFrozen(GIT_SSH_DISABLED_ENV)).toBe(true)
    expect(GIT_LFS_SKIP_SMUDGE_ENV).toEqual({ GIT_LFS_SKIP_SMUDGE: '1' })
    expect(GIT_ALLOW_PROTOCOL_NONE).toBe('/')
  })

  test('GIT_HARDENED_ARG_PREFIX (vTt) = hooks-off + bareRepository + file protocol', () => {
    expect(GIT_HARDENED_ARG_PREFIX).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=',
      '-c',
      'safe.bareRepository=explicit',
      '-c',
      'protocol.file.allow=never',
    ])
    expect(Object.isFrozen(GIT_HARDENED_ARG_PREFIX)).toBe(true)
  })
})

describe('buildHardenedGitEnv (official Ts)', () => {
  test('injects hardened set + C locale + ssh-disable by default', () => {
    const env = buildHardenedGitEnv(undefined, { base: {} })
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_ALLOW_PROTOCOL).toBe('/')
    expect(env.LC_ALL).toBe('C')
    expect(env.LANGUAGE).toBe('C')
    expect(env.GIT_SSH_COMMAND).toBe('false')
  })

  test('item 44: userLocale:true opts out of the C locale injection', () => {
    const env = buildHardenedGitEnv(undefined, { base: {}, userLocale: true })
    expect(env.LC_ALL).toBeUndefined()
    expect(env.LANGUAGE).toBeUndefined()
    // hardening still applies
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1')
  })

  test('ssh allowed → GIT_SSH_COMMAND:"false" is NOT injected', () => {
    const env = buildHardenedGitEnv(
      { GIT_ALLOW_PROTOCOL: 'ssh' },
      { base: {} },
    )
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
    expect(env.GIT_ALLOW_PROTOCOL).toBe('ssh')
    expect(env.GIT_CONFIG_PARAMETERS).toContain("'alias.remote-ssh=version'")
  })

  test('scrubs inherited git-redirect vars from base', () => {
    const env = buildHardenedGitEnv(undefined, {
      base: { GIT_DIR: '/inherited', GIT_CONFIG_GLOBAL: '/evil', HOME: '/ok' },
    })
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(env.HOME).toBe('/ok')
  })

  test('sanitizes PATH: keeps only absolute entries', () => {
    const env = buildHardenedGitEnv(undefined, {
      base: { PATH: '/usr/bin:relative:./bin:/bin' },
    })
    expect(env.PATH).toBe('/usr/bin:/bin')
  })

  test('sanitizes PATH: all-relative → /dev/null', () => {
    const env = buildHardenedGitEnv(undefined, {
      base: { PATH: 'relative:./bin' },
    })
    expect(env.PATH).toBe('/dev/null')
  })

  test('throws on a non-transport GIT_ALLOW_PROTOCOL token', () => {
    expect(() =>
      buildHardenedGitEnv({ GIT_ALLOW_PROTOCOL: 'ssh;rm -rf' }, { base: {} }),
    ).toThrow(
      'GIT_ALLOW_PROTOCOL may list only transport names made of letters, digits and "-"',
    )
  })
})

describe('buildMergedGitEnv (official air — 309 item 10 delta)', () => {
  test('default-injects GIT_NO_REPLACE_OBJECTS:"1"', () => {
    const env = buildMergedGitEnv({}, { base: {} })
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1')
  })

  test('caller can override GIT_NO_REPLACE_OBJECTS', () => {
    const env = buildMergedGitEnv({ GIT_NO_REPLACE_OBJECTS: '0' }, { base: {} })
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('0')
  })

  test('is lighter than Ts: no locale / ssh injection', () => {
    const env = buildMergedGitEnv({}, { base: {} })
    expect(env.LC_ALL).toBeUndefined()
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
    expect(env.GIT_ALLOW_PROTOCOL).toBeUndefined()
  })

  test('OCC deviation #4 (dataflow-02): defaults carry the alias-neutralizer base + terminal-prompt-off', () => {
    // The merged builder feeds the network sinks (worktree fetches, item-56
    // promisor pre-fetch); official `air` lacks these, OCC adds them as
    // declared security-positive hardening. GIT_ALLOW_PROTOCOL stays unset
    // ('/' would disable every transport and break the fetch sinks).
    const env = buildMergedGitEnv({}, { base: {} })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CONFIG_PARAMETERS).toBe(GIT_CONFIG_PARAMETERS_BASE)
  })

  test('OCC deviation #4: caller overrides win over the hardening defaults', () => {
    const env = buildMergedGitEnv(
      { GIT_TERMINAL_PROMPT: '1', GIT_CONFIG_PARAMETERS: "'custom.key=v'" },
      { base: {} },
    )
    expect(env.GIT_TERMINAL_PROMPT).toBe('1')
    expect(env.GIT_CONFIG_PARAMETERS).toBe("'custom.key=v'")
  })

  test('OCC deviation #4: ambient GIT_CONFIG_PARAMETERS / GIT_TERMINAL_PROMPT in base are replaced, not merged', () => {
    // A hostile ambient env must not be able to prepend its own alias config.
    const env = buildMergedGitEnv(
      {},
      {
        base: {
          GIT_CONFIG_PARAMETERS: "'alias.remote-none=/evil'",
          GIT_TERMINAL_PROMPT: '1',
        },
      },
    )
    expect(env.GIT_CONFIG_PARAMETERS).toBe(GIT_CONFIG_PARAMETERS_BASE)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  test('OCC deviation #4: caller GIT_ALLOW_PROTOCOL rebuild keeps the neutralizers (base treated as empty by Y)', () => {
    // lazyFetchEnv inForce overlay: GIT_ALLOW_PROTOCOL:'/' + the defaults —
    // Y must not duplicate the base neutralizers into the rebuilt value.
    const env = buildMergedGitEnv(
      { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '/' },
      { base: {} },
    )
    expect(env.GIT_CONFIG_PARAMETERS).toBe(GIT_CONFIG_PARAMETERS_BASE)
    expect(env.GIT_ALLOW_PROTOCOL).toBe('/')
  })

  test('scrubs GIT_LFS_SKIP_SMUDGE / GIT_NO_LAZY_FETCH to undefined when absent', () => {
    const env = buildMergedGitEnv({}, { base: {} })
    expect('GIT_LFS_SKIP_SMUDGE' in env).toBe(true)
    expect(env.GIT_LFS_SKIP_SMUDGE).toBeUndefined()
    expect('GIT_NO_LAZY_FETCH' in env).toBe(true)
    expect(env.GIT_NO_LAZY_FETCH).toBeUndefined()
  })

  test('keeps GIT_NO_LAZY_FETCH when explicitly provided (item 56 pre-fetch off)', () => {
    const env = buildMergedGitEnv(
      { LC_ALL: 'C', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '/' },
      { base: {} },
    )
    expect(env.GIT_NO_LAZY_FETCH).toBe('1')
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1')
  })

  test('scrubs inherited GIT_DIR / GIT_CONFIG_* from base', () => {
    const env = buildMergedGitEnv(
      {},
      { base: { GIT_DIR: '/inherited', GIT_CONFIG_COUNT: '1' } },
    )
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
  })
})

/**
 * Integration: prove the execFileNoThrow `gitEnv` opt-in actually routes the
 * child env through buildMergedGitEnv (official `WNt`/`jKs`→`air`). Real
 * `/bin/sh` spawns, matching execFileNoThrowDetached285.test.ts conventions.
 */
describe('execFileNoThrow gitEnv opt-in wiring', () => {
  const withGitDir = async (
    value: string,
    run: () => Promise<{ stdout: string; code: number }>,
  ): Promise<{ stdout: string; code: number }> => {
    const prev = process.env.GIT_DIR
    process.env.GIT_DIR = value
    try {
      return await run()
    } finally {
      if (prev === undefined) {
        delete process.env.GIT_DIR
      } else {
        process.env.GIT_DIR = prev
      }
    }
  }

  test('gitEnv:true default-injects GIT_NO_REPLACE_OBJECTS=1 into the child (item 10)', async () => {
    const r = await execFileNoThrowWithCwd(
      '/bin/sh',
      ['-c', 'printenv GIT_NO_REPLACE_OBJECTS'],
      { gitEnv: true, timeout: 5000 },
    )
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('1')
  })

  test('gitEnv:true scrubs an inherited GIT_DIR from the child', async () => {
    const r = await withGitDir('/inherited-should-be-scrubbed', () =>
      execFileNoThrowWithCwd('/bin/sh', ['-c', 'printenv GIT_DIR'], {
        gitEnv: true,
        timeout: 5000,
      }),
    )
    // printenv exits 1 and prints nothing when the var is unset (scrubbed).
    expect(r.stdout.trim()).toBe('')
  })

  test('gitEnv:true injects the OCC neutralizer base + prompt-off into the child (deviation #4)', async () => {
    const params = await execFileNoThrowWithCwd(
      '/bin/sh',
      ['-c', 'printenv GIT_CONFIG_PARAMETERS'],
      { gitEnv: true, timeout: 5000 },
    )
    expect(params.code).toBe(0)
    expect(params.stdout.trim()).toBe(GIT_CONFIG_PARAMETERS_BASE)
    const prompt = await execFileNoThrowWithCwd(
      '/bin/sh',
      ['-c', 'printenv GIT_TERMINAL_PROMPT'],
      { gitEnv: true, timeout: 5000 },
    )
    expect(prompt.code).toBe(0)
    expect(prompt.stdout.trim()).toBe('0')
  })

  test('gitEnv absent → generic exec passes the inherited env through', async () => {
    const r = await withGitDir('/passes-through', () =>
      execFileNoThrowWithCwd('/bin/sh', ['-c', 'printenv GIT_DIR'], {
        timeout: 5000,
      }),
    )
    expect(r.stdout.trim()).toBe('/passes-through')
  })

  test('gitEnv merges a minimal LC_ALL override (item 44 locale)', async () => {
    const r = await execFileNoThrowWithCwd(
      '/bin/sh',
      ['-c', 'printenv LC_ALL'],
      { env: { LC_ALL: 'C' }, gitEnv: true, timeout: 5000 },
    )
    expect(r.stdout.trim()).toBe('C')
  })
})
