import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileWriteTool } from '../FileWriteTool.js'

// CC 2.1.291 (G#9): a file name containing a line break must render escaped
// (`&#10;`) in tool-error messages, never as a real newline. The official 291
// FileWriteTool directory / non-regular-file messages wrap the raw input path
// in the escaper — byte-verified: `${ad(g)} is a directory, not a file...` and
// `${ad(g)} exists but is not a regular file (a device, FIFO or socket)...`.
// OCC maps `ad` -> escapeControlCharsAsEntities (src/utils/displayEscape.ts).
//
// This is the deterministic end-to-end wiring proof: :451 interpolates the RAW
// file_path, so a real directory whose name contains "\n" must surface as
// `&#10;` in the returned message (anti-spoofing: the message stays one line).

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

const NL = String.fromCharCode(10) // real newline in the directory name
let workDir = ''
let evilDir = ''

describe('FileWriteTool path escaping (CC 2.1.291 G#9)', () => {
  test('directory-with-newline name is escaped to &#10; in the is-a-directory message', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'occ-g9-'))
    evilDir = join(workDir, `evil${NL}approved`)
    await mkdir(evilDir)

    const result = await FileWriteTool.validateInput(
      { file_path: evilDir, content: 'x' } as never,
      contextWithNoRules(),
    )

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(17)
    // The escaped entity is present...
    expect(result.message).toContain('&#10;')
    // ...and NO raw newline survives (the message stays a single line).
    expect(result.message).not.toContain(NL)
    expect(result.message).toContain('is a directory, not a file')

    await rm(workDir, { recursive: true, force: true })
  })

  test('ordinary directory path is unchanged by the escaper (identity, errorCode 17)', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'occ-g9-plain-'))
    const plainDir = join(workDir, 'plaindir')
    await mkdir(plainDir)

    const result = await FileWriteTool.validateInput(
      { file_path: plainDir, content: 'x' } as never,
      contextWithNoRules(),
    )

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(17)
    // Identity for a normal path: the exact raw path is interpolated verbatim.
    expect(result.message).toBe(
      `${plainDir} is a directory, not a file. To create a file inside it, include the file name in file_path.`,
    )

    await rm(workDir, { recursive: true, force: true })
  })
})

afterAll(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true })
  }
  if (evilDir) {
    // best-effort (already removed above); ignore errors
    await rm(evilDir, { recursive: true, force: true }).catch(() => {})
  }
})
