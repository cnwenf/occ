import { describe, expect, test } from 'bun:test'
import { BashTool } from '../BashTool.js'
import { coerceBashInput } from '../coerceInput.js'

/**
 * CC 2.1.295 PORT #022 — Bash tool `command_description` / `timeout_ms`
 * input coercion. Verbatim port of the official v295 `fvn` (@219108012),
 * wired on the Bash tool def as a direct `coerceInput:fvn` reference
 * (@219165025 — NO `pH` schema-success gate, NO
 * `coerceInputBeforePluginHooks`). v294 shipped only the timeout_ms arm
 * (`cRn` @216611875); the `command_description` arm and the
 * delete-only-when-valid timeout_ms position are NEW in v295.
 *
 * Official fvn (byte-verified):
 *   function fvn(e){if(!L(e))return null;let n={...e},r=[];
 *     if("timeout_ms"in n&&!("timeout"in n)){let s=n.timeout_ms;
 *       if(typeof s==="number"||typeof s==="string"&&/^\d+$/.test(s))
 *         n.timeout=s,delete n.timeout_ms,r.push("timeout_ms")}
 *     if("command_description"in n){
 *       if(!("description"in n)&&typeof n.command_description==="string")
 *         n.description=n.command_description,r.push("command_description");
 *       else r.push("command_description_dropped");
 *       delete n.command_description}
 *     return r.length?{input:n,shapeClass:r.join(",")}:null}
 */

describe('2.1.295 #022 — command_description arm (NEW in v295)', () => {
  test('aliases command_description to description when description is absent', () => {
    // Arrange
    const raw = { command: 'ls', command_description: 'List files' }

    // Act
    const result = coerceBashInput(raw)

    // Assert
    expect(result).toEqual({
      input: { command: 'ls', description: 'List files' },
      shapeClass: 'command_description',
    })
  })

  test('drops command_description when description is already present (existing description wins)', () => {
    // Arrange
    const raw = {
      command: 'ls',
      description: 'Keep me',
      command_description: 'Ignore me',
    }

    // Act
    const result = coerceBashInput(raw)

    // Assert
    expect(result).toEqual({
      input: { command: 'ls', description: 'Keep me' },
      shapeClass: 'command_description_dropped',
    })
  })

  test('drops a non-string command_description with shapeClass command_description_dropped', () => {
    // Arrange — official arm requires `typeof … === "string"` to alias.
    const raw = { command: 'ls', command_description: 42 }

    // Act
    const result = coerceBashInput(raw)

    // Assert
    expect(result).toEqual({
      input: { command: 'ls' },
      shapeClass: 'command_description_dropped',
    })
  })

  test('always deletes the command_description key (strict schema never sees it)', () => {
    // Arrange
    const raw = { command: 'ls', command_description: 'List files' }

    // Act
    const result = coerceBashInput(raw)

    // Assert
    expect(result?.input).not.toHaveProperty('command_description')
  })
})

describe('2.1.295 #022 — timeout_ms arm (v294 cRn carryover, v295 delete position)', () => {
  test('aliases a numeric timeout_ms to timeout and deletes timeout_ms', () => {
    // Arrange
    const raw = { command: 'sleep 1', timeout_ms: 5000 }

    // Act
    const result = coerceBashInput(raw)

    // Assert
    expect(result).toEqual({
      input: { command: 'sleep 1', timeout: 5000 },
      shapeClass: 'timeout_ms',
    })
  })

  test('aliases a digits-only string timeout_ms (kept as string; semanticNumber coerces at parse)', () => {
    // Arrange — official accepts `typeof s==="string"&&/^\d+$/.test(s)`.
    const raw = { command: 'sleep 1', timeout_ms: '5000' }

    // Act
    const result = coerceBashInput(raw)

    // Assert
    expect(result).toEqual({
      input: { command: 'sleep 1', timeout: '5000' },
      shapeClass: 'timeout_ms',
    })
  })

  test('leaves an invalid-typed timeout_ms in the input and returns null (v295 delete-only-when-valid)', () => {
    // Arrange — v294 deleted an invalid timeout_ms unconditionally; v295
    // moved `delete n.timeout_ms` INSIDE the valid branch, so the strict
    // schema still rejects it.
    for (const invalid of ['soon', '1500.5', '-5', {}, null, true]) {
      const raw = { command: 'sleep 1', timeout_ms: invalid }

      // Act
      const result = coerceBashInput(raw)

      // Assert — no shapeClasses recorded → null, original untouched.
      expect(result).toBeNull()
      expect(raw).toHaveProperty('timeout_ms')
    }
  })

  test('ignores timeout_ms entirely when timeout is already present', () => {
    // Arrange — official guard `!("timeout"in n)`.
    const raw = { command: 'sleep 1', timeout: 1000, timeout_ms: 5000 }

    // Act
    const result = coerceBashInput(raw)

    // Assert — neither arm fires → null.
    expect(result).toBeNull()
  })
})

