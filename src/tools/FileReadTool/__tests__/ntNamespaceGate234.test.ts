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

  test('still defers UNC paths to the permission flow (unchanged behavior)', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: '//server/share/file.txt' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(true)
  })
})
