import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type AutoModeDenial,
  _resetDenialsForTesting,
  denialInputKey,
  getAutoModeDenials,
  recordAutoModeDenial,
  removeAutoModeDenial,
} from '../autoModeDenials.js'

/**
 * CC 2.1.307 PORT B6 — "/permissions Recently-denied rows show the command;
 * approvals name the command".
 *
 * Binary evidence (official v307 linux-x64 ELF, text dump new307.txt
 * @12632300–12636800 — the canUseTool record site):
 *
 * - Denial record gains `command` (shell family, non-mcp, non-blank only)
 *   and `inputKey`:
 *   `h({toolName:Be.name,display:io,...typeof Ao==="string"&&Ao.trim()!==""
 *   &&{command:Ao},inputKey:uee(Be,Ke),reason:xo,timestamp:Date.now()})`
 *   with `Ao=Be.mcpInfo?void 0:uh.includes(Be.name)?Ke.command:void 0`
 *   (`uh` = the shell-family tool-name list, ["Bash","PowerShell"]).
 * - `uee` (inputKey canonicalizer):
 *   `function uee(h,x){if(uh.includes(h.name)&&!h.mcpInfo)return _({command:
 *   x.command});return _(x)}` — `_` = JSON.stringify.
 * - Prior-denial dedup lookup (fixes "auto-mode local classifier ignoring an
 *   approval on retried command"):
 *   `let Pt;let bt=x();if(bt.length>0){let xt=uee(Be,Ke);Pt=bt.find((Mt)=>
 *   Mt.toolName===Be.name&&Mt.inputKey===xt)}` and on later allow:
 *   `L(Eo)` — removal by IDENTITY of the found denial object.
 */

function makeDenial(overrides: Partial<AutoModeDenial> = {}): AutoModeDenial {
  return {
    toolName: 'Bash',
    display: 'rm -rf build',
    reason: 'dangerous removal',
    timestamp: 1,
    ...overrides,
  }
}

beforeEach(() => {
  _resetDenialsForTesting()
})

describe('CC 2.1.307 B6: denial store carries command + inputKey', () => {
  test('records command and inputKey alongside display', () => {
    // Arrange / Act
    recordAutoModeDenial(
      makeDenial({
        command: 'rm -rf build',
        inputKey: '{"command":"rm -rf build"}',
      }),
    )

    // Assert
    const denials = getAutoModeDenials()
    expect(denials.length).toBe(1)
    expect(denials[0]?.command).toBe('rm -rf build')
    expect(denials[0]?.inputKey).toBe('{"command":"rm -rf build"}')
  })

  test('denials recorded without a command keep command undefined', () => {
    // Arrange / Act — e.g. non-shell tools record no command (official `Ao`
    // is void 0 for non-shell-family / mcp tools).
    recordAutoModeDenial(makeDenial({ toolName: 'Read' }))

    // Assert
    expect(getAutoModeDenials()[0]?.command).toBeUndefined()
  })
})

describe('CC 2.1.307 B6: removeAutoModeDenial (official `L`)', () => {
  test('removes the identical denial object, preserving the rest in order', () => {
    // Arrange
    recordAutoModeDenial(makeDenial({ display: 'first' }))
    recordAutoModeDenial(makeDenial({ display: 'second' }))
    recordAutoModeDenial(makeDenial({ display: 'third' }))
    const stored = getAutoModeDenials()
    // newest-first: third, second, first
    const target = stored[1]
    expect(target?.display).toBe('second')

    // Act — official passes the found object itself (`L(Eo)`).
    removeAutoModeDenial(target as AutoModeDenial)

    // Assert
    expect(getAutoModeDenials().map(d => d.display)).toEqual([
      'third',
      'first',
    ])
  })

  test('does not remove a structurally-equal but non-identical object', () => {
    // Arrange — identity semantics (official `DENIALS.filter(d => d !== Eo)`
    // equivalent), NOT deep equality.
    recordAutoModeDenial(makeDenial({ display: 'kept' }))

    // Act
    removeAutoModeDenial(makeDenial({ display: 'kept' }))

    // Assert
    expect(getAutoModeDenials().length).toBe(1)
  })
})

describe('CC 2.1.307 B6: denialInputKey (official `uee`)', () => {
  test('Bash (non-mcp) canonicalizes to {"command":...} only', () => {
    // Arrange / Act / Assert — official `_({command:x.command})`.
    expect(
      denialInputKey(
        { name: 'Bash' },
        { command: 'ls -la', description: 'ignored' },
      ),
    ).toBe('{"command":"ls -la"}')
  })

  test('PowerShell (non-mcp) canonicalizes to {"command":...} only', () => {
    expect(
      denialInputKey({ name: 'PowerShell' }, { command: 'Get-Process' }),
    ).toBe('{"command":"Get-Process"}')
  })

  test('shell-family tool WITH mcpInfo falls back to the full input JSON', () => {
    // Official `!h.mcpInfo` guard — mcp-sourced Bash-like tools key on the
    // whole input.
    expect(
      denialInputKey(
        { name: 'Bash', mcpInfo: { serverName: 'x' } },
        { command: 'ls', extra: 1 },
      ),
    ).toBe('{"command":"ls","extra":1}')
  })

  test('non-shell tools key on the full input JSON', () => {
    expect(
      denialInputKey({ name: 'Read' }, { file_path: '/tmp/x', offset: 2 }),
    ).toBe('{"file_path":"/tmp/x","offset":2}')
  })

  test('shell-family tool with missing command yields {} (JSON.stringify drops undefined)', () => {
    expect(denialInputKey({ name: 'Bash' }, {})).toBe('{}')
  })
})

describe('CC 2.1.307 B6: store invariants unchanged', () => {
  test('caps the store at 20 denials, newest first', () => {
    // Arrange / Act
    for (let i = 0; i < 25; i++) {
      recordAutoModeDenial(makeDenial({ display: `cmd-${i}` }))
    }

    // Assert
    const denials = getAutoModeDenials()
    expect(denials.length).toBe(20)
    expect(denials[0]?.display).toBe('cmd-24')
    expect(denials[19]?.display).toBe('cmd-5')
  })
})
