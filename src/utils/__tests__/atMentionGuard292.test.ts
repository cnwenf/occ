import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { generateFileAttachment } from '../attachments.js'
import { getPlanFilePath } from '../plans.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.292 (C3 carryover, docs/gap-research-293/cluster-c-h-carryover.md):
 * the too_large `at_mention_reference` consumer guard trio (@215048836),
 * verbatim from the official binary:
 *
 *   if(!nn&&!Nt&&ln!==void 0&&AI(ln.path).ext!==""&&!aHe(ln.path)&&!v$(ln.path))
 *     return p("input_file_at_mention","too_large"),
 *       {type:"at_mention_reference",mentions:[ln.path],unread:"too_large",
 *        fileSize:ln.fileSize,displayPath:Yk(oe(),ln.path)};
 *
 * OCC mapping: `AI(...).ext !== ""` → extensionless files never get the
 * too_large reference; `aHe` (image-extension check) → IMAGE_EXTENSION_REGEX;
 * `v$` (plan-file predicate) → equality with getPlanFilePath(); `Yk(oe(),p)`
 * → relative(getCwd(), p) as the new `displayPath` field.
 */

function makePermissionContext(): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function makeToolUseContext(): ToolUseContext {
  return {
    options: { mcpClients: [], tools: [], mainLoopModel: 'claude-opus-5' },
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set(),
    nestedMemoryAttachmentTriggers: new Set(),
    getAppState: () => ({ toolPermissionContext: makePermissionContext() }),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'occ-atmention-guard292-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// Default maxSizeBytes is MAX_OUTPUT_SIZE = 0.25 MB — 300 KB exceeds it.
const OVERSIZE = 300 * 1024

async function attach(name: string) {
  return generateFileAttachment(
    join(tmpDir, name),
    makeToolUseContext(),
    'tengu_test_success',
    'tengu_test_error',
    'at-mention',
  )
}

function isTooLargeReference(result: Awaited<ReturnType<typeof attach>>): boolean {
  return (
    result?.type === 'at_mention_reference' && result.unread === 'too_large'
  )
}

describe('CC 2.1.292 C3 — too_large reference carries displayPath', () => {
  test('oversized .log @-mention: fileSize + displayPath on the reference', async () => {
    writeFileSync(join(tmpDir, 'big.log'), 'x'.repeat(OVERSIZE))
    const result = await attach('big.log')
    expect(result?.type).toBe('at_mention_reference')
    if (result?.type !== 'at_mention_reference') {
      throw new Error(`unexpected attachment type: ${result?.type}`)
    }
    expect(result.unread).toBe('too_large')
    expect(result.fileSize).toBe(OVERSIZE)
    expect(typeof result.displayPath).toBe('string')
    expect(result.displayPath?.endsWith('big.log')).toBe(true)
  })
})

describe('CC 2.1.292 C3 — guard trio @215048836 (ext!=="" && !image && !plan)', () => {
  test('extensionless oversized file → no too_large reference', async () => {
    writeFileSync(join(tmpDir, 'extensionless-big'), 'x'.repeat(OVERSIZE))
    const result = await attach('extensionless-big')
    expect(isTooLargeReference(result)).toBe(false)
  })

  test('oversized image (.png) → no too_large reference (aHe arm)', async () => {
    // Minimal-valid-looking PNG header + oversize padding.
    const pngHead = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])
    writeFileSync(
      join(tmpDir, 'big-image.png'),
      Buffer.concat([pngHead, Buffer.alloc(OVERSIZE, 0x41)]),
    )
    const result = await attach('big-image.png')
    expect(isTooLargeReference(result)).toBe(false)
  })

  test('oversized plan file → no too_large reference (v$ arm)', async () => {
    const planPath = getPlanFilePath()
    mkdirSync(dirname(planPath), { recursive: true })
    writeFileSync(planPath, 'x'.repeat(OVERSIZE))
    try {
      const result = await generateFileAttachment(
        planPath,
        makeToolUseContext(),
        'tengu_test_success',
        'tengu_test_error',
        'at-mention',
      )
      expect(isTooLargeReference(result)).toBe(false)
    } finally {
      rmSync(planPath, { force: true })
    }
  })

  test('guard does not over-fire: within-limit plain file still attaches as file', async () => {
    writeFileSync(join(tmpDir, 'small.txt'), 'hello world')
    const result = await attach('small.txt')
    expect(result?.type).toBe('file')
  })
})
