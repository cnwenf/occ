import { describe, expect, test } from 'bun:test'
import { BashTool, coerceBashInput } from '../BashTool.js'

/**
 * Official Claude Code v2.1.295 item #022 — "Fixed Bash tool calls failing
 * when model passes `command_description` instead of `description`."
 *
 * Byte-verified against the v295 linux-x64 ELF:
 *
 * - @219107781 `fvn(e)` — the coercion function ported here as
 *   `coerceBashInput` (dump @219107800):
 *   `function fvn(e){if(!L(e))return null;let n={...e},r=[];
 *    if("timeout_ms"in n&&!("timeout"in n)){let s=n.timeout_ms;
 *      if(typeof s==="number"||typeof s==="string"&&/^\d+$/.test(s))
 *        n.timeout=s,delete n.timeout_ms,r.push("timeout_ms")}
 *    if("command_description"in n){
 *      if(!("description"in n)&&typeof n.command_description==="string")
 *        n.description=n.command_description,r.push("command_description");
 *      else r.push("command_description_dropped");
 *      delete n.command_description}
 *    return r.length?{input:n,shapeClass:r.join(",")}:null}`
 * - @219165025 Bash def wiring: `coerceInput:fvn` — DIRECT, no `mU` safeParse
 *   gate (contrast the Grep def @215622816 `coerceInput(e){return mU(dCt(),lCt(e))}`).
 * - 294→295 delta: s294's equivalent `cRn` had ONLY the timeout_ms branch;
 *   `command_description` has 0 string-dump hits in s294 vs 3 in s295
 *   (`command_description` @99517632, `command_description_dropped` @99517660,
 *   code cluster @219108012-219108221).
 * - `L`=isRecord. The same-named `fvn` @219672245 is an unrelated
 *   native-installer helper (`claude.exe` name chooser).
 */

describe('2.1.295 #022 — coerceBashInput (binary fvn @219107781)', () => {
  test('aliases command_description → description when description is absent', () => {
    // Arrange
    const input = { command: 'ls', command_description: 'List files' }

    // Act
    const repair = coerceBashInput(input)

    // Assert
    expect(repair).not.toBeNull()
    expect(repair?.input).toEqual({ command: 'ls', description: 'List files' })
    expect(repair?.shapeClass).toBe('command_description')
    // no resultNote on the official Bash coercion (contrast Grep's lCt)
    expect(repair && 'resultNote' in repair).toBe(false)
  })

  test('drops command_description (shapeClass command_description_dropped) when description already present', () => {
    // Arrange
    const input = {
      command: 'ls',
      description: 'List files',
      command_description: 'ignored alias',
    }

    // Act
    const repair = coerceBashInput(input)

    // Assert — binary: else-branch pushes `command_description_dropped` and
    // unconditionally deletes the stray key; the real description survives.
    expect(repair?.input).toEqual({ command: 'ls', description: 'List files' })
    expect(repair?.shapeClass).toBe('command_description_dropped')
  })

  test('drops a non-string command_description', () => {
    // Arrange
    const input = { command: 'ls', command_description: 42 }

    // Act
    const repair = coerceBashInput(input)

    // Assert
    expect(repair?.input).toEqual({ command: 'ls' })
    expect(repair?.shapeClass).toBe('command_description_dropped')
  })

  test('maps timeout_ms → timeout for numbers and digit-strings (value copied raw)', () => {
    // Arrange / Act
    const numeric = coerceBashInput({ command: 'sleep 1', timeout_ms: 5000 })
    const stringy = coerceBashInput({ command: 'sleep 1', timeout_ms: '5000' })

    // Assert — binary `n.timeout=s` keeps the raw value; the schema's
    // semanticNumber accepts the digit-string at parse time.
    expect(numeric?.input).toEqual({ command: 'sleep 1', timeout: 5000 })
    expect(numeric?.shapeClass).toBe('timeout_ms')
    expect(stringy?.input).toEqual({ command: 'sleep 1', timeout: '5000' })
    expect(stringy?.shapeClass).toBe('timeout_ms')
  })

  test('leaves timeout_ms alone when timeout is already present', () => {
    // Arrange — binary guard: `"timeout_ms"in n&&!("timeout"in n)`
    const input = { command: 'sleep 1', timeout: 1000, timeout_ms: 5000 }

    // Act
    const repair = coerceBashInput(input)

    // Assert — no repair recorded at all → null (r.length===0)
    expect(repair).toBeNull()
  })

  test('leaves a non-digit-string timeout_ms alone', () => {
    // Arrange
    const input = { command: 'sleep 1', timeout_ms: '5s' }

    // Act
    const repair = coerceBashInput(input)

    // Assert
    expect(repair).toBeNull()
  })

  test('joins shapeClasses in binary order (timeout_ms first) when both repairs fire', () => {
    // Arrange
    const input = {
      command: 'sleep 1',
      timeout_ms: '100',
      command_description: 'Sleep one second',
    }

    // Act
    const repair = coerceBashInput(input)

    // Assert
    expect(repair?.input).toEqual({
      command: 'sleep 1',
      timeout: '100',
      description: 'Sleep one second',
    })
    expect(repair?.shapeClass).toBe('timeout_ms,command_description')
  })

  test('returns null for clean input and non-record input', () => {
    // Arrange / Act / Assert
    expect(coerceBashInput({ command: 'ls' })).toBeNull()
    expect(coerceBashInput(null)).toBeNull()
    expect(coerceBashInput('ls')).toBeNull()
    expect(coerceBashInput([{ command: 'ls' }])).toBeNull()
  })

  test('never mutates the caller object (immutable copy semantics)', () => {
    // Arrange
    const input: Record<string, unknown> = {
      command: 'ls',
      command_description: 'List files',
    }

    // Act
    const repair = coerceBashInput(input)

    // Assert
    expect(input).toEqual({ command: 'ls', command_description: 'List files' })
    expect(repair?.input).not.toBe(input)
  })

  test('BashTool def wires coerceInput directly (official `coerceInput:fvn`, no gate)', () => {
    // Arrange / Act
    const repair = BashTool.coerceInput?.({
      command: 'ls',
      command_description: 'List files',
    })

    // Assert
    expect(repair?.shapeClass).toBe('command_description')
    // The repaired input passes the model-facing strict schema (this is what
    // makes the official no-gate wiring safe: parse validates afterwards).
    expect(BashTool.inputSchema.safeParse(repair?.input).success).toBe(true)
  })

  test('end-to-end: a command_description-only call now parses instead of bouncing strictObject', () => {
    // Arrange — pre-295 this input failed strict validation (unknown key).
    const rawInput = {
      command: 'git status',
      command_description: 'Show working tree status',
    }
    expect(BashTool.inputSchema.safeParse(rawInput).success).toBe(false)

    // Act
    const repair = BashTool.coerceInput?.(rawInput)
    const parsed = BashTool.inputSchema.safeParse(repair?.input ?? rawInput)

    // Assert
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.description).toBe('Show working tree status')
    }
  })
})
