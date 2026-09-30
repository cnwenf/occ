import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildInheritedEnvVars } from '../spawnUtils.js'

/**
 * CC 2.1.285 (item-B1): the WebFetch kill-switch is forwarded to tmux-spawned
 * teammates. The official `re[]` teammate-env list (@226996976) inserts
 * CLAUDE_CODE_DISABLE_WEB_FETCH immediately before ANTHROPIC_BASE_URL:
 *   `...[],"CLAUDE_CODE_DISABLE_WEB_FETCH","ANTHROPIC_BASE_URL",...`
 * Tmux may start a login shell that does not inherit the parent env, so a host
 * that disables WebFetch must forward the flag to keep it disabled inside
 * teammates. buildInheritedEnvVars emits `KEY=VALUE` for each var that is set
 * and non-empty.
 */

const ENV_KEY = 'CLAUDE_CODE_DISABLE_WEB_FETCH'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = saved
})

describe('CC 2.1.285 item-B1: teammate env forwarding of CLAUDE_CODE_DISABLE_WEB_FETCH', () => {
  test('set → forwarded as KEY=VALUE', () => {
    process.env[ENV_KEY] = '1'
    expect(buildInheritedEnvVars()).toContain('CLAUDE_CODE_DISABLE_WEB_FETCH=1')
  })

  test('set to "true" → forwarded verbatim', () => {
    process.env[ENV_KEY] = 'true'
    expect(buildInheritedEnvVars()).toContain(
      'CLAUDE_CODE_DISABLE_WEB_FETCH=true',
    )
  })

  test('unset → not forwarded', () => {
    delete process.env[ENV_KEY]
    expect(buildInheritedEnvVars()).not.toContain('CLAUDE_CODE_DISABLE_WEB_FETCH')
  })

  test('empty string → not forwarded (buildInheritedEnvVars skips empty)', () => {
    process.env[ENV_KEY] = ''
    expect(buildInheritedEnvVars()).not.toContain('CLAUDE_CODE_DISABLE_WEB_FETCH')
  })

  test('forwarded before ANTHROPIC_BASE_URL (official re[] adjacency)', () => {
    process.env[ENV_KEY] = '1'
    const out = buildInheritedEnvVars()
    // Only assert ordering when BASE_URL is present in this environment.
    if (out.includes('ANTHROPIC_BASE_URL=')) {
      expect(out.indexOf('CLAUDE_CODE_DISABLE_WEB_FETCH=')).toBeLessThan(
        out.indexOf('ANTHROPIC_BASE_URL='),
      )
    }
  })

  test('base teammate markers are always present', () => {
    const out = buildInheritedEnvVars()
    expect(out).toContain('CLAUDECODE=1')
    expect(out).toContain('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1')
  })
})
