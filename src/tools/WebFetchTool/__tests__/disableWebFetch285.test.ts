import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// WebFetchTool transitively pulls in the fetch path which reads MACRO.VERSION
// (a build-time constant polyfilled in cli.tsx). Mirror that polyfill so the
// module imports cleanly under `bun test`.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.285 (item-B1): CLAUDE_CODE_DISABLE_WEB_FETCH kill-switch on
 * WebFetchTool.isEnabled.
 *
 * Official v285 `isEnabled(){return!a.CLAUDE_CODE_DISABLE_WEB_FETCH&&Yt(wye)}`
 * (@204286795) added the env gate that v284 lacked (0 hits for the var in v284,
 * 9 in v285). `Yt(wye)` is the official `allow_web_fetch` managed-policy check;
 * OCC has no counterpart policy surface, so only the env kill-switch is ported.
 * When truthy, the tool is removed from the tool list entirely.
 */

const { WebFetchTool } = await import('../WebFetchTool.js')

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

describe('CC 2.1.285 item-B1: WebFetchTool.isEnabled honors CLAUDE_CODE_DISABLE_WEB_FETCH', () => {
  test('env unset → enabled (prior v284 behavior preserved)', () => {
    delete process.env[ENV_KEY]
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('env="1" → disabled', () => {
    process.env[ENV_KEY] = '1'
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('env="true" → disabled', () => {
    process.env[ENV_KEY] = 'true'
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('env="yes" → disabled (isEnvTruthy alias)', () => {
    process.env[ENV_KEY] = 'yes'
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('env="on" → disabled (isEnvTruthy alias)', () => {
    process.env[ENV_KEY] = 'on'
    expect(WebFetchTool.isEnabled()).toBe(false)
  })

  test('env="0" → enabled (falsy value does not disable)', () => {
    process.env[ENV_KEY] = '0'
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('env="" → enabled (empty string is falsy)', () => {
    process.env[ENV_KEY] = ''
    expect(WebFetchTool.isEnabled()).toBe(true)
  })

  test('env="false" → enabled (non-truthy string)', () => {
    process.env[ENV_KEY] = 'false'
    expect(WebFetchTool.isEnabled()).toBe(true)
  })
})