describe('2.1.295 #022 — combined arms and shapeClass join order', () => {
  test('both aliases fire with shapeClass "timeout_ms,command_description" (arm order = timeout first)', () => {
    // Arrange
    const raw = {
      command: 'sleep 1',
      timeout_ms: 2000,
      command_description: 'Sleep briefly',
    }

    // Act
    const result = coerceBashInput(raw)

    // Assert — official `r.join(",")` with the timeout arm pushing first.
    expect(result).toEqual({
      input: { command: 'sleep 1', timeout: 2000, description: 'Sleep briefly' },
      shapeClass: 'timeout_ms,command_description',
    })
  })

  test('valid timeout_ms plus dropped command_description joins as "timeout_ms,command_description_dropped"', () => {
    // Arrange
    const raw = {
      command: 'sleep 1',
      timeout_ms: 2000,
      description: 'Keep me',
      command_description: 'Ignore me',
    }

    // Act
    const result = coerceBashInput(raw)

    // Assert
    expect(result).toEqual({
      input: { command: 'sleep 1', timeout: 2000, description: 'Keep me' },
      shapeClass: 'timeout_ms,command_description_dropped',
    })
  })
})

describe('2.1.295 #022 — null paths (official `if(!L(e))return null` / `r.length`)', () => {
  test('clean input with canonical keys returns null', () => {
    // Arrange
    const raw = { command: 'ls', description: 'List files', timeout: 1000 }

    // Act/Assert
    expect(coerceBashInput(raw)).toBeNull()
  })

  test('non-object inputs return null (L(e) plain-object guard)', () => {
    for (const raw of ['ls', null, undefined, 42, ['ls'], true]) {
      expect(coerceBashInput(raw)).toBeNull()
    }
  })

  test('does not mutate the caller input object (official spreads `{...e}`)', () => {
    // Arrange
    const raw = { command: 'ls', command_description: 'List files' }
    const snapshot = { ...raw }

    // Act
    coerceBashInput(raw)

    // Assert
    expect(raw).toEqual(snapshot)
  })
})

describe('2.1.295 #022 — wiring on the Bash tool def (@219165025 coerceInput:fvn)', () => {
  test('BashTool exposes coerceInput without coerceInputBeforePluginHooks (Write-only flag)', () => {
    // Assert — official def: direct reference, no flag.
    expect(typeof BashTool.coerceInput).toBe('function')
    expect(BashTool.coerceInputBeforePluginHooks).toBeUndefined()
  })

  test('coerced command_description input passes the real strict Bash schema (was a hard failure pre-port)', () => {
    // Arrange — the exact #022 bug: model sends command_description instead
    // of description; z.strictObject rejects the unknown key.
    const raw = { command: 'ls', command_description: 'List files' }
    expect(BashTool.inputSchema.safeParse(raw).success).toBe(false)

    // Act — pipeline order per toolExecution.ts: coerce, then safeParse.
    const coerced = BashTool.coerceInput?.(raw)
    const parsed = BashTool.inputSchema.safeParse(
      coerced?.input as Record<string, unknown>,
    )

    // Assert
    expect(coerced?.shapeClass).toBe('command_description')
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.description).toBe('List files')
    }
  })

  test('coerced digits-string timeout_ms parses to a number via semanticNumber', () => {
    // Arrange
    const raw = { command: 'sleep 1', timeout_ms: '5000' }

    // Act
    const coerced = BashTool.coerceInput?.(raw)
    const parsed = BashTool.inputSchema.safeParse(
      coerced?.input as Record<string, unknown>,
    )

    // Assert
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.timeout).toBe(5000)
    }
  })
})
