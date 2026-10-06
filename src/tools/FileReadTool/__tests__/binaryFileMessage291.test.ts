import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../FileReadTool.js'

// CC 2.1.291 (G#5): the binary-file rejection message points the model at a
// skill / shell command instead of the vague 289 "appropriate tools" tail.
// Byte-verified against the official 291 ELF:
//   `This tool cannot read binary files. The file appears to be a binary ${Y}
//    file. Use a skill for this file type if one is available, or a shell
//    command or script that can read the format.`,errorCode:4
// The 289 tail was "Please use appropriate tools for binary file analysis."
// Only the tail sentence changed — errorCode (4), the first sentence, and the
// ${ext} interpolation are unchanged.

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

describe('FileReadTool binary-file message (CC 2.1.291 G#5)', () => {
  test('rejects a binary file with the official 291 skill/shell wording', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: 'font.woff2' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(4)
    expect(result.message).toBe(
      'This tool cannot read binary files. The file appears to be a binary .woff2 file. Use a skill for this file type if one is available, or a shell command or script that can read the format.',
    )
  })

  test('interpolates the lowercased extension verbatim (.ZIP -> .zip)', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: '/tmp/Archive.ZIP' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(false)
    expect(result.message).toBe(
      'This tool cannot read binary files. The file appears to be a binary .zip file. Use a skill for this file type if one is available, or a shell command or script that can read the format.',
    )
  })

  test('no longer uses the 289 "appropriate tools for binary file analysis" tail', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: 'app.exe' } as never,
      contextWithNoRules(),
    )
    expect(result.message).not.toContain(
      'Please use appropriate tools for binary file analysis.',
    )
    expect(result.message).toContain('Use a skill for this file type')
  })
})
