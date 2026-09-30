import { describe, expect, test } from 'bun:test'
import { getPlatform } from '../platform.js'
import {
  canOpenControllingTerminal,
  resolveFetchSshFailFast,
} from '../gitFetchSshFailFast.js'

/**
 * 2.1.285 upstream port (changelog item 3): "SSH passphrase and new-host
 * prompts from worktree and /teleport fetches" — the fetches stop quickly
 * instead of seizing the terminal.
 *
 * Every assertion below is byte-derived from the official v285 `D0`
 * (@204089380 in the linux ELF):
 *   async function D0(e){let n=Kvo(Zjt(),e),r=await Azo(n,...),
 *     s=r.SSH_ASKPASS_REQUIRE?.trim();
 *     return{env:Boolean(s)||O()==="windows"||!await Xen()?r:
 *       {...r,SSH_ASKPASS_REQUIRE:"never",SSH_ASKPASS:"false"},
 *       withoutControllingTerminal:!0}}
 *
 * We assert ONLY official behavior — no invented caps or fallbacks. These
 * tests exercise the POSIX branch (getPlatform()!=='windows'), matching the
 * CI target; the Windows-only `Azo` ssh-config resolution is identity here.
 */

const POSIX = getPlatform() !== 'windows'

describe('canOpenControllingTerminal (official Xen)', () => {
  test('returns a boolean without throwing', async () => {
    // Official Xen: open("/dev/tty", O_RDWR|O_NOCTTY) → close → true; any
    // error (no controlling terminal, non-POSIX) → false. We only assert the
    // contract (a boolean), not the environment-dependent value.
    const result = await canOpenControllingTerminal()
    expect(typeof result).toBe('boolean')
  })
})

describe('resolveFetchSshFailFast (official D0) — POSIX', () => {
  const cwd = '/tmp'

  test('no user SSH_ASKPASS_REQUIRE + controlling terminal → pins never/false', async () => {
    if (!POSIX) return
    const baseEnv = { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' }
    const { env, withoutControllingTerminal } = await resolveFetchSshFailFast(
      baseEnv,
      cwd,
      async () => true, // probe: a controlling terminal exists
    )
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never')
    expect(env.SSH_ASKPASS).toBe('false')
    expect(withoutControllingTerminal).toBe(true)
    // base env is preserved
    expect(env.PATH).toBe('/usr/bin')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    // does not mutate the caller's object (immutability)
    expect(baseEnv.SSH_ASKPASS_REQUIRE).toBeUndefined()
    expect(baseEnv.SSH_ASKPASS).toBeUndefined()
  })

  test('a user-set SSH_ASKPASS_REQUIRE is honored (env kept as-is)', async () => {
    if (!POSIX) return
    // Official: `Boolean(s)` short-circuits the pin when the user set
    // SSH_ASKPASS_REQUIRE (non-blank after trim).
    const baseEnv = { SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: '/my/askpass' }
    const { env, withoutControllingTerminal } = await resolveFetchSshFailFast(
      baseEnv,
      cwd,
      async () => true,
    )
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force')
    expect(env.SSH_ASKPASS).toBe('/my/askpass')
    // withoutControllingTerminal is unconditional in the official D0.
    expect(withoutControllingTerminal).toBe(true)
  })

  test('a blank SSH_ASKPASS_REQUIRE does NOT count as user-set', async () => {
    if (!POSIX) return
    // Official trims: `s=r.SSH_ASKPASS_REQUIRE?.trim()` then `Boolean(s)`.
    const baseEnv = { SSH_ASKPASS_REQUIRE: '   ' }
    const { env } = await resolveFetchSshFailFast(baseEnv, cwd, async () => true)
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never')
    expect(env.SSH_ASKPASS).toBe('false')
  })

  test('no controlling terminal → env kept as-is (no pin)', async () => {
    if (!POSIX) return
    // Official: `!await Xen()` short-circuits — with no controlling terminal
    // there is nothing to seize, so the pins are not applied.
    const baseEnv = { PATH: '/usr/bin' }
    const { env, withoutControllingTerminal } = await resolveFetchSshFailFast(
      baseEnv,
      cwd,
      async () => false,
    )
    expect(env.SSH_ASKPASS_REQUIRE).toBeUndefined()
    expect(env.SSH_ASKPASS).toBeUndefined()
    expect(withoutControllingTerminal).toBe(true)
  })

  test('withoutControllingTerminal is always true regardless of branch', async () => {
    if (!POSIX) return
    for (const probe of [async () => true, async () => false]) {
      const { withoutControllingTerminal } = await resolveFetchSshFailFast(
        {},
        cwd,
        probe,
      )
      expect(withoutControllingTerminal).toBe(true)
    }
  })
})
