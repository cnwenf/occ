import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  AUTO_MEMORY_RAISE_DENIED_DETAIL,
  isAutoMemoryRaiseAllowed,
  isToolStartedSession,
} from '../autoMemorySessionGate.js'

/**
 * CC 2.1.285 (security): "Changed /memory so that Auto-memory can no longer be
 * turned on from a background session or from a session one of Claude Code's
 * own tools started; turning it off there still works."
 *
 * Official v285 detection (decompiled ELF, `a` = process.env):
 *   RUe(){if(a.CLAUDE_CODE_CHILD_SESSION)return!0;
 *         if(!a.CLAUDECODE)return!1;
 *         return a.CLAUDE_CODE_SKIP_PROMPT_HISTORY||
 *                !process.stdin.isTTY&&!process.stdout.isTTY}
 *   EAe(){return!(a.CLAUDE_CODE_SESSION_KIND!==void 0||
 *                 fw()!==void 0)&&!RUe()}   // fw()=teammateAgentId
 *   RPe(){return EAe()}
 *   OVt="can't be turned on here; use a session started outside Claude Code"
 * The toggle handlers gate ON only (`if(h&&!RPe())return`), so turning the
 * setting OFF is never gated — pinned here via isAutoMemoryRaiseAllowed being
 * consulted only for the raise direction (handler code paths in
 * MemoryFileSelector.tsx check `newValue && !isAutoMemoryRaiseAllowed()`).
 */

const ENV_KEYS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDECODE',
  'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
  'CLAUDE_CODE_SESSION_KIND',
] as const

let savedEnv: Record<string, string | undefined> = {}
let savedStdinTTY: boolean | undefined
let savedStdoutTTY: boolean | undefined

function setTTY(stdin: boolean | undefined, stdout: boolean | undefined) {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: stdin,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(process.stdout, 'isTTY', {
    value: stdout,
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  savedStdinTTY = process.stdin.isTTY
  savedStdoutTTY = process.stdout.isTTY
  // Default harness state: a normal interactive session started outside CC.
  setTTY(true, true)
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setTTY(savedStdinTTY, savedStdoutTTY)
})

describe('isToolStartedSession (official RUe, CC 2.1.285)', () => {
  test('false for a plain session (no CLAUDECODE)', () => {
    expect(isToolStartedSession()).toBe(false)
  })

  test('true when CLAUDE_CODE_CHILD_SESSION is set', () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    expect(isToolStartedSession()).toBe(true)
  })

  test('true for CLAUDECODE with non-TTY stdin AND stdout (tool-spawned background)', () => {
    process.env.CLAUDECODE = '1'
    setTTY(false, false)
    expect(isToolStartedSession()).toBe(true)
  })

  test('false for CLAUDECODE with a TTY (interactive child shell)', () => {
    process.env.CLAUDECODE = '1'
    setTTY(true, true)
    expect(isToolStartedSession()).toBe(false)
  })

  test('false for CLAUDECODE with only one non-TTY stream', () => {
    process.env.CLAUDECODE = '1'
    setTTY(false, true)
    expect(isToolStartedSession()).toBe(false)
    setTTY(true, false)
    expect(isToolStartedSession()).toBe(false)
  })

  test('true for CLAUDECODE + CLAUDE_CODE_SKIP_PROMPT_HISTORY even with TTYs', () => {
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
    setTTY(true, true)
    expect(isToolStartedSession()).toBe(true)
  })
})

describe('isAutoMemoryRaiseAllowed (official EAe/RPe, CC 2.1.285)', () => {
  test('allowed in a normal session started outside Claude Code', () => {
    expect(isAutoMemoryRaiseAllowed()).toBe(true)
  })

  test('blocked in a background session (CLAUDE_CODE_SESSION_KIND set)', () => {
    process.env.CLAUDE_CODE_SESSION_KIND = 'daemon'
    expect(isAutoMemoryRaiseAllowed()).toBe(false)
  })

  test('blocked in a tool-started session (CLAUDECODE + non-TTY)', () => {
    process.env.CLAUDECODE = '1'
    setTTY(false, false)
    expect(isAutoMemoryRaiseAllowed()).toBe(false)
  })

  test('blocked for CLAUDE_CODE_CHILD_SESSION', () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1'
    expect(isAutoMemoryRaiseAllowed()).toBe(false)
  })
})

describe('OVt detail string (CC 2.1.285)', () => {
  test('matches the official byte-exact row detail', () => {
    expect(AUTO_MEMORY_RAISE_DENIED_DETAIL).toBe(
      "can't be turned on here; use a session started outside Claude Code",
    )
  })
})
