import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../FileReadTool.js'

// CC 2.1.234 read_file NT-namespace gate (byte-verified message): NT device /
// object-manager namespace paths are rejected before any filesystem access.

function contextWithNoRules() {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        alwaysDenyRules: {},
        alwaysAllowRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map(),
      },
    }),
  } as never
}

describe('FileReadTool NT-namespace rejection (CC 2.1.234)', () => {
  test('rejects an NT object-manager namespace path before filesystem access', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: '/Device/Harddisk0/Partition1' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(false)
    expect(result.message).toBe(
      'read_file: NT-namespace path rejected before filesystem access',
    )
  })

  test('rejects a GLOBALROOT namespace path', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: '/GLOBALROOT/x' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(false)
    expect(result.message).toBe(
      'read_file: NT-namespace path rejected before filesystem access',
    )
  })

  test('POSIX runtime: //server/share collapses to a local path in expandPath — no UNC surface here', async () => {
    // CC 2.1.292 replaced the old UNC "defer to the permission flow"
    // ({result:true}) with a pre-I/O hard reject. On a POSIX runtime
    // '//server/share/file.txt' normalizes to '/server/share/file.txt' (a
    // local filename — POSIX has no SMB UNC surface), so validateInput passes
    // it; the raw '//host' form is still gated by checkReadPermissionForTool
    // (see filesystem.unc.test.ts). On a Windows runtime the same input IS
    // rejected by the 292 gate (see uncGate292.test.ts).
    const result = await FileReadTool.validateInput(
      { file_path: '//server/share/file.txt' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(true)
  })
})
