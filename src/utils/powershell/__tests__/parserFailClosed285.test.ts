/**
 * CC 2.1.285: "Fixed the PowerShell tool's permission check skipping deny and
 * ask rules, and caching that failure for later checks, when its command parser
 * failed to start (for example when the machine was out of memory)."
 *
 * Byte evidence (linux-x64 official ELFs, JS region >150M):
 * - v284 @205674000 region vs v285 @203455500 region (12000B extracts):
 *   - NEW encode guard (v285 only, @203460116):
 *     `try{s=IQ(pMn(e))}catch(ye){return t(\`PowerShell parser: could not
 *     encode the parse script: ${l(ye)}\`,{level:"error"}),Ew(e,"PowerShell
 *     parser could not be started","EncodeError")}`
 *   - transient set EXTENDED (v285 `SMn`): +"EncodeError","UnexpectedError"
 *   - NEW wrapper `.catch` (v285 only; "PowerShell parser failed
 *     unexpectedly" v284=0 hits / v285=2 hits):
 *     `_Mn(e).catch((s)=>{try{u(s)}catch{}return Ew(e,"PowerShell parser
 *     failed unexpectedly","UnexpectedError")})`
 *   - eviction now identity-guarded on fulfill AND reject:
 *     `r=()=>{if(this.cached.cache.get(e)===n)this.cached.cache.delete(e)}`
 *
 * OCC already evaluates deny/ask rules BEFORE the parse-validity check
 * (powershellPermissions.ts "SECURITY: Check deny/ask rules BEFORE parse
 * validity check"), so the parser-side conversion + no-cache semantics
 * complete the fail-closed loop.
 *
 * Note: the EncodeError branch itself is structurally covered (verbatim port);
 * toUtf16LeBase64 is module-private and Buffer/base64 encoding cannot be made
 * to throw from a test without reaching into internals, so the behavioral
 * tests here drive the equivalent UnexpectedError conversion path (a parser
 * that fails to start) plus eviction and the permission-side fail-closed.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

// Simulate "parser could not be started" by making the pwsh detection path
// throw (the first await inside parsePowerShellCommandImpl).
let detectionMode: 'reject' | 'unavailable' = 'reject'
let detectionCalls = 0
mock.module('../../shell/powershellDetection.js', () => ({
  getCachedPowerShellPath: async (): Promise<string | null> => {
    detectionCalls += 1
    if (detectionMode === 'reject') {
      throw new Error('simulated out-of-memory during parser startup')
    }
    return null
  },
}))

const { parsePowerShellCommand } = await import('../parser.js')
const { powershellToolHasPermission } = await import(
  '../../../tools/PowerShellTool/powershellPermissions.js'
)
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
import type { ToolUseContext } from '../../../Tool.js'

afterAll(() => {
  mock.restore()
})

describe('CC 2.1.285 PowerShell parser fail-closed', () => {
  test('parser-start failure converts to an invalid UnexpectedError result (never rejects)', async () => {
    // Arrange
    detectionMode = 'reject'

    // Act — pre-2.1.285 this rejected, skipping the permission rules.
    const result = await parsePowerShellCommand('Get-Process')

    // Assert
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.errorId).toBe('UnexpectedError')
    expect(result.errors[0]?.message).toBe(
      'PowerShell parser failed unexpectedly',
    )
  })

  test('the failure is not cached — the next call re-runs the parser', async () => {
    // Arrange — the previous UnexpectedError result must have been evicted
    // (TRANSIENT_ERROR_IDS now contains it), so this call re-executes.
    detectionMode = 'unavailable'

    // Act
    const result = await parsePowerShellCommand('Get-Process')

    // Assert — a cached stale failure would still read UnexpectedError; the
    // re-run produces the deterministic NoPowerShell path instead.
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.errorId).toBe('NoPowerShell')
    expect(detectionCalls).toBeGreaterThanOrEqual(2)
  })

  test('deny rules still apply when the parser failed to start (fail-closed)', async () => {
    // Arrange
    detectionMode = 'reject'
    const toolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: { userSettings: ['PowerShell(Remove-Item*)'] },
    }
    const context = {
      getAppState: () => ({ toolPermissionContext }),
    } as unknown as ToolUseContext

    // Act
    const decision = await powershellToolHasPermission(
      { command: 'Remove-Item C:\\important -Recurse' },
      context,
    )

    // Assert — the deny rule fires even though parsing failed; pre-2.1.285
    // the thrown parse error skipped rule evaluation entirely.
    expect(decision.behavior).toBe('deny')
  })
})
