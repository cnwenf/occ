import { describe, expect, test } from 'bun:test'
import { isAbsolute } from 'path'
import { validateScriptPath, WorkflowScriptError } from '../scriptLoader.js'

// CC 2.1.234 workflow scriptPath gate (binary sYt, byte-verified): UNC,
// NT-namespace, and automount paths are rejected with the official message.

const OFFICIAL_MESSAGE_PREFIX =
  'Network (UNC, NT-namespace, or automount) paths are not allowed for workflow scriptPath: '

function expectRejected(scriptPath: string): string {
  try {
    validateScriptPath(scriptPath)
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowScriptError)
    return (error as Error).message
  }
  throw new Error(`expected ${scriptPath} to be rejected`)
}

describe('validateScriptPath network-path gate (CC 2.1.234)', () => {
  test('rejects UNC paths with the official message', () => {
    for (const p of ['\\\\server\\share\\wf.js', '//server/share/wf.js']) {
      expect(expectRejected(p)).toBe(`${OFFICIAL_MESSAGE_PREFIX}${p}`)
    }
  })

  test('rejects NT-namespace device paths with the official message', () => {
    const p = '\\??\\C:\\wf.js'
    expect(expectRejected(p)).toBe(`${OFFICIAL_MESSAGE_PREFIX}${p}`)
  })

  test('rejects NT-namespace forms surfaced by win32 normalization', () => {
    const p = '/a/../\\??\\wf.js'
    expect(expectRejected(p)).toBe(`${OFFICIAL_MESSAGE_PREFIX}${p}`)
  })

  test('rejects automount paths with the official message', () => {
    const p = '/net/share/wf.js'
    expect(expectRejected(p)).toBe(`${OFFICIAL_MESSAGE_PREFIX}${p}`)
    expect(expectRejected('/net/Share/deep/wf.js')).toBe(
      `${OFFICIAL_MESSAGE_PREFIX}/net/Share/deep/wf.js`,
    )
  })

  test('does not treat a bare /net as automount', () => {
    expect(() => validateScriptPath('/net')).not.toThrow()
  })

  test('accepts ordinary paths and returns the resolved absolute path', () => {
    const resolved = validateScriptPath('./workflows/my-flow.js')
    expect(isAbsolute(resolved)).toBe(true)
    expect(resolved.endsWith('workflows/my-flow.js')).toBe(true)
    expect(isAbsolute(validateScriptPath('/tmp/wf.js'))).toBe(true)
  })

  test('still rejects empty input', () => {
    expect(() => validateScriptPath('')).toThrow(WorkflowScriptError)
  })
})
