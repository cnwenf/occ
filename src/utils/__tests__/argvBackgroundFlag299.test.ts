import { describe, expect, test } from 'bun:test'
import {
  findArgIndex,
  hasArg,
  hasBackgroundFlag,
} from '../argvBackgroundFlag.js'

// Official Claude Code 2.1.299 (#111) — verbatim-ported argv position
// scanner. Changelog:
//   "Fixed `claude mcp add <name> -- <command> --background` being started
//    as a background session"
//   "Fixed a prompt or reply of `--bg` or `--background` to a background
//    session being taken for the flag, which could start new sessions over
//    and over instead of delivering it"

describe('hasBackgroundFlag — command-position only (2.1.299 #111)', () => {
  test('real argv flags in command position are detected', () => {
    expect(hasBackgroundFlag(['--bg'])).toBe(true)
    expect(hasBackgroundFlag(['--background'])).toBe(true)
    expect(hasBackgroundFlag(['--print', '--bg', '--model', 'x'])).toBe(true)
    expect(hasBackgroundFlag(['--resume', 'abc123', '--background'])).toBe(true)
  })

  test('flag after `--` terminator is message content, not the flag', () => {
    // changelog line 112: `claude mcp add <name> -- <command> --background`
    expect(
      hasBackgroundFlag(['mcp', 'add', 'srv', '--', 'claude', '--background']),
    ).toBe(false)
    expect(hasBackgroundFlag(['--', '--bg'])).toBe(false)
    expect(hasBackgroundFlag(['-p', 'do x', '--', '--bg'])).toBe(false)
  })

  test('reply content passed as a flag VALUE is not the flag', () => {
    // changelog line 113: a reply of "--bg"/"--background" delivered via
    // --exec/-m must be delivered as text, never taken for the flag.
    expect(hasBackgroundFlag(['--exec', '--background'])).toBe(false)
    expect(hasBackgroundFlag(['-m', '--bg'])).toBe(false)
    expect(hasBackgroundFlag(['--append-system-prompt', '--bg'])).toBe(false)
    expect(hasBackgroundFlag(['--model', '--background'])).toBe(false)
  })

  test('optional-value flag does NOT swallow a flag-like next token', () => {
    // `--resume` (official `d` set): next token looks like a flag → not a
    // value → scanning continues and the bg flag matches.
    expect(hasBackgroundFlag(['--resume', '--bg'])).toBe(true)
    expect(hasBackgroundFlag(['-r', 'session-id', '--background'])).toBe(true)
  })

  test('multi-value flags consume all non-flag-like values', () => {
    expect(hasBackgroundFlag(['--add-dir', 'a', 'b', '--bg'])).toBe(true)
    expect(hasBackgroundFlag(['--add-dir', 'a', 'b', '--', '--bg'])).toBe(
      false,
    )
  })

  test('no bg token at all → false', () => {
    expect(hasBackgroundFlag(['ps'])).toBe(false)
    expect(hasBackgroundFlag([])).toBe(false)
    expect(hasBackgroundFlag(['--print', 'hello'])).toBe(false)
  })
})

describe('hasArg / findArgIndex primitives', () => {
  test('findArgIndex returns the command-position index or -1', () => {
    expect(findArgIndex(t => t === '--bg', ['--print', '--bg'])).toBe(1)
    expect(findArgIndex(t => t === '--bg', ['--exec', '--bg'])).toBe(-1)
    expect(findArgIndex(t => t === '--bg', ['--', '--bg'])).toBe(-1)
  })

  test('hasArg matches exact tokens in command position', () => {
    expect(hasArg('--background', ['--background'])).toBe(true)
    expect(hasArg('--background', ['--bg'])).toBe(false)
    expect(hasArg('--bg', ['-m', '--bg'])).toBe(false)
  })
})
